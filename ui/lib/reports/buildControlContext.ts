import { supabaseAdmin } from '@/lib/supabase-admin'
import { isoDate } from './periodHelpers'
import { enrichEventsWithLifecycle, type EventRow, type TaskRow, type TopicRow } from './buildContext'
import { isLlmHintApplicable } from './isLlmHintApplicable'

// Контекст для control-отчёта (Справка ТЗ).
// Отличия от обычного buildContext:
//   • snapshotDate — дата формирования (period_start ≡ period_end)
//   • Нет понятия «следующий период»
//   • Подтягиваем ВСЮ историю объекта (не только окно):
//       - все события-факты
//       - все активные задачи + закрытые за RECENT_DAYS дней
//       - все темы собраний последние RECENT_DAYS дней
//   • Дополнительно — план: calendar_entries (плановые этапы договоров)

const RECENT_DAYS = 60   // окно для «недавно закрытых» / «недавно обсуждённых»

export type ControlContext = {
  object: {
    id: string
    code: string
    current_name: string
    aliases: string[]                  // алиасы (для блока 0)
    llm_hint: string | null
    tep_deadline: string | null        // из object_reports (если задан)
    priority_group: 'priority' | 'secondary' | null
  }
  snapshotDate: Date
  include_financials?: boolean

  // Договоры объекта с подрядчиком и текущим этапом (для блока 0 "Сводка")
  contracts: ControlContract[]

  tasks_active: TaskRow[]
  tasks_overdue: TaskRow[]
  tasks_recently_done: TaskRow[]   // closed/done за RECENT_DAYS дней

  events_recent: EventRow[]         // все factual events за RECENT_DAYS

  // Lifecycle важных событий (см. buildContext.ts):
  // — resolved за последние RECENT_DAYS → достижения
  // — активные проблемы (есть raised-задача в работе) → текущая ситуация
  // — констатация риска (без followup) → требуют внимания
  events_resolved_recent: EventRow[]
  events_active_problems: EventRow[]
  events_risk_no_followup: EventRow[]

  recent_topics: TopicRow[]         // последние RECENT_DAYS

  // Плановые этапы (calendar_entries) — только будущие или текущие
  calendar_planned: CalendarEntryRow[]
}

export type ControlContract = {
  id: string
  type: string
  title: string
  doc_number: string | null
  signed_date: string | null
  contractor_name: string | null
  contractor_entity_id: string | null
  current_stage_id: string | null
  current_stage_number: number | null
  current_stage_name: string | null
}

export type CalendarEntryRow = {
  id: string
  title: string
  date_planned: string | null
  date_end: string | null
  note: string | null
  entry_type: string | null
}

export async function buildControlContext(
  objectId: string,
  snapshotDate: Date,
  options?: { include_financials?: boolean },
): Promise<ControlContext> {
  // Объект (+ aliases для блока 0 "Сводка", + окно применимости llm_hint)
  const objRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name, llm_hint, aliases, llm_hint_valid_from, llm_hint_valid_until')
    .eq('id', objectId)
    .single()
  if (objRes.error || !objRes.data) {
    throw new Error(`Объект не найден: ${objectId} (${objRes.error?.message ?? 'неизвестно'})`)
  }

  // Нормализуем aliases: в objects.aliases JSONB; ожидаем массив строк
  let aliases: string[] = []
  const rawAliases = (objRes.data as { aliases?: unknown }).aliases
  if (Array.isArray(rawAliases)) {
    aliases = rawAliases.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  }

  // Применимость hint на snapshot-дату (control → period_start = snapshotDate)
  const hintCheck = isLlmHintApplicable(
    {
      llm_hint: objRes.data.llm_hint,
      llm_hint_valid_from: (objRes.data as { llm_hint_valid_from?: string | null }).llm_hint_valid_from ?? null,
      llm_hint_valid_until: (objRes.data as { llm_hint_valid_until?: string | null }).llm_hint_valid_until ?? null,
    },
    isoDate(snapshotDate),
  )
  const effectiveHint = hintCheck.effective

  // Договоры объекта с подрядчиком и текущим этапом
  const contracts = await loadObjectContractsForControl(objRes.data.code)

  // Метаданные из object_reports (tep_deadline, priority_group) — берём
  // последнюю запись по этому объекту в control-отчёте (если есть)
  let tep_deadline: string | null = null
  let priority_group: 'priority' | 'secondary' | null = null
  // Не критично — оставим пустыми, если ещё нет; вызывающая сторона может задать сама

  const snapISO = isoDate(snapshotDate)
  const recentFrom = new Date(snapshotDate.getTime() - RECENT_DAYS * 86400000)
  const recentFromISO = isoDate(recentFrom)

  // События-факты (+ importance для lifecycle).
  // is_preliminary=true (черновики «На ревью») исключаем — не утверждены.
  const eventsRes = await supabaseAdmin
    .from('events')
    .select('id, title, event_type, date_computed, date_end, note, object_ids, importance')
    .contains('object_ids', [objectId])
    .or('is_preliminary.is.null,is_preliminary.eq.false')
    .order('date_computed', { ascending: false, nullsFirst: false })

  const allEvents = (eventsRes.data ?? []) as EventRow[]
  // Обогатим lifecycle для ВСЕХ событий (resolved может быть позднее окна)
  await enrichEventsWithLifecycle(allEvents)

  const events_recent: EventRow[] = []
  for (const ev of allEvents) {
    const d = ev.date_computed ?? ev.date_end
    if (!d) continue
    if (d > snapISO) continue       // не показываем будущие факты (их нет, но на всякий)
    if (d < recentFromISO) continue
    events_recent.push(ev)
  }

  // Lifecycle-блоки важных событий (high/critical)
  const importantEvents = allEvents.filter(
    (e) => e.importance === 'high' || e.importance === 'critical',
  )
  const events_resolved_recent: EventRow[] = importantEvents.filter(
    (e) => e.is_resolved === true && !!e.resolved_date
        && e.resolved_date >= recentFromISO && e.resolved_date <= snapISO,
  )
  const events_active_problems: EventRow[] = importantEvents.filter(
    (e) => !e.is_resolved && e.has_active_task === true,
  )
  const events_risk_no_followup: EventRow[] = importantEvents.filter(
    (e) => !e.is_resolved && !e.has_active_task && (e.task_count ?? 0) === 0
        && !e.is_resolution,  // event-резолюции (E2) сами решают — не риски
  )

  // Per-object статусы
  const tosRes = await supabaseAdmin
    .from('task_object_status')
    .select('task_id, status, done_date, done_note')
    .eq('object_id', objectId)

  const tos = (tosRes.data ?? []) as Array<{
    task_id: string; status: string; done_date: string | null; done_note: string | null
  }>

  // Загрузка tasks + meeting_date через JOIN meetings (legacy source_meeting_date
  // удалено в миграции 20260526000001).
  let tasksById = new Map<string, TaskRow & { created_at: string }>()
  if (tos.length > 0) {
    const taskIds = tos.map((r) => r.task_id)
    const tRes = await supabaseAdmin
      .from('tasks')
      .select('id, code, title, explanation, priority, assignee_org, due_date, meeting_id, created_at, meetings:meeting_id(meeting_date)')
      .in('id', taskIds)
    type Row = {
      id: string; code: string; title: string; explanation: string | null;
      priority: string | null; assignee_org: string | null; due_date: string | null;
      meeting_id: string | null; created_at: string;
      meetings: { meeting_date: string | null } | { meeting_date: string | null }[] | null;
    }
    for (const t of (tRes.data ?? []) as Row[]) {
      const m = Array.isArray(t.meetings) ? t.meetings[0] : t.meetings
      tasksById.set(t.id, {
        id: t.id,
        code: t.code,
        title: t.title,
        explanation: t.explanation,
        status: '',
        priority: t.priority,
        assignee_org: t.assignee_org,
        due_date: t.due_date,
        done_date: null,
        done_note: null,
        meeting_id: t.meeting_id,
        meeting_date: m?.meeting_date ?? null,
        created_at: t.created_at,
      })
    }
  }

  const tasks_active: TaskRow[] = []
  const tasks_overdue: TaskRow[] = []
  const tasks_recently_done: TaskRow[] = []
  for (const r of tos) {
    const t = tasksById.get(r.task_id)
    if (!t) continue
    const enriched: TaskRow = {
      ...t,
      status: r.status,
      done_date: r.done_date,
      done_note: r.done_note,
    }
    if (r.status === 'open' || r.status === 'in_progress') {
      tasks_active.push(enriched)
      if (t.due_date && t.due_date < snapISO) {
        tasks_overdue.push(enriched)
      }
    }
    if (['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= recentFromISO && r.done_date <= snapISO) {
      tasks_recently_done.push(enriched)
    }
  }

  // Темы за последние RECENT_DAYS
  const topicsRes = await supabaseAdmin
    .from('meeting_topics')
    .select('id, title, content, raised_by_org, meeting_id, status')
    .contains('object_ids', [objectId])
    .eq('status', 'approved')
    .order('seq')

  const topicsRaw = (topicsRes.data ?? []) as Array<{
    id: string; title: string; content: string; raised_by_org: string | null; meeting_id: string | null
  }>
  const recent_topics: TopicRow[] = []
  if (topicsRaw.length > 0) {
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
    for (const t of topicsRaw) {
      const md = t.meeting_id ? meetingDateById.get(t.meeting_id) : null
      if (!md) continue
      if (md >= recentFromISO && md <= snapISO) {
        recent_topics.push({
          id: t.id, title: t.title, content: t.content,
          raised_by_org: t.raised_by_org, meeting_date: md,
        })
      }
    }
  }

  // Плановые этапы из calendar_entries (только будущие/текущие)
  const calendarRes = await supabaseAdmin
    .from('calendar_entries')
    .select('id, title, date_planned, date_end, note, entry_type, object_ids, status')
    .contains('object_ids', [objectId])
    .order('date_planned', { ascending: true, nullsFirst: false })

  const calendar_planned: CalendarEntryRow[] = []
  for (const c of (calendarRes.data ?? []) as Array<CalendarEntryRow & { object_ids?: string[]; status?: string | null }>) {
    // Только активные плановые (status='planned')
    if (c.status && c.status !== 'planned') continue
    const d = c.date_planned ?? c.date_end
    if (d && d < recentFromISO) continue  // далёкое прошлое — не интересно
    calendar_planned.push({
      id: c.id, title: c.title, date_planned: c.date_planned,
      date_end: c.date_end, note: c.note, entry_type: c.entry_type,
    })
  }

  return {
    object: {
      id: objRes.data.id as string,
      code: objRes.data.code as string,
      current_name: objRes.data.current_name as string,
      llm_hint: effectiveHint,
      aliases,
      tep_deadline,
      priority_group,
    },
    snapshotDate,
    include_financials: options?.include_financials ?? false,
    contracts,
    tasks_active,
    tasks_overdue,
    tasks_recently_done,
    events_recent,
    events_resolved_recent,
    events_active_problems,
    events_risk_no_followup,
    recent_topics,
    calendar_planned,
  }
}

// ────────────────────────────────────────────────────────────────
// Договоры объекта для control-отчёта (с подрядчиком и текущим этапом).
// Аналог loadObjectContracts из buildContext.ts, но с типом ControlContract.
// ────────────────────────────────────────────────────────────────
async function loadObjectContractsForControl(objectCode: string): Promise<ControlContract[]> {
  const docsRes = await supabaseAdmin
    .from('documents')
    .select(`
      id, type, title, doc_number, signed_date,
      contractor_entity_id,
      document_objects!inner(object_code)
    `)
    .eq('document_objects.object_code', objectCode)
    .order('signed_date', { ascending: false, nullsFirst: false })

  if (docsRes.error || !docsRes.data || docsRes.data.length === 0) return []

  type DocRow = {
    id: string; type: string; title: string;
    doc_number: string | null; signed_date: string | null;
    contractor_entity_id: string | null;
  }
  const docs = docsRes.data as unknown as DocRow[]

  const docIds = docs.map((d) => d.id)
  const entityIds = new Set<string>()
  for (const d of docs) {
    if (d.contractor_entity_id) entityIds.add(d.contractor_entity_id)
  }

  // Текущий этап берём из view contract_stages_with_progress по флагу is_current.
  // Это единый источник истины индикатора текущего этапа (поддерживает любую логику
  // «как считать текущий» — через documents.current_stage_id или иначе).
  const [entRes, stRes] = await Promise.all([
    entityIds.size > 0
      ? supabaseAdmin.from('legal_entities').select('id, name').in('id', [...entityIds])
      : Promise.resolve({ data: [] }),
    docIds.length > 0
      ? supabaseAdmin
          .from('contract_stages_with_progress')
          .select('id, document_id, stage_number, stage_name, is_current')
          .in('document_id', docIds)
          .eq('is_current', true)
      : Promise.resolve({ data: [] }),
  ])
  const entById = new Map((entRes.data ?? []).map((e) => [e.id as string, e.name as string]))
  const stageByDocId = new Map<string, { id: string; stage_number: number; stage_name: string }>()
  for (const s of (stRes.data ?? [])) {
    stageByDocId.set(s.document_id as string, {
      id: s.id as string,
      stage_number: s.stage_number as number,
      stage_name: s.stage_name as string,
    })
  }

  return docs.map((d) => {
    const stage = stageByDocId.get(d.id) ?? null
    return {
      id: d.id,
      type: d.type,
      title: d.title,
      doc_number: d.doc_number,
      signed_date: d.signed_date,
      contractor_name: d.contractor_entity_id ? entById.get(d.contractor_entity_id) ?? null : null,
      contractor_entity_id: d.contractor_entity_id,
      current_stage_id: stage?.id ?? null,
      current_stage_number: stage?.stage_number ?? null,
      current_stage_name: stage?.stage_name ?? null,
    }
  })
}
