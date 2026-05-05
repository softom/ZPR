import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { eventAbsPath } from '@/lib/event-storage'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

const MAX_TEXT_LEN = 60000  // ~60k символов в промпт

// POST /api/events/[id]/attachments/[aid]/refer
// Body: { append_to_note?: boolean }
// Делает LLM-выжимку файла, сохраняет в event_attachments.summary,
// опционально дописывает в events.note.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; aid: string }> }
) {
  if (!POLZA_API_KEY) {
    return NextResponse.json({ error: 'POLZA_API_KEY не задан' }, { status: 500 })
  }
  const { id, aid } = await ctx.params
  const body = await request.json().catch(() => ({}))
  const appendToNote = body?.append_to_note === true

  // Достаём вложение
  const { data: att, error: attErr } = await supabaseAdmin
    .from('event_attachments')
    .select('id, file_name, file_path, mime_type, kind')
    .eq('id', aid)
    .maybeSingle()
  if (attErr || !att) return NextResponse.json({ error: attErr?.message || 'Файл не найден' }, { status: 404 })

  // Извлекаем текст
  let text: string
  try {
    text = await extractText(att.file_path, att.file_name, att.mime_type)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Не удалось прочитать файл: ${msg}` }, { status: 400 })
  }
  if (!text || text.trim().length < 20) {
    return NextResponse.json({ error: 'Файл пуст или нечитаем (текстового содержимого мало)' }, { status: 400 })
  }
  if (text.length > MAX_TEXT_LEN) {
    text = text.slice(0, MAX_TEXT_LEN) + '\n[...текст обрезан...]'
  }

  // Контекст: имена объектов + подрядчик
  const { data: ev } = await supabaseAdmin
    .from('events')
    .select('id, title, note, object_ids, fact_date, date_end')
    .eq('id', id)
    .maybeSingle()
  if (!ev) return NextResponse.json({ error: 'Событие не найдено' }, { status: 404 })

  let objectNames: { code: string; current_name: string }[] = []
  if (ev.object_ids && ev.object_ids.length > 0) {
    const { data } = await supabaseAdmin
      .from('objects')
      .select('code, current_name')
      .in('id', ev.object_ids)
    objectNames = (data as { code: string; current_name: string }[]) || []
  }

  const { data: links } = await supabaseAdmin
    .from('entity_links')
    .select('to_id, to_type, link_type')
    .eq('from_type', 'event').eq('from_id', id)
  let leName: string | null = null
  const leLink = (links || []).find((l) => l.to_type === 'legal_entity' && l.link_type === 'assigned_to')
  if (leLink) {
    const { data } = await supabaseAdmin.from('legal_entities').select('name').eq('id', leLink.to_id).maybeSingle()
    leName = data?.name ?? null
  }

  const summary = await callLLM(buildPrompt({
    fileName: att.file_name,
    text,
    objects: objectNames,
    legalEntity: leName,
    eventTitle: ev.title || '',
  }))

  // Сохраняем
  const { error: updErr } = await supabaseAdmin
    .from('event_attachments')
    .update({ summary, summary_at: new Date().toISOString() })
    .eq('id', aid)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  let newNote: string | null = null
  if (appendToNote) {
    const sep = ev.note && ev.note.trim().length > 0 ? '\n\n' : ''
    newNote = `${ev.note || ''}${sep}— ${att.file_name}: ${summary}`
    await supabaseAdmin.from('events').update({ note: newNote }).eq('id', id)
  }

  return NextResponse.json({ summary, appended_to_note: appendToNote, note: newNote })
}

// ─── Извлечение текста ───────────────────────────────────────────────────
async function extractText(relPath: string, fileName: string, mime: string | null): Promise<string> {
  const abs = eventAbsPath(relPath)
  const ext = (fileName.split('.').pop() || '').toLowerCase()

  if (ext === 'txt' || ext === 'md' || mime?.startsWith('text/')) {
    return await fs.readFile(abs, 'utf-8')
  }

  if (ext === 'pdf' || mime === 'application/pdf') {
    // pdf-parse
    const buf = await fs.readFile(abs)
    type PdfParse = (b: Buffer) => Promise<{ text: string }>
    type PdfParseModule = PdfParse | { default: PdfParse }
    const mod = (await import('pdf-parse')) as unknown as PdfParseModule
    const fn: PdfParse = typeof mod === 'function' ? mod : (mod.default as PdfParse)
    const result = await fn(buf)
    return result.text || ''
  }

  if (ext === 'docx' || mime?.includes('officedocument.wordprocessingml')) {
    // mammoth
    const mod = await import('mammoth')
    const buf = await fs.readFile(abs)
    const result = await mod.extractRawText({ buffer: buf })
    return result.value || ''
  }

  throw new Error(`Тип файла не поддерживается: .${ext} (mime: ${mime || 'неизвестен'})`)
}

// ─── Промпт ──────────────────────────────────────────────────────────────
function buildPrompt(opts: {
  fileName: string
  text: string
  objects: { code: string; current_name: string }[]
  legalEntity: string | null
  eventTitle: string
}): string {
  const { fileName, text, objects, legalEntity, eventTitle } = opts
  const objCtx = objects.length > 0
    ? objects.map((o) => `${o.code} — ${o.current_name}`).join('; ')
    : 'не указаны'
  const leCtx = legalEntity ?? 'не указано'
  return `Ты — помощник руководителя строительного проекта «Золотые пески России». Сделай краткую выжимку (реферат) из приложенного файла для журнала проекта.

═══ КОНТЕКСТ ═══

Событие:    ${eventTitle || '(без названия)'}
Объекты:    ${objCtx}
Подрядчик:  ${leCtx}
Файл:       ${fileName}

═══ ТЕКСТ ФАЙЛА ═══

${text}

═══ ЗАДАЧА ═══

Сделай выжимку:
- 1–3 предложения, без markdown, без списков
- Деловой нейтральный тон
- Подставь имена объектов и подрядчика, если в тексте они упоминаются абстрактно («объект», «отель»)
- Сохрани все факты, даты, суммы, номера документов
- Не добавляй информации, которой нет в файле

Верни ТОЛЬКО текст выжимки — без префиксов, без кавычек.`
}

async function callLLM(prompt: string): Promise<string> {
  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err}`)
  }
  const data = await response.json()
  return (data.choices?.[0]?.message?.content ?? '').trim()
}
