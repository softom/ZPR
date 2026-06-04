import { supabaseAdmin } from '@/lib/supabase-admin'
import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

export type PreambleObjectLine = {
  code: string
  number: string             // «№1»
  type_line: string          // «Апарт-отель 3* Спортивный 460 номеров»
  contractor: string | null  // «ООО «Хенс Групп»» — может быть null
  tep_deadline: string | null // «10.08.2026»
  priority_group: 'priority' | 'secondary' | null
}

// Генерация преамбулы control-отчёта (Справка ТЗ) на основе списка объектов.
// Возвращает Markdown-блок:
//
//   Общая справка технического заказчика
//
//   Туристический комплекс «Золотые пески России» — краткая справка на 14.05.2026.
//
//   В рамках реализации первой очереди объекта к реализации запланированы
//   восемь объектов:
//
//   Объект №1 …
//   …
//
//   Заказчиком определены первоочередные объекты: №3, №4, №6 — сроки ТЭП до 10.06.
//
// Может работать без LLM (детерминированный шаблон). LLM-вариант — опционально
// для красивого «уплотнения» текста, если попросят позже.
export function buildControlPreamble(
  snapshotDate: Date,
  objects: PreambleObjectLine[],
): string {
  const snap = snapshotDate.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })

  const totalCount = objects.length
  const priorities = objects.filter((o) => o.priority_group === 'priority')

  const lines: string[] = [
    `**Туристический комплекс «Золотые пески России» — краткая справка на ${snap}.**`,
    '',
  ]

  if (totalCount > 0) {
    lines.push(`В рамках реализации первой очереди к реализации запланированы ${totalCount} объект(а/ов):`)
    lines.push('')
    for (const o of objects) {
      // Опускаем поля без данных вместо «не задан / не определён» —
      // короче и не засоряет читателю восприятие.
      const parts: string[] = []
      if (o.contractor) parts.push(`исполнитель ${o.contractor}`)
      if (o.tep_deadline) parts.push(`срок ТЭП ${o.tep_deadline}`)
      const tail = parts.length > 0 ? ` — ${parts.join(', ')}` : ''
      lines.push(`- **${o.number}** ${o.type_line}${tail}.`)
    }
    lines.push('')
  }

  if (priorities.length > 0) {
    const nums = priorities.map((o) => o.number).join(', ')
    const sample = priorities[0]?.tep_deadline
    if (sample) {
      lines.push(`Заказчиком определены первоочередные объекты: ${nums} — формирование ТЭП должно быть завершено в срок до ${sample}.`)
    } else {
      lines.push(`Заказчиком определены первоочередные объекты: ${nums}.`)
    }
  }

  return lines.join('\n')
}

// Утилита: вытащить список объектов отчёта в формате PreambleObjectLine
// (используется и для преамбулы, и для определения приоритетов в UI).
export async function loadPreambleLines(reportId: string): Promise<PreambleObjectLine[]> {
  const sectionsRes = await supabaseAdmin
    .from('object_reports')
    .select('object_id, priority_group, tep_deadline')
    .eq('report_id', reportId)

  const sections = (sectionsRes.data ?? []) as Array<{
    object_id: string; priority_group: 'priority' | 'secondary' | null; tep_deadline: string | null
  }>
  if (sections.length === 0) return []

  const ids = sections.map((s) => s.object_id)
  const objRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name')
    .in('id', ids)
    .order('code', { ascending: true })

  const byId = new Map<string, { id: string; code: string; current_name: string }>()
  for (const o of (objRes.data ?? [])) byId.set(o.id, o)

  // Подрядчик: documents + document_objects.object_code → legal_entities.name.
  // (Таблица `contracts` была удалена — все договоры теперь в `documents` type='ДОГОВОРА'.)
  const objectCodes = (objRes.data ?? []).map((o) => o.code)
  const contractorByObject = new Map<string, string>()
  if (objectCodes.length > 0) {
    const docsRes = await supabaseAdmin
      .from('documents')
      .select(`
        id, contractor_entity_id, signed_date,
        document_objects!inner(object_code)
      `)
      .in('document_objects.object_code', objectCodes)
      .order('signed_date', { ascending: true, nullsFirst: true })

    type DocRow = {
      id: string;
      contractor_entity_id: string | null;
      signed_date: string | null;
      document_objects: Array<{ object_code: string }>;
    }
    const docs = (docsRes.data ?? []) as unknown as DocRow[]

    const contractorIds = new Set<string>()
    for (const d of docs) if (d.contractor_entity_id) contractorIds.add(d.contractor_entity_id)
    const entRes = contractorIds.size > 0
      ? await supabaseAdmin.from('legal_entities').select('id, name').in('id', [...contractorIds])
      : { data: [] }
    const nameById = new Map((entRes.data ?? []).map((e) => [e.id as string, e.name as string]))

    // code → object.id для финального mapping
    const codeToId = new Map((objRes.data ?? []).map((o) => [o.code as string, o.id as string]))
    for (const d of docs) {
      if (!d.contractor_entity_id) continue
      const name = nameById.get(d.contractor_entity_id)
      if (!name) continue
      for (const link of d.document_objects ?? []) {
        const oid = codeToId.get(link.object_code)
        if (!oid) continue
        if (!contractorByObject.has(oid)) {
          contractorByObject.set(oid, name)
        }
      }
    }
  }

  // Fallback для tep_deadline: если поле в object_reports пусто — берём из
  // calendar_entries **самую позднюю** дату приёмочного типа
  // (entry_type ∈ {appr_sign, appr_submission, work_end}).
  // Логика: самая поздняя точка ≈ завершение последнего этапа договора ≈ срок ТЭП.
  // Прошедшие даты игнорируем (если все приёмочные точки уже в прошлом — fallback не сработает).
  const todayISO = new Date().toISOString().slice(0, 10)
  const tepFallbackByObject = new Map<string, string>()
  if (ids.length > 0) {
    const calRes = await supabaseAdmin
      .from('calendar_entries')
      .select('object_ids, date_end, date_computed, entry_type')
      .overlaps('object_ids', ids)
      .in('entry_type', ['appr_sign', 'appr_submission', 'work_end'])

    for (const ce of (calRes.data ?? []) as Array<{
      object_ids: string[] | null; date_end: string | null;
      date_computed: string | null; entry_type: string | null;
    }>) {
      const d = ce.date_end ?? ce.date_computed
      if (!d) continue
      if (d < todayISO) continue   // игнорируем уже прошедшие плановые точки
      for (const oid of ce.object_ids ?? []) {
        const existing = tepFallbackByObject.get(oid)
        if (!existing || d > existing) {
          tepFallbackByObject.set(oid, d)   // берём самую ПОЗДНЮЮ из будущих
        }
      }
    }
  }

  const result: PreambleObjectLine[] = []
  for (const s of sections) {
    const o = byId.get(s.object_id)
    if (!o) continue
    // «№001» — берём raw-цифры из кода (ведущие нули сохраняем).
    // Код вида "001_OBJECT" → "001"; "101_OBJECT" → "101".
    const numMatch = o.code.match(/^(\d{1,3})/)
    const number = numMatch ? `№${numMatch[1]}` : `«${o.code}»`
    // tep_deadline: ручное (object_reports) > fallback из calendar_entries > null
    const tepDeadline = s.tep_deadline ?? tepFallbackByObject.get(o.id) ?? null
    result.push({
      code: o.code,
      number,
      type_line: o.current_name,
      contractor: contractorByObject.get(o.id) ?? null,
      tep_deadline: tepDeadline,
      priority_group: s.priority_group,
    })
  }
  // Сортировка: priority → потом secondary → null. Внутри — по коду.
  result.sort((a, b) => {
    const ra = a.priority_group === 'priority' ? 0 : a.priority_group === 'secondary' ? 1 : 2
    const rb = b.priority_group === 'priority' ? 0 : b.priority_group === 'secondary' ? 1 : 2
    if (ra !== rb) return ra - rb
    return a.code.localeCompare(b.code)
  })
  return result
}

// Опционально LLM-генерация преамбулы (унифицированный связный нарратив).
// Используется когда детерминированной таблицы недостаточно.
export async function generateLlmPreamble(
  snapshotDate: Date,
  objects: PreambleObjectLine[],
): Promise<string> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')
  const snap = snapshotDate.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })

  // Передаём в LLM только заполненные поля — если данных нет, поле опускаем
  // (а не пишем «не задан/не определён»). Так LLM не будет повторять эти пометки.
  const listing = objects.map((o) => {
    const parts: string[] = []
    if (o.contractor) parts.push(`исполнитель ${o.contractor}`)
    if (o.tep_deadline) parts.push(`срок ТЭП ${o.tep_deadline}`)
    const prio = o.priority_group === 'priority' ? ' [ПЕРВООЧЕРЕДНОЙ]' : ''
    const tail = parts.length > 0 ? ` — ${parts.join(', ')}` : ''
    return `- ${o.number} ${o.type_line}${tail}${prio}`.trim()
  }).join('\n')

  const prompt = `Сформируй преамбулу «Справки технического заказчика» для руководства и акционеров
на дату ${snap}. Объект — туристический комплекс «Золотые пески России».

${PROJECT_GLOSSARY}

Структура преамбулы (3-5 абзацев Markdown):
1. Краткое вводное: «Туристический комплекс «Золотые пески России» — краткая справка на ${snap}.»
2. Перечень объектов первой очереди (списком "- ${'${№}'} ${'${тип}'} ${'${ёмкость}'} — исполнитель ${'${подрядчик}'}, срок ТЭП ${'${дата}'}").
3. Если есть первоочередные — отдельный абзац: «Заказчиком определены первоочередные объекты: ${'${№№}'} — формирование ТЭП должно быть завершено в срок до ${'${ближайший_срок}'}.»

ВАЖНО:
- Сохраняй номер объекта В ТОЧНОСТИ как передан (с ведущими нулями: «№001», не «№1»).
- Если у объекта НЕТ подрядчика — НЕ пиши «исполнитель не определён», просто опусти эту часть.
- Если у объекта НЕТ срока ТЭП — НЕ пиши «срок ТЭП не задан», просто опусти эту часть.
- НЕ выдумывай данных. Если по части объектов сроков нет, в финальном абзаце про первоочередные ссылайся только на тех, у кого срок задан.

Деловой нейтральный тон. Не упоминай ничего за пределами этого списка.

Список объектов на сегодня:

${listing}

Верни строго JSON:
{
  "preamble": "..."
}

Без markdown-обёртки, без \`\`\`.`

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
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err}`)
  }
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  try {
    const parsed = JSON.parse(content) as { preamble?: string }
    return parsed.preamble?.trim() ?? ''
  } catch {
    // fallback на детерминированный шаблон
    return buildControlPreamble(snapshotDate, objects)
  }
}
