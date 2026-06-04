/**
 * POST /api/protocols/[id]/publish
 *
 * Публикация утверждённого протокола в Telegram-чаты, привязанные к
 * объектам собрания (`tg_chats.object_id IN meeting.object_ids`).
 *
 * Pipeline:
 *   1. Проверка meeting.status in (approved, protocoled)
 *   2. Поиск tg_chats для всех meeting.object_ids
 *   3. Исключение чатов, в которые уже публиковали (meeting_publications)
 *   4. Рендер .docx через generateProtocolDocx, сохранение во временный файл
 *   5. Подготовка caption: «📋 Проект протокола по итогам "{title}" от DD.MM.YYYY»
 *   6. Запуск scripts/send_telegram_protocol.py (отдельная Telethon-сессия)
 *   7. Запись результата в meeting_publications + UPDATE meetings.published_at
 *      (последнее — через триггер meeting_publications_sync_meeting_trg)
 *
 * Body (опционально): { dry_run?: boolean } — если true, возвращает список
 * чатов и текст преамбулы БЕЗ отправки. Используется UI-модалом «Предпросмотр».
 *
 * Returns:
 *   { dry_run: boolean,
 *     caption: string,
 *     chats: [{ chat_id, title, object_codes, already_published? }],
 *     results?: [{ chat_id, status: 'ok'|'fail', message_id?, error? }] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import { writeFile, unlink, mkdtemp } from 'fs/promises'
import os from 'os'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateProtocolDocx } from '@/lib/protocol/generateDocx'

export const maxDuration = 60

// Корень репо для нахождения scripts/send_telegram_protocol.py
const PROJECT_ROOT = path.resolve(process.cwd(), '..')

// Python для запуска send-скрипта. ВАЖНО: telegram_listener.py крутится
// в conda-окружении `zpr` (см. scripts/run_tg_listener.ps1), там же
// установлены telethon и supabase. Системный `python` их не видит.
// Можно переопределить через env PYTHON_EXE (.env.local) — иначе берём
// дефолтный путь conda-окружения zpr.
const PYTHON_EXE = process.env.PYTHON_EXE
  ?? 'C:\\Users\\tigra\\.conda\\envs\\zpr\\python.exe'

interface PublishBody {
  dry_run?: boolean
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const body = await request.json().catch(() => ({} as PublishBody))
  const dryRun = body?.dry_run === true

  // 1. Проверка собрания
  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings')
    .select('id, code, title, meeting_date, object_ids, status, published_at')
    .eq('id', id)
    .single()
  if (mErr || !meeting) {
    return NextResponse.json({ error: `Собрание не найдено: ${mErr?.message ?? 'unknown'}` }, { status: 404 })
  }
  if (meeting.status !== 'approved' && meeting.status !== 'protocoled') {
    return NextResponse.json(
      { error: 'Публикация доступна только после утверждения протокола (Секция 8).' },
      { status: 422 },
    )
  }
  const objectIds = (meeting.object_ids ?? []) as string[]
  if (objectIds.length === 0) {
    return NextResponse.json(
      { error: 'У собрания нет привязанных объектов — некуда публиковать.' },
      { status: 422 },
    )
  }
  // Жёсткий блок повторной публикации: один протокол публикуется один раз.
  // Если позже добавили объект / чат — это уже история, а не «дослать».
  // Снять блокировку можно только вручную через БД: UPDATE meetings SET published_at = NULL.
  // Превью (dry_run) разрешаем — чтобы можно было заглянуть в детали.
  if (meeting.published_at && !dryRun) {
    return NextResponse.json(
      {
        error: 'Протокол уже опубликован. Повторная публикация запрещена — ' +
               'это защита от повторных рассылок одного и того же документа в чаты участников. ' +
               `Дата первой публикации: ${new Date(meeting.published_at as string).toLocaleDateString('ru-RU')}.`,
      },
      { status: 409 },
    )
  }

  // 2. Чаты, привязанные к объектам собрания
  const { data: chatsRaw, error: cErr } = await supabaseAdmin
    .from('tg_chats')
    .select('chat_id, title, object_id, is_whitelisted')
    .in('object_id', objectIds)
    .eq('is_whitelisted', true)
  if (cErr) {
    return NextResponse.json({ error: `Ошибка чтения чатов: ${cErr.message}` }, { status: 500 })
  }
  if (!chatsRaw || chatsRaw.length === 0) {
    return NextResponse.json(
      { error: 'Ни к одному из объектов собрания не привязан Telegram-чат. Привяжите в карточке объекта.' },
      { status: 422 },
    )
  }

  // Кодов объектов для отображения какому объекту принадлежит чат
  const { data: objs } = await supabaseAdmin
    .from('objects').select('id, code, current_name').in('id', objectIds)
  const objById = new Map((objs ?? []).map((o) => [o.id as string, o]))

  // 3. Какие чаты уже опубликованы (для UI-метки)
  const { data: publishedRows } = await supabaseAdmin
    .from('meeting_publications')
    .select('chat_id, status')
    .eq('meeting_id', id)
  const publishedOk = new Set(
    (publishedRows ?? []).filter((r) => r.status === 'ok').map((r) => r.chat_id as number),
  )

  // Дедупликация: у одного объекта может быть несколько чатов, и наоборот;
  // также один chat_id может встретиться дважды если object_id в нескольких объектах.
  type ChatRow = { chat_id: number; title: string | null; object_id: string | null }
  const uniqueChats = new Map<number, ChatRow>()
  for (const c of (chatsRaw as ChatRow[])) {
    if (!uniqueChats.has(c.chat_id)) uniqueChats.set(c.chat_id, c)
  }

  const chatsOut = [...uniqueChats.values()].map((c) => {
    const o = c.object_id ? objById.get(c.object_id) : null
    return {
      chat_id: c.chat_id,
      title: c.title ?? `chat ${c.chat_id}`,
      object_code: o?.code ?? null,
      object_name: o?.current_name ?? null,
      already_published: publishedOk.has(c.chat_id),
    }
  })

  // 4. Caption
  const meetingDate = (meeting.meeting_date as string).split('-').reverse().join('.')
  const caption =
    `📋 Проект протокола по итогам «${meeting.title}»\n` +
    `Дата: ${meetingDate}\n` +
    `Код: ${meeting.code ?? '—'}\n\n` +
    `Просим направить замечания в течение 3 рабочих дней. Без замечаний — считается утверждённым.`

  if (dryRun) {
    return NextResponse.json({ dry_run: true, caption, chats: chatsOut })
  }

  // 5. Только новые (не публикованные) чаты — защита от двойной публикации
  const targetChats = chatsOut.filter((c) => !c.already_published)
  if (targetChats.length === 0) {
    return NextResponse.json(
      { error: 'Во все привязанные чаты протокол уже опубликован.' },
      { status: 409 },
    )
  }

  // 6. Генерируем .docx во временный файл
  let docxBuf: Buffer
  try {
    docxBuf = await generateProtocolDocx(id)
  } catch (e) {
    return NextResponse.json(
      { error: `Ошибка генерации .docx: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'protocol-publish-'))
  const filename = `${meeting.code ?? `ПРОТ-${meeting.meeting_date}`}.docx`
  const docxPath = path.join(tmpDir, filename)
  await writeFile(docxPath, docxBuf)

  // 7. Вызов Python-скрипта
  type SendResult = { chat_id: number; status: 'ok' | 'fail'; message_id?: number; error?: string }
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'send_telegram_protocol.py')
  const pyResult = await new Promise<{ ok: boolean; data: { results?: SendResult[]; error?: string } }>((resolve) => {
    const child = spawn(PYTHON_EXE, [
      scriptPath,
      '--chat-ids', targetChats.map((c) => c.chat_id).join(','),
      '--file', docxPath,
      '--caption', caption,
    ], { cwd: PROJECT_ROOT })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf-8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf-8') })
    child.on('close', (code) => {
      // Скрипт пишет результат в stdout, ошибки скрипта — в stderr (JSON).
      if (code === 0 && stdout.trim()) {
        try {
          resolve({ ok: true, data: JSON.parse(stdout) })
        } catch (e) {
          resolve({ ok: false, data: { error: `Не парсится stdout: ${e}; raw: ${stdout.slice(0, 500)}` } })
        }
      } else {
        // Пробуем взять JSON из stderr (наш собственный формат)
        try {
          resolve({ ok: false, data: JSON.parse(stderr.trim() || '{}') })
        } catch {
          resolve({ ok: false, data: { error: stderr.trim() || `exit ${code}` } })
        }
      }
    })
  })

  // Удаляем tmp-файл (best-effort)
  unlink(docxPath).catch(() => {})

  if (!pyResult.ok || !pyResult.data.results) {
    return NextResponse.json(
      { error: `Ошибка отправки: ${pyResult.data.error ?? 'unknown'}` },
      { status: 500 },
    )
  }

  // 8. Лог в meeting_publications
  const publicationRows = pyResult.data.results.map((r) => ({
    meeting_id: id,
    chat_id: r.chat_id,
    message_id: r.message_id ?? null,
    status: r.status,
    error_text: r.error ?? null,
  }))
  if (publicationRows.length > 0) {
    const { error: logErr } = await supabaseAdmin
      .from('meeting_publications')
      .insert(publicationRows)
    if (logErr) {
      // Не критично для пользователя — отправка уже прошла; в ответе предупредим.
      console.error('[publish] лог в meeting_publications упал:', logErr.message)
    }
  }

  // Финальный ответ — список чатов + результаты по каждому
  const titleByChatId = new Map(chatsOut.map((c) => [c.chat_id, c]))
  const enrichedResults = pyResult.data.results.map((r) => ({
    ...r,
    title: titleByChatId.get(r.chat_id)?.title ?? `chat ${r.chat_id}`,
    object_code: titleByChatId.get(r.chat_id)?.object_code ?? null,
  }))

  return NextResponse.json({
    dry_run: false,
    caption,
    chats: chatsOut,
    results: enrichedResults,
  })
}
