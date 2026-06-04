// Проверка внешнего отчёта против БД проекта.
//
// Двухшаговый LLM-конвейер:
//   Шаг 1 — разбить текст документа на разделы и привязать каждый к объекту
//           (objects.code/aliases/current_name).
//   Шаг 2 — для каждого раздела с найденным object_id сверить факты документа
//           с БД (события, задачи, темы) и классифицировать утверждения:
//             ✅ confirmed   — подтверждено
//             ⚠ discrepancy — расхождение с БД
//             ❌ missing     — БД содержит, документ не упоминает
//             ❓ unknown     — невозможно проверить
//
// Используется в /api/reports/external-check.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

export type DocSection = {
  title: string                 // заголовок раздела как в документе
  object_code: string | null    // привязанный код объекта или null если не удалось
  text: string                  // содержимое раздела (текст)
}

export type SectionCheck = {
  confirmed: string[]
  discrepancies: { claim: string; reality: string }[]
  missing: string[]
  unknown: string[]
}

export type ExternalCheckResult = {
  filename: string
  parsed_at: string
  sections: Array<{
    title: string
    object_code: string | null
    object_name?: string
    check?: SectionCheck         // null если object_code не привязан
  }>
  unmatched_count: number        // сколько разделов без объекта
  matched_count: number
}

// ─── шаг 1: разбивка на разделы + привязка к объекту ────────────────────────
export async function splitIntoSections(text: string, objectsList: Array<{ code: string; current_name: string; aliases: string[] }>): Promise<DocSection[]> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')

  const objectsCatalog = objectsList.map((o) => {
    const allNames = [o.code, o.current_name, ...o.aliases].filter(Boolean)
    return `• ${o.code} → "${o.current_name}" (синонимы: ${allNames.slice(1).join(', ') || '—'})`
  }).join('\n')

  const prompt = `Ты — помощник аналитика проекта «Золотые Пески России».
Раздели внешний отчёт на тематические разделы — каждый раздел относится к ОДНОМУ объекту проекта.

${PROJECT_GLOSSARY}

═══ СПРАВОЧНИК ОБЪЕКТОВ ═══

${objectsCatalog}

═══ ИНСТРУКЦИЯ ═══

Прочитай текст ниже и:
1. Найди в нём явные тематические разделы (обычно — по заголовкам с упоминанием объекта).
2. Для каждого раздела определи к какому объекту он относится (по коду / имени / синониму).
3. Если объект из справочника не удаётся найти — верни object_code: null.

Верни JSON в формате:

{
  "sections": [
    {
      "title": "заголовок раздела или короткий smysl первого абзаца",
      "object_code": "102_ГОСТИНИЦА_800" или null,
      "text": "полный текст раздела"
    }
  ]
}

ТРЕБОВАНИЯ:
- Текст раздела — полностью, без сокращений
- Один раздел = один объект; если в документе нет деления по объектам — верни одну общую секцию с object_code: null
- Если в тексте упоминается объект, которого НЕТ в справочнике — object_code: null

═══ ТЕКСТ ДОКУМЕНТА ═══

${text.slice(0, 60000)}

Верни ТОЛЬКО JSON, без markdown-обёртки.`

  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  })
  if (!response.ok) throw new Error(`LLM split ${response.status}: ${await response.text()}`)
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = parseJson(content)
  const sections = Array.isArray(parsed.sections) ? parsed.sections as DocSection[] : []
  return sections.map((s) => ({
    title: String(s.title ?? '').trim() || 'Без заголовка',
    object_code: typeof s.object_code === 'string' && s.object_code.trim() ? s.object_code.trim() : null,
    text: String(s.text ?? '').trim(),
  }))
}

// ─── шаг 2: сверка раздела с контекстом БД объекта ───────────────────────────
export async function checkSection(
  sectionText: string,
  context: {
    object_code: string
    object_name: string
    tasks: Array<{ code: string; title: string; status: string; done_date: string | null; due_date: string | null; assignee_org: string | null }>
    events: Array<{ title: string; event_type: string; date: string | null }>
    topics: Array<{ title: string; content: string; meeting_date: string | null }>
    llm_hint: string | null
  },
): Promise<SectionCheck> {
  const formatTasks = (arr: typeof context.tasks): string => arr.length === 0
    ? '— нет —'
    : arr.map((t, i) => {
        const parts = [`${i + 1}.`, `«${t.title}»`, `[${t.status}]`]
        if (t.assignee_org) parts.push(`(${t.assignee_org})`)
        if (t.due_date) parts.push(`срок ${t.due_date}`)
        if (t.done_date) parts.push(`выполнено ${t.done_date}`)
        return parts.join(' ')
      }).join('\n')

  const formatEvents = (arr: typeof context.events): string => arr.length === 0
    ? '— нет —'
    : arr.map((e, i) => `${i + 1}. «${e.title}» [${e.event_type}]${e.date ? ` ${e.date}` : ''}`).join('\n')

  const formatTopics = (arr: typeof context.topics): string => arr.length === 0
    ? '— нет —'
    : arr.map((t, i) => `${i + 1}. «${t.title}»${t.meeting_date ? ` (${t.meeting_date})` : ''}${t.content ? ` — ${t.content}` : ''}`).join('\n')

  const ownerHint = context.llm_hint?.trim()

  const prompt = `Ты — аналитик-проверяющий проекта «Золотые Пески России».
Сверь раздел внешнего отчёта по объекту «${context.object_code} — ${context.object_name}» с данными из БД.

${PROJECT_GLOSSARY}

═══ ДАННЫЕ БД ПО ОБЪЕКТУ ═══

ЗАДАЧИ (${context.tasks.length}):
${formatTasks(context.tasks)}

СОБЫТИЯ (${context.events.length}):
${formatEvents(context.events)}

ТЕМЫ ОБСУЖДЕНИЙ (${context.topics.length}):
${formatTopics(context.topics)}
${ownerHint ? `\n\nПРИОРИТЕТНЫЙ КОНТЕКСТ ОТ ВЛАДЕЛЬЦА:\n${ownerHint}\n` : ''}
═══ ТЕКСТ РАЗДЕЛА ═══

${sectionText}

═══ ЗАДАЧА ═══

Проанализируй текст раздела относительно данных БД. Каждое содержательное утверждение классифицируй:
- ✅ confirmed — утверждение подтверждается данными БД (есть соответствующая задача/событие/тема)
- ⚠ discrepancies — расхождение: документ говорит одно, БД другое (укажи обе версии)
- ❌ missing — в БД есть значимый факт, но в тексте раздела не упомянут
- ❓ unknown — невозможно проверить (нет соответствующих данных в БД)

Верни JSON:
{
  "confirmed": ["короткое утверждение из документа", ...],
  "discrepancies": [{ "claim": "что в документе", "reality": "что в БД" }, ...],
  "missing": ["что есть в БД но не упомянуто", ...],
  "unknown": ["утверждение, которое не подтвердить", ...]
}

ПРАВИЛА:
- Каждый пункт — короткая фраза, 1-2 предложения
- Не повторяй один и тот же факт в разных категориях
- Если разделов в БД пусто и текст про общие вещи — категория "unknown"
- Не упоминай ID/UUID/коды задач (ПРОТ-…)

Верни ТОЛЬКО JSON, без markdown-обёртки.`

  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  })
  if (!response.ok) throw new Error(`LLM check ${response.status}: ${await response.text()}`)
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = parseJson(content)

  return {
    confirmed: Array.isArray(parsed.confirmed) ? parsed.confirmed.map((x: unknown) => String(x)) : [],
    discrepancies: Array.isArray(parsed.discrepancies)
      ? parsed.discrepancies.map((x: { claim?: unknown; reality?: unknown }) => ({
          claim: String(x.claim ?? ''),
          reality: String(x.reality ?? ''),
        }))
      : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing.map((x: unknown) => String(x)) : [],
    unknown: Array.isArray(parsed.unknown) ? parsed.unknown.map((x: unknown) => String(x)) : [],
  }
}

// ─── общая функция: полный конвейер для документа ───────────────────────────
export async function runExternalCheck(text: string, filename: string): Promise<ExternalCheckResult> {
  // 1. Загружаем все активные объекты + aliases
  const objsRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name, aliases, llm_hint')
    .eq('active', true)
    .order('code')
  const objects = (objsRes.data ?? []) as Array<{
    id: string; code: string; current_name: string; aliases: unknown; llm_hint: string | null
  }>
  const codeToObj = new Map<string, { id: string; code: string; current_name: string; llm_hint: string | null }>()
  for (const o of objects) {
    const aliasArr = Array.isArray(o.aliases) ? (o.aliases as string[]) : []
    const entry = { id: o.id, code: o.code, current_name: o.current_name, llm_hint: o.llm_hint }
    codeToObj.set(o.code, entry)
    for (const a of aliasArr) codeToObj.set(a, entry)
  }

  // 2. Шаг 1 LLM: разбивка на разделы
  const objectsCatalog = objects.map((o) => ({
    code: o.code,
    current_name: o.current_name,
    aliases: Array.isArray(o.aliases) ? (o.aliases as string[]) : [],
  }))
  const sections = await splitIntoSections(text, objectsCatalog)

  // 3. Для каждого раздела с найденным object_code — собираем контекст + LLM-проверка
  const result: ExternalCheckResult = {
    filename,
    parsed_at: new Date().toISOString(),
    sections: [],
    unmatched_count: 0,
    matched_count: 0,
  }

  for (const sec of sections) {
    const obj = sec.object_code ? codeToObj.get(sec.object_code) : null
    if (!obj) {
      result.unmatched_count += 1
      result.sections.push({ title: sec.title, object_code: sec.object_code })
      continue
    }
    result.matched_count += 1

    // Контекст БД по этому объекту (интегральный, без периода)
    const [tasksRes, tosRes, eventsRes, topicsRes] = await Promise.all([
      supabaseAdmin
        .from('tasks')
        .select('id, code, title, status, assignee_org, due_date, done_date, object_ids')
        .contains('object_ids', [obj.id]),
      supabaseAdmin
        .from('task_object_status')
        .select('task_id, status, done_date')
        .eq('object_id', obj.id),
      supabaseAdmin
        .from('events')
        .select('id, title, event_type, date_computed, date_end, fact_date, object_ids')
        .contains('object_ids', [obj.id])
        .order('date_computed', { ascending: false, nullsFirst: false })
        .limit(40),
      supabaseAdmin
        .from('meeting_topics')
        .select('id, title, content, object_ids, meeting_id')
        .contains('object_ids', [obj.id])
        .eq('status', 'approved')
        .limit(40),
    ])

    // Map per-object статусов для tasks
    const tosByTaskId = new Map<string, { status: string; done_date: string | null }>()
    for (const r of (tosRes.data ?? []) as Array<{ task_id: string; status: string; done_date: string | null }>) {
      tosByTaskId.set(r.task_id, { status: r.status, done_date: r.done_date })
    }
    const tasks = ((tasksRes.data ?? []) as Array<{
      id: string; code: string; title: string; status: string; assignee_org: string | null;
      due_date: string | null; done_date: string | null;
    }>).map((t) => {
      const tos = tosByTaskId.get(t.id)
      return {
        code: t.code,
        title: t.title,
        status: tos?.status ?? t.status,
        assignee_org: t.assignee_org,
        due_date: t.due_date,
        done_date: tos?.done_date ?? t.done_date,
      }
    }).slice(0, 60)

    const events = ((eventsRes.data ?? []) as Array<{
      title: string; event_type: string; date_computed: string | null; date_end: string | null; fact_date: string | null
    }>).map((e) => ({
      title: e.title,
      event_type: e.event_type,
      date: e.fact_date ?? e.date_computed ?? e.date_end,
    }))

    // Темы — нужны даты собраний
    const topicsRaw = (topicsRes.data ?? []) as Array<{
      title: string; content: string; meeting_id: string | null
    }>
    const meetingIds = [...new Set(topicsRaw.map((t) => t.meeting_id).filter((x): x is string => Boolean(x)))]
    const meetingDateById = new Map<string, string>()
    if (meetingIds.length > 0) {
      const mRes = await supabaseAdmin
        .from('meetings')
        .select('id, meeting_date')
        .in('id', meetingIds)
      for (const m of (mRes.data ?? []) as Array<{ id: string; meeting_date: string }>) {
        meetingDateById.set(m.id, m.meeting_date)
      }
    }
    const topics = topicsRaw.map((t) => ({
      title: t.title,
      content: t.content,
      meeting_date: t.meeting_id ? (meetingDateById.get(t.meeting_id) ?? null) : null,
    }))

    let check: SectionCheck
    try {
      check = await checkSection(sec.text, {
        object_code: obj.code,
        object_name: obj.current_name,
        tasks,
        events,
        topics,
        llm_hint: obj.llm_hint,
      })
    } catch (e) {
      check = {
        confirmed: [],
        discrepancies: [],
        missing: [],
        unknown: [`LLM-ошибка при проверке: ${(e as Error).message}`],
      }
    }

    result.sections.push({
      title: sec.title,
      object_code: obj.code,
      object_name: obj.current_name,
      check,
    })
  }

  return result
}

// ─── helper: парсинг JSON с robust fallback ────────────────────────────────
function parseJson(raw: string): Record<string, unknown> {
  const tries: string[] = [raw]
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  if (stripped !== raw) tries.push(stripped)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) tries.push(raw.slice(first, last + 1))
  for (const t of tries) {
    try { return JSON.parse(t) as Record<string, unknown> } catch { /* continue */ }
  }
  throw new Error(`Не удалось разобрать JSON LLM: ${raw.slice(0, 200)}`)
}

// ─── helper: форматирование результата как Markdown ─────────────────────────
export function resultToMarkdown(result: ExternalCheckResult): string {
  const lines: string[] = []
  lines.push(`# Проверка внешнего отчёта`, '')
  lines.push(`**Файл:** ${result.filename}`)
  lines.push(`**Дата проверки:** ${new Date(result.parsed_at).toLocaleString('ru-RU')}`)
  lines.push(`**Разделов:** ${result.sections.length} (привязано к объектам: **${result.matched_count}**, не привязано: ${result.unmatched_count})`)
  lines.push('', '---', '')

  if (result.unmatched_count > 0) {
    lines.push(`## ⚠ Разделы без привязки к объекту`, '')
    lines.push(`Не удалось сопоставить разделы с известными объектами. Возможно, нужно добавить alias в карточку объекта.`, '')
    for (const s of result.sections) {
      if (s.check) continue
      lines.push(`- **${s.title}** — упомянутый объект не найден в справочнике (code: \`${s.object_code ?? '—'}\`)`)
    }
    lines.push('', '---', '')
  }

  for (const s of result.sections) {
    if (!s.check) continue
    lines.push(`## ${s.object_code} — ${s.object_name ?? ''}`, '')
    lines.push(`*Раздел: ${s.title}*`, '')

    if (s.check.confirmed.length > 0) {
      lines.push(`### ✅ Подтверждено (${s.check.confirmed.length})`, '')
      for (const c of s.check.confirmed) lines.push(`- ${c}`)
      lines.push('')
    }
    if (s.check.discrepancies.length > 0) {
      lines.push(`### ⚠ Расхождения (${s.check.discrepancies.length})`, '')
      for (const d of s.check.discrepancies) {
        lines.push(`- **В документе:** ${d.claim}`)
        lines.push(`  **По БД:** ${d.reality}`)
      }
      lines.push('')
    }
    if (s.check.missing.length > 0) {
      lines.push(`### ❌ Не упомянуто в документе (${s.check.missing.length})`, '')
      for (const m of s.check.missing) lines.push(`- ${m}`)
      lines.push('')
    }
    if (s.check.unknown.length > 0) {
      lines.push(`### ❓ Невозможно проверить (${s.check.unknown.length})`, '')
      for (const u of s.check.unknown) lines.push(`- ${u}`)
      lines.push('')
    }
    lines.push('---', '')
  }

  return lines.join('\n')
}
