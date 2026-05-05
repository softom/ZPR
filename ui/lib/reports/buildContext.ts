import { supabaseAdmin } from '@/lib/supabase-admin'
import { isoDate, nextPeriod, type PeriodType } from './periodHelpers'

// Контекст для LLM-генерации одного раздела отчёта (по одному объекту).
// Максимальная выборка: события, задачи, темы, статусы, сроки.
// MS Project и договорные пункты — TODO (отложены).

export type ReportContext = {
  object: { id: string; code: string; current_name: string; llm_hint: string | null }
  period: { type: PeriodType; start: Date; end: Date; nextStart: Date; nextEnd: Date }
  // Флаги отчёта (пробрасываются из reports → влияют на промпт)
  include_financials?: boolean

  // События с object_ids @ object.id
  events_in_period: EventRow[]      // fact_date или date_computed в [start, end]
  events_next_period: EventRow[]    // план в [next_start, next_end]
  events_overdue: EventRow[]        // is_planned=true, date_computed<today, fact_date IS NULL

  // Per-object статусы задач
  tasks_done_in_period: TaskRow[]   // task_object_status.done_date в периоде
  tasks_active: TaskRow[]           // open/in_progress на этом объекте
  tasks_overdue: TaskRow[]          // active + due_date < today
  tasks_due_next_period: TaskRow[]  // active + due_date в [next_start, next_end]

  // Темы «Обсудили» с собраний за период (±2 недели контекста)
  recent_topics: TopicRow[]
}

export type EventRow = {
  id: string
  title: string
  event_type: string
  is_planned: boolean
  fact_date: string | null
  date_computed: string | null
  date_end: string | null
  note: string | null
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
  source_meeting_date: string | null
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

  // Объект
  const objRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name, llm_hint')
    .eq('id', objectId)
    .single()
  if (objRes.error || !objRes.data) {
    throw new Error(`Объект не найден: ${objectId}`)
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
    topicsRes,
  ] = await Promise.all([
    // События привязанные к этому объекту
    supabaseAdmin
      .from('events')
      .select('id, title, event_type, is_planned, fact_date, date_computed, date_end, note, object_ids')
      .contains('object_ids', [objectId])
      .order('date_computed', { ascending: true, nullsFirst: false }),
    // Per-object статусы для этого объекта
    supabaseAdmin
      .from('task_object_status')
      .select('task_id, status, done_date, done_note')
      .eq('object_id', objectId),
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

  // Распределяем события (срезы на endISO)
  const events_in_period: EventRow[] = []
  const events_next_period: EventRow[] = []
  const events_overdue: EventRow[] = []
  for (const ev of allEvents) {
    const factD = ev.fact_date
    const planD = ev.date_computed ?? ev.date_end
    // Состоялось В период (по факту) или должно было состояться (план в окне) — попадает в «события за период»
    if (factD && factD >= startISO && factD <= endISO) {
      events_in_period.push(ev)
    } else if (!factD && planD && planD >= startISO && planD <= endISO) {
      events_in_period.push(ev)
    }
    if (planD && planD >= nextStartISO && planD <= nextEndISO && !factD) {
      events_next_period.push(ev)
    }
    // Просрочено НА КОНЕЦ ПЕРИОДА: план до конца периода и факта (или факт позже периода) нет
    if (ev.is_planned && planD && planD < endISO) {
      if (!factD || factD > endISO) events_overdue.push(ev)
    }
  }

  // Подгружаем tasks для всех task_ids из junction (+ created_at для среза)
  let tasksById = new Map<string, TaskRow & { created_at: string }>()
  const meetingDateById = new Map<string, string | null>()
  if (tos.length > 0) {
    const taskIds = tos.map((r) => r.task_id)
    const tRes = await supabaseAdmin
      .from('tasks')
      .select('id, code, title, explanation, priority, assignee_org, due_date, source_meeting_date, meeting_id, created_at')
      .in('id', taskIds)
    for (const t of (tRes.data ?? []) as Array<TaskRow & { meeting_id?: string | null; created_at: string }>) {
      tasksById.set(t.id, t)
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
    object: objRes.data,
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
    tasks_done_in_period,
    tasks_active,
    tasks_overdue,
    tasks_due_next_period,
    recent_topics,
  }
}
