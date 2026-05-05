import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// POST /api/events/[id]/regenerate-note
// Body: { save?: boolean } — если true, перезаписывает events.note в БД.
// Возвращает: { note: string } — переформулированный текст.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!POLZA_API_KEY) {
    return NextResponse.json({ error: 'POLZA_API_KEY не задан' }, { status: 500 })
  }
  const { id } = await ctx.params
  const body = await request.json().catch(() => ({}))
  const save = body?.save === true

  // Достаём событие
  const { data: ev, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, event_type, title, note, date_end, fact_date, is_planned, object_ids')
    .eq('id', id)
    .maybeSingle()
  if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 })
  if (!ev) return NextResponse.json({ error: 'Событие не найдено' }, { status: 404 })

  // Имена связанных объектов (актуальные — JOIN)
  let objectNames: { code: string; current_name: string }[] = []
  if (ev.object_ids && ev.object_ids.length > 0) {
    const { data: objs } = await supabaseAdmin
      .from('objects')
      .select('code, current_name')
      .in('id', ev.object_ids)
    objectNames = (objs as { code: string; current_name: string }[]) || []
  }

  // Связанное юр.лицо (assigned_to)
  const { data: links } = await supabaseAdmin
    .from('entity_links')
    .select('to_id, to_type, link_type')
    .eq('from_type', 'event')
    .eq('from_id', id)
  let legalEntityName: string | null = null
  const leLink = (links || []).find((l) => l.to_type === 'legal_entity' && l.link_type === 'assigned_to')
  if (leLink) {
    const { data: le } = await supabaseAdmin
      .from('legal_entities')
      .select('name')
      .eq('id', leLink.to_id)
      .maybeSingle()
    legalEntityName = le?.name ?? null
  }

  const result = await callLLMJson(buildPrompt({
    title: ev.title || '(без названия)',
    note: ev.note || '',
    date: ev.fact_date || ev.date_end || null,
    objects: objectNames,
    legalEntity: legalEntityName,
  }))

  if (save) {
    const { error: updErr } = await supabaseAdmin
      .from('events')
      .update({ title: result.title, note: result.note })
      .eq('id', id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ title: result.title, note: result.note, saved: save })
}

// ─── Промпт ────────────────────────────────────────────────────────────────
function buildPrompt(opts: {
  title: string
  note: string
  date: string | null
  objects: { code: string; current_name: string }[]
  legalEntity: string | null
}): string {
  const { title, note, date, objects, legalEntity } = opts

  const objCtx = objects.length > 0
    ? objects.map((o) => `${o.code} — ${o.current_name}`).join('; ')
    : 'не указаны'
  const leCtx = legalEntity ?? 'не указано'
  const dateCtx = date ?? 'не указана'

  return `Ты — помощник руководителя строительного проекта «Золотые пески России». Перепиши запись события в журнале проекта — корректно, по-деловому, с учётом контекста.

═══ КОНТЕКСТ СОБЫТИЯ ═══

Дата:        ${dateCtx}
Заголовок:   ${title}
Объекты:     ${objCtx}
Подрядчик:   ${leCtx}

ИСХОДНЫЙ ТЕКСТ ЗАПИСИ:
${note || '(пусто)'}

═══ ЗАДАЧА ═══

Верни JSON:
{
  "title": "...",  // короткий заголовок до 90 символов: суть события одной фразой
  "note":  "..."   // переписанный текст: 1–4 предложения, деловой тон
}

Для note:
- Сохрани все факты из исходного текста
- Подставь официальные имена объектов и подрядчика вместо абстрактных «объект» / «отель»
- Деловой нейтральный тон, без эмоций
- Без markdown, без списков
- Не добавляй информации, которой нет в исходном тексте
- Сохрани все ссылки и wiki-ссылки (![[...]] и [текст](url)) как есть
- ❗ НЕ дублируй дату события (${dateCtx}) в тексте — она уже отображается отдельным полем в карточке. Если в исходном тексте дата стоит в начале как метка («04.05.2026 …», «27 апреля 2026 …») — убери её. Внутренние даты, относящиеся к содержанию (срок поставки, дата документа и т.п.), оставляй как есть.
- Не начинай предложение с даты события

Для title:
- Короткое описательное название (а не первая фраза note)
- Без точки в конце
- Без даты в начале
- Не дублирует note

Верни ТОЛЬКО JSON без markdown-обёртки.`
}

async function callLLMJson(prompt: string): Promise<{ title: string; note: string }> {
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
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  const m = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\{[\s\S]*\})/)
  const jsonStr = m ? (m[1] ?? m[0]) : content
  try {
    const parsed = JSON.parse(jsonStr)
    return {
      title: String(parsed.title ?? '').trim().slice(0, 200),
      note:  String(parsed.note ?? '').trim(),
    }
  } catch {
    throw new Error(`Не удалось разобрать JSON LLM: ${content.slice(0, 200)}`)
  }
}
