/**
 * POST /api/protocols/[id]/upload-transcription
 *
 * Загружает файл транскрипции собрания в локальное хранилище:
 *   STORAGE_DIR\ПРОТОКОЛЫ\<YYYY_MM_DD>_<sanitized_title>\<filename>
 *
 * Регламент именования папки — см. WIKI 02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ → ПРОТОКОЛЫ.
 *
 * Поведение:
 * - Если у meeting нет folder_path — генерирует его и сохраняет (один раз)
 * - Если уже есть — переиспользует ту же папку (чтобы при замене транскрипции
 *   не появлялись дубли папок)
 * - Сохраняет имя файла в meetings.transcription_path (относительный путь от STORAGE_DIR)
 * - Переводит meetings.status в 'transcript_uploaded'
 *
 * Принимаемые форматы: .docx, .csv, .txt
 */

import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

const ALLOWED_EXT = new Set(['.docx', '.csv', '.txt'])

/** Удаляет спецсимволы Windows из имени, заменяет пробелы на _. */
function sanitizeForFs(input: string): string {
  return input
    .replace(/[*?:"<>|\\/«»—–]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) // кап на длину для Windows MAX_PATH
}

/** ПРОТОКОЛЫ\YYYY_MM_DD_Sanitized_Title — относительный путь от STORAGE_DIR. */
function buildFolderPath(meetingDate: string, title: string): string {
  const dateUnderscored = meetingDate.replace(/-/g, '_')   // 2026_05_04
  const sanitized = sanitizeForFs(title) || 'Без_названия'
  return path.join('ПРОТОКОЛЫ', `${dateUnderscored}_${sanitized}`)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  console.log(`[protocols/upload] meeting=${id} STORAGE_DIR=${STORAGE_DIR}`)

  // 1) Получить метаданные собрания
  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings')
    .select('id, meeting_date, title, folder_path, transcription_path, status')
    .eq('id', id)
    .single()

  if (mErr || !meeting) {
    console.error(`[protocols/upload] meeting not found: ${mErr?.message}`)
    return NextResponse.json({ error: 'Собрание не найдено' }, { status: 404 })
  }

  // 2) Определить folder_path (генерируем один раз)
  const folderRel: string =
    meeting.folder_path ??
    buildFolderPath(meeting.meeting_date as string, meeting.title as string)

  const targetDir = path.join(STORAGE_DIR, folderRel.replace(/[\\/]/g, path.sep))

  try {
    await mkdir(targetDir, { recursive: true })
  } catch (e) {
    return NextResponse.json({ error: `mkdir: ${e}` }, { status: 500 })
  }

  // 3) Принять файл из FormData
  const formData = await request.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'Файл не передан (поле "file")' }, { status: 400 })
  }

  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: `Неподдерживаемый формат: ${ext}. Допустимы: ${[...ALLOWED_EXT].join(', ')}` },
      { status: 400 },
    )
  }

  // 4) Записать файл (имя сохраняем оригинальное)
  const safeName = sanitizeForFs(path.basename(file.name, ext)) + ext
  const dest = path.join(targetDir, safeName)
  try {
    const bytes = await file.arrayBuffer()
    await writeFile(dest, Buffer.from(bytes))
    console.log(`[protocols/upload] saved: ${dest}`)
  } catch (e) {
    return NextResponse.json({ error: `writeFile: ${e}` }, { status: 500 })
  }

  // 5) Обновить запись meeting (folder_path фиксируется один раз; transcription_path и status)
  const transcriptionRel = path.join(folderRel, safeName).replace(/\\/g, '/')
  const update: Record<string, unknown> = {
    transcription_path: transcriptionRel,
    status: 'transcript_uploaded',
  }
  if (!meeting.folder_path) {
    update.folder_path = folderRel.replace(/\\/g, '/')
  }

  const { error: uErr } = await supabaseAdmin
    .from('meetings')
    .update(update)
    .eq('id', id)

  if (uErr) {
    return NextResponse.json(
      { error: `Файл загружен, но не удалось обновить БД: ${uErr.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    folder_path: update.folder_path ?? meeting.folder_path,
    transcription_path: transcriptionRel,
    saved_name: safeName,
    size: file.size,
    target_dir: targetDir,
  })
}
