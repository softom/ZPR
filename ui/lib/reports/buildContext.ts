import { supabaseAdmin } from '@/lib/supabase-admin'
import { isoDate, nextPeriod, type PeriodType } from './periodHelpers'
import { isLlmHintApplicable } from './isLlmHintApplicable'

// Контекст для LLM-генерации одного раздела отчёта (по одному объекту).
// Максимальная выборка: события, задачи, темы, статусы, сроки.
// MS Project и договорные пункты — TODO (отложены).

export type ReportContext = {
  object: { id: string; code: string; current_name: string; llm_hint: string | null }
  period: { type: PeriodType; start: Date; end: Date; nextStart: Date; nextEnd: Date }
  // Флаги отчёта (пробрасываются из reports → влияют на промпт)
  include_financials?: boolean

  // Договоры объекта с привязкой к подрядчику и текущему этапу
  // (для блока «Заключённые договоры по объекту» в weekly v3).
  contracts: ContractWithStage[]

  // События с object_ids @ object.id
  // После сплита 20260508_*: events содержит только факты (project_note/meeting/protocol_correction).
  // Плановые/договорные вехи живут в calendar_entries (сюда пока не подтягиваем — TODO Phase 4b).
  events_in_period: EventRow[]      // date_end в [start, end]
  events_next_period: EventRow[]    // [] — заглушка после сплита (плана нет в events)
  events_overdue: EventRow[]        // [] — события-факты не бывают просроченными

  // ─── Lifecycle важных событий (importance ∈ {high, critical}) ──────────
  // Семантика «Проблема → Задача-решение → Закрывающее событие». См. WIKI 14.
  // Передаются LLM отдельными блоками — для секций «Достижения» и «Риски».

  // Решено за период: важное событие, у которого raised_from-задача закрыта,
  // а закрывающее событие E2 имеет date_end ∈ [period_start, period_end].
  // → пойдёт в блок «✓ Решено за период» (достижения).
  events_resolved_in_period: EventRow[]

  // Активные проблемы: важное событие с raised_from-задачей в статусе
  // open/in_progress на конец периода. → пойдёт в блок «🔓 Активные проблемы».
  events_active_problems: EventRow[]

  // Констатация риска: важное событие без raised_from-задачи и не resolved.
  // → пойдёт в блок «🔴 Риски (без followup)».
  events_risk_no_followup: EventRow[]

  // Per-object статусы задач
  tasks_done_in_period: TaskRow[]   // task_object_status.done_date в периоде
  tasks_active: TaskRow[]           // open/in_progress на этом объекте
  tasks_overdue: TaskRow[]          // active + due_date < today
  tasks_due_next_period: TaskRow[]  // active + due_date в [next_start, next_end]

  // Темы «Обсудили» с собраний за период (±2 недели контекста)
  recent_topics: TopicRow[]
}

// Договор объекта с привязкой к подрядчику и текущему этапу.
// Используется в Weekly v3 (детерминированный рендер блока «Заключённые договоры»).
export type ContractWithStage = {
  id: string
  doc_number: string | null
  signed_date: string | null
  title: string
  type: string
  contractor_name: string | null
  customer_name: string | null
  current_stage_id: string | null
  current_stage_number: number | null
  current_stage_name: string | null
}

export type EventRow = {
  id: string
  title: string
  event_type: string
  date_computed: string | null
  date_end: string | null
  note: string | null
  // Шкала важности — для отбора в отчёт (см. WIKI 14 → events.importance).
  // 'critical' / 'high' выделяются как «важные события» с lifecycle.
  importance?: 'critical' | 'high' | 'normal' | 'low' | null
  // Lifecycle (заполняется в enrichEventsWithLifecycle, опциональные пока
  // не вызвана функция обогащения):
  // — есть ли задача-followup (task → raised_from → этот event)
  // — закрыта ли эта задача через resolved_by → другое событие E2
  // — дата E2 (закрывающего события)
  is_resolved?: boolean
  resolved_date?: string | null
  resolved_by_title?: string | null
  task_count?: number
  has_active_task?: boolean
  // Список raised_from-задач для UI — каждая со своим статусом, кодом, заголовком,
  // done_date. Используется в сводках контекста чтобы рядом с событием показать
  // задачу-followup, которая стала причиной resolution / находится в работе.
  related_tasks?: LifecycleTaskMini[]
  // Событие выполняет роль РЕШЕНИЯ (E2): на него ссылается task→event resolved_by.
  // Такое событие НЕ требует собственного followup — оно само закрывает другую проблему.
  // Исключается из категории risk_no_followup.
  is_resolution?: boolean
  resolves_event_titles?: string[]   // заголовки E1-событий, которые оно закрыло
}

export type LifecycleTaskMini = {
  id: string
  code: string
  title: string
  status: string
  done_date: string | null
}

export type TaskRow = {
  id: string
  code: string
  title: string
  explanation: string | null
  status: string                    // per-object статус (из task_object_status)
  priority: string | null
  assignee_org: string | null
  due_date: string | null
  done_date: string | null          // per-object done_date
  done_note: string | null
  meeting_id: string | null         // FK на собрание-постановщик (см. WIKI 19_Сущность_Задача v2.4)
  meeting_date: string | null       // подтянуто JOIN'ом meetings.meeting_date по meeting_id
}

export type TopicRow = {
  id: string
  title: string
  content: string
  raised_by_org: string | null
  meeting_date: string | null
}

export async function buildContext(
  objectId: string,
  periodType: PeriodType,
  periodStart: Date,
  periodEnd: Date,
  options?: { include_financials?: boolean },
): Promise<ReportContext> {
  const next = nextPeriod(periodEnd, periodType)

  // Объект (с окном применимости llm_hint)
  const objRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name, llm_hint, llm_hint_valid_from, llm_hint_valid_until')
    .eq('id', objectId)
    .single()
  if (objRes.error || !objRes.data) {
    throw new Error(`Объект не найден: ${objectId}`)
  }
  // Применимость hint на end-period отчёта (week/month → period_end)
  const hintCheck = isLlmHintApplicable(
    {
      llm_hint: objRes.data.llm_hint,
      llm_hint_valid_from: (objRes.data as { llm_hint_valid_from?: string | null }).llm_hint_valid_from ?? null,
      llm_hint_valid_until: (objRes.data as { llm_hint_valid_until?: string | null }).llm_hint_valid_until ?? null,
    },
    isoDate(periodEnd),
  )
  // В контексте оставляем только применимый hint (или null если устарел)
  const effectiveObj = {
    id: objRes.data.id,
    code: objRes.data.code,
    current_name: objRes.data.current_name,
    llm_hint: hintCheck.effective,
  }

  const startISO = isoDate(periodStart)
  const endISO = isoDate(periodEnd)
  const nextStartISO = isoDate(next.start)
  const nextEndISO = isoDate(next.end)
  // Все срезы делаем на endISO (конец отчётного периода), а не «сейчас» —
  // см. блоки wasActiveAtEnd / events_overdue ниже.

  // Параллельно
  const [
    eventsAllRes,
    tosRes,
    contractsResolved,
    topicsRes,
  ] = await Promise.all([
    // События-факты, привязанные к этому объекту (план — в calendar_entries, см. WIKI 15).
    // importance — для отбора в lifecycle (важные события).
    // is_preliminary=true (черновики «На ревью») исключаем — они ещё не утверждены
    // и не должны попадать в LLM-контекст / нарратив отчёта.
    supabaseAdmin
      .from('events')
      .select('id, title, event_type, date_computed, date_end, note, object_ids, importance')
      .contains('object_ids', [objectId])
      .or('is_preliminary.is.null,is_preliminary.eq.false')
      .order('date_computed', { ascending: true, nullsFirst: false }),
    // Per-object статусы для этого объекта
    supabaseAdmin
      .from('task_object_status')
      .select('task_id, status, done_date, done_note')
      .eq('object_id', objectId),
    // Договоры объекта с подрядчиком и текущим этапом
    loadObjectContracts(objectId),
    // Темы собраний последние 30 дней (включая период)
    supabaseAdmin
      .from('meeting_topics')
      .select('id, title, content, raised_by_org, meeting_id, status')
      .contains('object_ids', [objectId])
      .eq('status', 'approved')
      .order('seq'),
  ])

  const allEvents = (eventsAllRes.data ?? []) as EventRow[]
  const tos = (tosRes.data ?? []) as Array<{ task_id: string; status: string; done_date: string | null; done_note: string | null }>

  // Срезы — НА КОНЕЦ ОТЧЁТНОГО ПЕРИОДА (endISO), а не на «сейчас».
  // Без этого активные/просроченные задачи в апрельском отчёте смешивались бы
  // с тем, что произошло после конца апреля.

  // Распределяем события-факты (events после сплита всегда factual).
  // Плановые срезы (next_period, overdue) после сплита идут из calendar_entries —
  // см. TODO Phase 4b «отчёты по плану».
  const events_in_period: EventRow[] = []
  const events_next_period: EventRow[] = []   // TODO: подтянуть из calendar_entries
  const events_overdue: EventRow[] = []       // факты не бывают просроченными
  for (const ev of allEvents) {
    const d = ev.date_computed ?? ev.date_end
    if (d && d >= startISO && d <= endISO) {
      events_in_period.push(ev)
    }
  }

  // Lifecycle важных событий: «Проблема → Задача-решение → Закрывающее событие».
  // Обогащаем ВСЕ allEvents (не только in_period) — закрывающее E2 может быть
  // позднее E1, и нужно знать что у старого риска уже есть resolution.
  await enrichEventsWithLifecycle(allEvents)
  const importantEvents = allEvents.filter(
    (e) => e.importance === 'high' || e.importance === 'critical',
  )
  const events_resolved_in_period: EventRow[] = importantEvents.filter(
    (e) => e.is_resolved === true && !!e.resolved_date
        && e.resolved_date >= startISO && e.resolved_date <= endISO,
  )
  const events_active_problems: EventRow[] = importantEvents.filter(
    (e) => !e.is_resolved && e.has_active_task === true,
  )
  const events_risk_no_followup: EventRow[] = importantEvents.filter(
    (e) => !e.is_resolved && !e.has_active_task && (e.task_count ?? 0) === 0
        && !e.is_resolution,  // event-резолюции (E2) сами решают — не риски
  )

  // helper-переменные (могут быть нужны в коде ниже)
  void nextStartISO; void nextEndISO;

  // Подгружаем tasks для всех task_ids из junction (+ created_at для среза)
  // meeting_date вытягиваем JOIN'ом через meeting_id → meetings.meeting_date
  // (legacy source_meeting_date удалено в миграции 20260526000001).
  let tasksById = new Map<string, TaskRow & { created_at: string }>()
  // meetingDateById используется ниже в блоке тем (recent_topics)
  const meetingDateById = new Map<string, string | null>()
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
        status: '',           // заполнится из junction ниже
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

  // Срез задач на endISO:
  //   wasActive:  created_at ≤ endISO AND (status active сейчас OR done_date > endISO)
  //   wasOverdue: due_date < endISO AND wasActive
  function wasActiveAtEnd(t: TaskRow & { created_at: string }, status: string, done_date: string | null): boolean {
    const created = (t.created_at ?? '').slice(0, 10)
    if (created > endISO) return false
    if (status === 'open' || status === 'in_progress') return true
    if (done_date && done_date > endISO) return true
    return false
  }

  // Распределяем задачи (срезы на endISO)
  const tasks_done_in_period: TaskRow[] = []
  const tasks_active: TaskRow[] = []
  const tasks_overdue: TaskRow[] = []
  const tasks_due_next_period: TaskRow[] = []
  for (const r of tos) {
    const t = tasksById.get(r.task_id)
    if (!t) continue
    const enriched: TaskRow = {
      ...t,
      status: r.status,
      done_date: r.done_date,
      done_note: r.done_note,
    }
    // Закрыто за период (done_date в окне)
    if (['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO) {
      tasks_done_in_period.push(enriched)
    }
    // Активна на конец периода
    if (wasActiveAtEnd(t, r.status, r.done_date)) {
      tasks_active.push(enriched)
      // Просрочена на конец периода (срок < end)
      if (t.due_date && t.due_date < endISO) {
        tasks_overdue.push(enriched)
      }
      // Срок в наступающем периоде
      if (t.due_date && t.due_date >= nextStartISO && t.due_date <= nextEndISO) {
        tasks_due_next_period.push(enriched)
      }
    }
  }

  // Темы: фильтруем по дате собрания (±2 недели вокруг периода)
  const recent_topics: TopicRow[] = []
  const topicsRaw = (topicsRes.data ?? []) as Array<{
    id: string; title: string; content: string; raised_by_org: string | null;
    meeting_id: string | null
  }>
  if (topicsRaw.length > 0) {
    const meetingIds = [...new Set(topicsRaw.map((t) => t.meeting_id).filter((x): x is string => Boolean(x)))]
    if (meetingIds.length > 0) {
      const mRes = await supabaseAdmin
        .from('meetings')
        .select('id, meeting_date')
        .in('id', meetingIds)
      for (const m of (mRes.data ?? []) as Array<{ id: string; meeting_date: string }>) {
        meetingDateById.set(m.id, m.meeting_date)
      }
    }
    const windowDays = 14
    const lo = isoDate(new Date(periodStart.getTime() - windowDays * 86400000))
    const hi = isoDate(new Date(periodEnd.getTime() + windowDays * 86400000))
    for (const t of topicsRaw) {
      const md = t.meeting_id ? meetingDateById.get(t.meeting_id) : null
      if (!md) continue
      if (md >= lo && md <= hi) {
        recent_topics.push({
          id: t.id, title: t.title, content: t.content,
          raised_by_org: t.raised_by_org, meeting_date: md,
        })
      }
    }
  }

  return {
    object: effectiveObj,
    period: {
      type: periodType,
      start: periodStart,
      end: periodEnd,
      nextStart: next.start,
      nextEnd: next.end,
    },
    include_financials: options?.include_financials ?? false,
    events_in_period,
    events_next_period,
    events_overdue,
    events_resolved_in_period,
    events_active_problems,
    events_risk_no_followup,
    tasks_done_in_period,
    tasks_active,
    tasks_overdue,
    tasks_due_next_period,
    recent_topics,
    contracts: contractsResolved,
  }
}

// ────────────────────────────────────────────────────────────────
// Договоры объекта с подрядчиком и текущим этапом.
// Используется в Weekly v3 (детерминированный блок «Заключённые договоры»).
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// Lifecycle важных событий: «Проблема → Задача-решение → Закрывающее событие».
//
// Цепочка связей (без новых link_types — используем существующие):
//   E1 (problem) ←── raised_from ── T (task) ── resolved_by ──→ E2 (resolution)
//
// Алгоритм для каждого event:
//   1. Найти tasks с entity_links to_type='event' to_id=event.id link_type='raised_from'
//   2. Для каждой такой task посмотреть status и resolved_by-event
//   3. Если все raised-задачи closed/done И есть resolved_by event E2 →
//      событие is_resolved=true, resolved_date = E2.date_end || date_computed
//   4. Если есть raised-задача в open/in_progress → has_active_task=true
// ────────────────────────────────────────────────────────────────
export async function enrichEventsWithLifecycle(events: EventRow[]): Promise<void> {
  // Инициализируем дефолты для всех
  for (const ev of events) {
    ev.is_resolved = false
    ev.resolved_date = null
    ev.resolved_by_title = null
    ev.task_count = 0
    ev.has_active_task = false
    ev.is_resolution = false
    ev.resolves_event_titles = []
  }
  if (events.length === 0) return

  const eventIds = events.map((e) => e.id)
  // 0) resolution-роль: на это событие ссылается task→event resolved_by.
  //    Такое событие — закрывающее (E2), уже выполняет роль решения. Не должно
  //    попадать в risk_no_followup, даже если у него нет своего raised_from.
  const resolutionRes = await supabaseAdmin
    .from('entity_links')
    .select('from_id, to_id')
    .eq('from_type', 'task')
    .eq('to_type', 'event')
    .eq('link_type', 'resolved_by')
    .in('to_id', eventIds)
  type ResRow = { from_id: string; to_id: string }
  const resolutionTaskIds = [...new Set(((resolutionRes.data ?? []) as ResRow[]).map((r) => r.from_id))]
  // Помечаем события — кого закрывает каждая задача (через raised_from
  // у задачи находим E1 — событие, которое она «решает»)
  const resolutionByEvent = new Map<string, Set<string>>() // E2.id → set of E1.title
  if (resolutionTaskIds.length > 0) {
    // Найти raised_from-события для этих задач → они E1
    const taskRaisedRes = await supabaseAdmin
      .from('entity_links')
      .select('from_id, to_id')
      .eq('from_type', 'task')
      .eq('to_type', 'event')
      .eq('link_type', 'raised_from')
      .in('from_id', resolutionTaskIds)
    const taskToE1 = new Map<string, string[]>()  // task_id → e1.ids
    for (const r of (taskRaisedRes.data ?? []) as Array<{ from_id: string; to_id: string }>) {
      if (!taskToE1.has(r.from_id)) taskToE1.set(r.from_id, [])
      taskToE1.get(r.from_id)!.push(r.to_id)
    }
    // Загрузим заголовки E1
    const e1Ids = [...new Set([...taskToE1.values()].flat())]
    const titleByEventId = new Map<string, string>()
    if (e1Ids.length > 0) {
      const e1Res = await supabaseAdmin.from('events').select('id, title').in('id', e1Ids)
      for (const e of (e1Res.data ?? []) as Array<{ id: string; title: string }>) {
        titleByEventId.set(e.id, e.title)
      }
    }
    // Заполняем resolutionByEvent: для каждой resolved_by-строки task→E2:
    //   находим task→E1 (raised_from) → добавляем E1.title в множество для E2
    for (const r of (resolutionRes.data ?? []) as ResRow[]) {
      const e2Id = r.to_id
      const taskId = r.from_id
      const e1Ids = taskToE1.get(taskId) ?? []
      if (!resolutionByEvent.has(e2Id)) resolutionByEvent.set(e2Id, new Set())
      const bucket = resolutionByEvent.get(e2Id)!
      for (const e1Id of e1Ids) {
        const title = titleByEventId.get(e1Id)
        if (title) bucket.add(title)
      }
    }
  }
  // Помечаем сами E2-события: само наличие resolved_by-связи означает
  // что это resolution (даже если у задачи нет своего raised_from → E1).
  for (const ev of events) {
    const titles = resolutionByEvent.get(ev.id)
    if (titles) {
      ev.is_resolution = true
      ev.resolves_event_titles = [...titles]  // может быть пустым, это норм
    }
  }

  // 1) raised_from-связи task → event (где event ∈ наших)
  const raisedRes = await supabaseAdmin
    .from('entity_links')
    .select('from_id, to_id')
    .eq('from_type', 'task')
    .eq('to_type', 'event')
    .eq('link_type', 'raised_from')
    .in('to_id', eventIds)
  type RaisedRow = { from_id: string; to_id: string }
  const raised = (raisedRes.data ?? []) as RaisedRow[]
  if (raised.length === 0) return

  // 2) Загрузим статусы этих задач
  const taskIds = [...new Set(raised.map((r) => r.from_id))]
  const tasksRes = await supabaseAdmin
    .from('tasks')
    .select('id, status, code, title, done_date')
    .in('id', taskIds)
  type TaskMini = { id: string; status: string; code: string; title: string; done_date: string | null }
  const taskById = new Map<string, TaskMini>()
  for (const t of (tasksRes.data ?? []) as TaskMini[]) taskById.set(t.id, t)

  // 3) Для всех этих задач — resolved_by event (если есть)
  const resolvedRes = await supabaseAdmin
    .from('entity_links')
    .select('from_id, to_id')
    .eq('from_type', 'task')
    .eq('to_type', 'event')
    .eq('link_type', 'resolved_by')
    .in('from_id', taskIds)
  type ResolvedRow = { from_id: string; to_id: string }
  const taskResolvedByEvent = new Map<string, string>()  // task_id → resolution event_id
  for (const r of (resolvedRes.data ?? []) as ResolvedRow[]) {
    taskResolvedByEvent.set(r.from_id, r.to_id)
  }

  // 4) Загрузим закрывающие события E2 (для дат и заголовков)
  const resolutionEventIds = [...new Set([...taskResolvedByEvent.values()])]
  const resolutionEventById = new Map<string, { date_end: string | null; date_computed: string | null; title: string }>()
  if (resolutionEventIds.length > 0) {
    const e2Res = await supabaseAdmin
      .from('events')
      .select('id, title, date_end, date_computed')
      .in('id', resolutionEventIds)
    for (const e of (e2Res.data ?? []) as Array<{ id: string; title: string; date_end: string | null; date_computed: string | null }>) {
      resolutionEventById.set(e.id, { date_end: e.date_end, date_computed: e.date_computed, title: e.title })
    }
  }

  // 5) Группируем raised по event_id и обогащаем
  const byEvent = new Map<string, RaisedRow[]>()
  for (const r of raised) {
    if (!byEvent.has(r.to_id)) byEvent.set(r.to_id, [])
    byEvent.get(r.to_id)!.push(r)
  }
  for (const ev of events) {
    const links = byEvent.get(ev.id) ?? []
    ev.task_count = links.length
    if (links.length === 0) continue

    let allClosed = true
    let resolutionDate: string | null = null
    let resolutionTitle: string | null = null
    const relatedTasks: LifecycleTaskMini[] = []
    for (const lnk of links) {
      const task = taskById.get(lnk.from_id)
      if (!task) { allClosed = false; continue }
      // Сохраним краткую инфу о задаче для UI
      relatedTasks.push({
        id: task.id,
        code: task.code,
        title: task.title,
        status: task.status,
        done_date: task.done_date,
      })
      if (task.status === 'open' || task.status === 'in_progress' || task.status === 'preliminary') {
        ev.has_active_task = true
        allClosed = false
      }
      const e2id = taskResolvedByEvent.get(task.id)
      if (e2id) {
        const e2 = resolutionEventById.get(e2id)
        if (e2) {
          const d = e2.date_end ?? e2.date_computed
          // Берём самую позднюю дату резолюции (если несколько задач)
          if (d && (!resolutionDate || d > resolutionDate)) {
            resolutionDate = d
            resolutionTitle = e2.title
          }
        }
      }
    }
    if (allClosed && resolutionDate) {
      ev.is_resolved = true
      ev.resolved_date = resolutionDate
      ev.resolved_by_title = resolutionTitle
    }
    if (relatedTasks.length > 0) {
      ev.related_tasks = relatedTasks
    }
  }
}

async function loadObjectContracts(objectId: string): Promise<ContractWithStage[]> {
  // Сначала вытаскиваем code объекта для join через document_objects.object_code (legacy text-link)
  const objRes = await supabaseAdmin
    .from('objects')
    .select('code')
    .eq('id', objectId)
    .single()
  if (objRes.error || !objRes.data) return []
  const objectCode = objRes.data.code

  const docsRes = await supabaseAdmin
    .from('documents')
    .select(`
      id, type, title, doc_number, signed_date,
      contractor_entity_id, customer_entity_id,
      document_objects!inner(object_code)
    `)
    .eq('document_objects.object_code', objectCode)
    .order('signed_date', { ascending: false, nullsFirst: false })

  if (docsRes.error || !docsRes.data || docsRes.data.length === 0) return []

  type DocRow = {
    id: string; type: string; title: string;
    doc_number: string | null; signed_date: string | null;
    contractor_entity_id: string | null;
    customer_entity_id: string | null;
  }
  const docs = docsRes.data as unknown as DocRow[]
  const docIds = docs.map((d) => d.id)

  const entityIds = new Set<string>()
  for (const d of docs) {
    if (d.contractor_entity_id) entityIds.add(d.contractor_entity_id)
    if (d.customer_entity_id) entityIds.add(d.customer_entity_id)
  }

  // Текущий этап — через view contract_stages_with_progress (is_current=true).
  // Единый источник истины индикатора этапа (а не documents.current_stage_id напрямую).
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

  const entityById = new Map<string, string>()
  for (const e of (entRes.data ?? [])) entityById.set(e.id as string, e.name as string)

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
      contractor_name: d.contractor_entity_id ? entityById.get(d.contractor_entity_id) ?? null : null,
      customer_name: d.customer_entity_id ? entityById.get(d.customer_entity_id) ?? null : null,
      current_stage_id: stage?.id ?? null,
      current_stage_number: stage?.stage_number ?? null,
      current_stage_name: stage?.stage_name ?? null,
    }
  })
}
