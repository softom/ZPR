// Расчёт количественных показателей секции отчёта (одного объекта).
// Используется в UI карточки и в LLM-промпте сводки по проекту.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { isoDate, nextPeriod, type PeriodType } from './periodHelpers'

// Для задач есть два счётчика:
//   _tasks — количество уникальных задач (то, что человек видит как «3 задачи»)
//   _pairs — количество пар (задача × объект) — junction-строк, попадающих в категорию
//            (то, что считается на per-object отчётах: «по 7 случаям»)
export type SectionStats = {
  tasks_done: number          // pairs (для совместимости со старым кодом /reports/[id])
  tasks_active: number        // pairs
  tasks_overdue: number       // pairs
  tasks_due_next: number      // pairs
  // Уникальные задачи в каждой категории — для UI экспресс-статистики
  tasks_done_unique: number
  tasks_active_unique: number
  tasks_overdue_unique: number
  tasks_due_next_unique: number
  events_in_period: number
  events_next_period: number
  events_overdue: number
  topics_recent: number
}

// Выжимка по одному заключённому договору объекта.
export type ContractSummary = {
  id: string
  type: string                  // тип документа (договор/ДУ/ФЗ/...)
  title: string
  doc_number: string | null
  signed_date: string | null
  customer_name: string | null      // snapshot.customer.name → fallback на legal_entity.name
  contractor_name: string | null
  contractor_entity_id: string | null  // нужен для группировки
}

// Группа подрядчика: один блок на уникальный contractor_entity_id.
// Содержит N договоров с этим объектом + статистику по задачам подрядчика
// (эвристика: tasks.assignee_entity_id = contractor_entity_id).
export type ContractorGroup = {
  contractor_entity_id: string | null    // null = «без договора» (orphan-задачи)
  contractor_name: string                // имя или «Без договора»
  contracts: ContractSummary[]           // [] для группы «без договора»
  stats: {
    tasks_done: number
    tasks_active: number
    tasks_overdue: number
  }
}

export type SectionStatsWithObject = SectionStats & {
  object_id: string
  object_code: string
  object_name: string
  contractors: ContractorGroup[]
}

// Глобальные totals по проекту целиком — уникальные task_ids по всему набору.
// Сумма unique по объектам != global unique (одна задача на 3 объектах =
// 3 в сумме unique по карточкам, но 1 в global unique).
export type GlobalTotals = {
  tasks_done_unique: number
  tasks_done_pairs: number
  tasks_active_unique: number
  tasks_active_pairs: number
  tasks_overdue_unique: number
  tasks_overdue_pairs: number
  events_in_period: number
  topics_recent: number
}

// Подсчёт показателей для всех объектов отчёта одним батчем (для UI и summary).
// Срезы — на КОНЕЦ ОТЧЁТНОГО ПЕРИОДА (period_end).
export async function buildAllSectionStats(
  reportId: string,
  periodType: PeriodType,
  periodStart: Date,
  periodEnd: Date,
): Promise<SectionStatsWithObject[]> {
  // Список объектов отчёта (через object_reports)
  const sectionsRes = await supabaseAdmin
    .from('object_reports')
    .select('object_id')
    .eq('report_id', reportId)
  const objectIds = (sectionsRes.data ?? []).map((s) => s.object_id as string)
  if (objectIds.length === 0) return []
  return computeStatsForObjects(objectIds, periodType, periodStart, periodEnd, periodEnd)
}

// Подсчёт показателей для произвольного периода — для экспресс-статистики
// `/reports/stats` без сохранения в БД.
//
// • Если выбранный период УЖЕ ЗАВЕРШЁН (period_end < today) — срез на period_end.
// • Если период ВКЛЮЧАЕТ сегодня (period_end >= today) — срез на today
//   (актуальная картина к моменту просмотра).
export async function buildStatsForPeriod(
  periodType: PeriodType,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ stats: SectionStatsWithObject[]; totals: GlobalTotals }> {
  // Список активных объектов
  const objsRes = await supabaseAdmin
    .from('objects')
    .select('id')
    .eq('active', true)
    .order('code')
  const objectIds = (objsRes.data ?? []).map((o) => o.id as string)
  if (objectIds.length === 0) {
    return {
      stats: [],
      totals: {
        tasks_done_unique: 0, tasks_done_pairs: 0,
        tasks_active_unique: 0, tasks_active_pairs: 0,
        tasks_overdue_unique: 0, tasks_overdue_pairs: 0,
        events_in_period: 0, topics_recent: 0,
      },
    }
  }

  // cutoff: today если period ещё не завершён, иначе period_end
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cutoff = today < periodEnd ? today : periodEnd

  const stats = await computeStatsForObjects(objectIds, periodType, periodStart, periodEnd, cutoff)
  const totals = await computeGlobalTotals(objectIds, periodStart, periodEnd, cutoff)
  return { stats, totals }
}

// Глобальные totals: уникальные task_ids/event_ids/topic_ids по всему проекту.
async function computeGlobalTotals(
  objectIds: string[],
  periodStart: Date,
  periodEnd: Date,
  cutoff: Date,
): Promise<GlobalTotals> {
  const startISO = isoDate(periodStart)
  const endISO = isoDate(periodEnd)
  const cutoffISO = isoDate(cutoff)

  // task_object_status по всем активным объектам
  const tosRes = await supabaseAdmin
    .from('task_object_status')
    .select('task_id, object_id, status, done_date')
    .in('object_id', objectIds)
  const tos = (tosRes.data ?? []) as Array<{ task_id: string; object_id: string; status: string; done_date: string | null }>

  const taskIds = [...new Set(tos.map((r) => r.task_id))]
  const tasksDue = new Map<string, string | null>()
  const tasksCreated = new Map<string, string>()
  if (taskIds.length > 0) {
    const tRes = await supabaseAdmin
      .from('tasks')
      .select('id, due_date, created_at')
      .in('id', taskIds)
    for (const t of (tRes.data ?? []) as Array<{ id: string; due_date: string | null; created_at: string }>) {
      tasksDue.set(t.id, t.due_date)
      tasksCreated.set(t.id, t.created_at)
    }
  }

  const doneUnique = new Set<string>()
  const activeUnique = new Set<string>()
  const overdueUnique = new Set<string>()
  let donePairs = 0, activePairs = 0, overduePairs = 0

  for (const r of tos) {
    // done in period
    if (['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO) {
      donePairs += 1
      doneUnique.add(r.task_id)
    }
    // active at cutoff
    const created = (tasksCreated.get(r.task_id) ?? '').slice(0, 10)
    if (!created || created > cutoffISO) continue
    let active = false
    if (r.status === 'open' || r.status === 'in_progress') active = true
    else if (r.done_date && r.done_date > cutoffISO) active = true
    if (!active) continue
    activePairs += 1
    activeUnique.add(r.task_id)
    // overdue at cutoff
    const due = tasksDue.get(r.task_id)
    if (due && due < cutoffISO) {
      overduePairs += 1
      overdueUnique.add(r.task_id)
    }
  }

  // Events in period (события — уникальны по id, без pairs/unique различия)
  const evRes = await supabaseAdmin
    .from('events')
    .select('id, date_computed, date_end, object_ids')
    .overlaps('object_ids', objectIds)
  let events_in_period = 0
  for (const ev of (evRes.data ?? []) as Array<{ id: string; date_computed: string | null; date_end: string | null; object_ids: string[] }>) {
    const d = ev.date_computed ?? ev.date_end
    if (d != null && d >= startISO && d <= endISO) events_in_period += 1
  }

  // Topics ±2 weeks
  const lo = isoDate(new Date(periodStart.getTime() - 14 * 86400000))
  const hi = isoDate(new Date(periodEnd.getTime() + 14 * 86400000))
  const mRes = await supabaseAdmin
    .from('meetings')
    .select('id')
    .gte('meeting_date', lo)
    .lte('meeting_date', hi)
  const meetingIds = (mRes.data ?? []).map((m) => m.id as string)
  let topics_recent = 0
  if (meetingIds.length > 0) {
    const tRes = await supabaseAdmin
      .from('meeting_topics')
      .select('id, object_ids, status')
      .in('meeting_id', meetingIds)
      .eq('status', 'approved')
    for (const t of (tRes.data ?? []) as Array<{ id: string; object_ids: string[] }>) {
      const matches = (t.object_ids ?? []).some((oid) => objectIds.includes(oid))
      if (matches) topics_recent += 1
    }
  }

  return {
    tasks_done_unique: doneUnique.size,
    tasks_done_pairs: donePairs,
    tasks_active_unique: activeUnique.size,
    tasks_active_pairs: activePairs,
    tasks_overdue_unique: overdueUnique.size,
    tasks_overdue_pairs: overduePairs,
    events_in_period,
    topics_recent,
  }
}

// Внутренний core — общий расчёт статистики для произвольного списка объектов.
async function computeStatsForObjects(
  objectIds: string[],
  periodType: PeriodType,
  periodStart: Date,
  periodEnd: Date,
  cutoff: Date,
): Promise<SectionStatsWithObject[]> {
  const next = nextPeriod(periodEnd, periodType)
  const startISO = isoDate(periodStart)
  const endISO = isoDate(periodEnd)
  const cutoffISO = isoDate(cutoff)
  const nextStartISO = isoDate(next.start)
  const nextEndISO = isoDate(next.end)

  const objsRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name')
    .in('id', objectIds)
  const objectsById = new Map<string, { code: string; current_name: string }>()
  for (const o of (objsRes.data ?? [])) objectsById.set(o.id, o)

  // Один запрос на все task_object_status для этих объектов
  const tosRes = await supabaseAdmin
    .from('task_object_status')
    .select('task_id, object_id, status, done_date')
    .in('object_id', objectIds)
  const tos = (tosRes.data ?? []) as Array<{ task_id: string; object_id: string; status: string; done_date: string | null }>

  // Подгружаем due_date + assignee_entity_id + created_at для среза на period_end.
  // created_at нужен чтобы понять — существовала ли задача на конец периода.
  const taskIds = [...new Set(tos.map((r) => r.task_id))]
  const tasksDue = new Map<string, string | null>()
  const tasksAssignee = new Map<string, string | null>()
  const tasksCreated = new Map<string, string>()
  if (taskIds.length > 0) {
    const tRes = await supabaseAdmin
      .from('tasks')
      .select('id, due_date, assignee_entity_id, created_at')
      .in('id', taskIds)
    for (const t of (tRes.data ?? []) as Array<{ id: string; due_date: string | null; assignee_entity_id: string | null; created_at: string }>) {
      tasksDue.set(t.id, t.due_date)
      tasksAssignee.set(t.id, t.assignee_entity_id)
      tasksCreated.set(t.id, t.created_at)
    }
  }

  // Срез задач на дату cutoff (период_end или today, в зависимости от контекста):
  //   была ли существующая задача активна на эту дату?
  //   срез по: created_at ≤ cutoff AND (status active сейчас OR done_date > cutoff)
  function wasActiveAtCutoff(r: { task_id: string; status: string; done_date: string | null }): boolean {
    const created = tasksCreated.get(r.task_id) ?? ''
    if (created.slice(0, 10) > cutoffISO) return false
    if (r.status === 'open' || r.status === 'in_progress') return true
    // Закрыта/отменена: если закрыта позже cutoff — на cutoff была активна
    if (r.done_date && r.done_date > cutoffISO) return true
    return false
  }

  function wasOverdueAtCutoff(r: { task_id: string; status: string; done_date: string | null }): boolean {
    const due = tasksDue.get(r.task_id)
    if (!due) return false
    if (due >= cutoffISO) return false  // срок ещё не наступал к cutoff
    return wasActiveAtCutoff(r)
  }

  // События-факты по любому из object_ids. После сплита 20260508_* плановые
  // вехи живут в calendar_entries — TODO Phase 4b.
  const evRes = await supabaseAdmin
    .from('events')
    .select('id, object_ids, date_computed, date_end')
    .overlaps('object_ids', objectIds)
  const events = (evRes.data ?? []) as Array<{
    id: string; object_ids: string[];
    date_computed: string | null; date_end: string | null;
  }>

  // Темы за окно ±14 дней
  const windowLo = isoDate(new Date(periodStart.getTime() - 14 * 86400000))
  const windowHi = isoDate(new Date(periodEnd.getTime() + 14 * 86400000))
  const meetingsRes = await supabaseAdmin
    .from('meetings')
    .select('id, meeting_date')
    .gte('meeting_date', windowLo)
    .lte('meeting_date', windowHi)
  const meetingIds = (meetingsRes.data ?? []).map((m) => m.id as string)
  let topicsByObject = new Map<string, number>()
  if (meetingIds.length > 0) {
    const tRes = await supabaseAdmin
      .from('meeting_topics')
      .select('object_ids, status')
      .in('meeting_id', meetingIds)
      .eq('status', 'approved')
    for (const t of (tRes.data ?? []) as Array<{ object_ids: string[] }>) {
      for (const oid of t.object_ids ?? []) {
        if (!objectIds.includes(oid)) continue
        topicsByObject.set(oid, (topicsByObject.get(oid) ?? 0) + 1)
      }
    }
  }

  // Договоры объекта: documents (deleted_at is null) → document_objects (legacy
  // text by object.code) → резолвим через code → object_id. Снапшот сторон
  // приоритетнее legal_entities (исторически точные реквизиты).
  // См. /tasks/stats/page.tsx — та же логика.
  const codeToId = new Map<string, string>()
  for (const o of (objsRes.data ?? [])) codeToId.set(o.code, o.id)
  const objectCodesArr = (objsRes.data ?? []).map((o) => o.code)

  const docsRes = await supabaseAdmin
    .from('documents')
    .select('id, type, title, doc_number, signed_date, customer_entity_id, contractor_entity_id, parties_snapshot, deleted_at')
    .is('deleted_at', null)
  const docs = (docsRes.data ?? []) as Array<{
    id: string; type: string; title: string; doc_number: string | null;
    signed_date: string | null;
    customer_entity_id: string | null; contractor_entity_id: string | null;
    parties_snapshot: { customer?: { name?: string }; contractor?: { name?: string } } | null;
  }>
  const docIds = docs.map((d) => d.id)

  let docObjLinks: Array<{ document_id: string; object_code: string }> = []
  if (docIds.length > 0 && objectCodesArr.length > 0) {
    const linkRes = await supabaseAdmin
      .from('document_objects')
      .select('document_id, object_code')
      .in('document_id', docIds)
      .in('object_code', objectCodesArr)
    docObjLinks = (linkRes.data ?? []) as Array<{ document_id: string; object_code: string }>
  }

  // Имена юр.лиц для fallback (когда snapshot пуст)
  const entityNameById = new Map<string, string>()
  const allEntityIds = [...new Set([
    ...docs.map((d) => d.customer_entity_id).filter((x): x is string => Boolean(x)),
    ...docs.map((d) => d.contractor_entity_id).filter((x): x is string => Boolean(x)),
  ])]
  if (allEntityIds.length > 0) {
    const eRes = await supabaseAdmin
      .from('legal_entities')
      .select('id, name')
      .in('id', allEntityIds)
    for (const e of (eRes.data ?? []) as Array<{ id: string; name: string }>) {
      entityNameById.set(e.id, e.name)
    }
  }

  const docsByObjectId = new Map<string, ContractSummary[]>()
  for (const link of docObjLinks) {
    const oid = codeToId.get(link.object_code)
    if (!oid) continue
    const doc = docs.find((d) => d.id === link.document_id)
    if (!doc) continue
    const customer_name =
      doc.parties_snapshot?.customer?.name ??
      (doc.customer_entity_id ? entityNameById.get(doc.customer_entity_id) ?? null : null)
    const contractor_name =
      doc.parties_snapshot?.contractor?.name ??
      (doc.contractor_entity_id ? entityNameById.get(doc.contractor_entity_id) ?? null : null)
    const summary: ContractSummary = {
      id: doc.id,
      type: doc.type,
      title: doc.title,
      doc_number: doc.doc_number,
      signed_date: doc.signed_date,
      customer_name,
      contractor_name,
      contractor_entity_id: doc.contractor_entity_id,
    }
    if (!docsByObjectId.has(oid)) docsByObjectId.set(oid, [])
    docsByObjectId.get(oid)!.push(summary)
  }
  // Сортируем договоры внутри каждого объекта по signed_date (новые сверху)
  for (const list of docsByObjectId.values()) {
    list.sort((a, b) => (b.signed_date ?? '').localeCompare(a.signed_date ?? ''))
  }

  // helper: count unique task_ids в массиве junction-строк
  const uniqTasks = (rows: Array<{ task_id: string }>): number => new Set(rows.map((r) => r.task_id)).size

  // Сборка по объектам. Срезы на КОНЕЦ ОТЧЁТНОГО ПЕРИОДА (period_end).
  return objectIds.map((oid) => {
    const tosForObj = tos.filter((r) => r.object_id === oid)
    // Закрыто за период: done_date в [start, end]
    const doneRows = tosForObj.filter((r) =>
      ['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO
    )
    const tasks_done = doneRows.length
    const tasks_done_unique = uniqTasks(doneRows)
    // Активна на конец периода (а не «сейчас»)
    const activeAtEnd = tosForObj.filter(wasActiveAtCutoff)
    const tasks_active = activeAtEnd.length
    const tasks_active_unique = uniqTasks(activeAtEnd)
    // Просрочена на конец периода (срок < end И активна на end)
    const overdueRows = tosForObj.filter(wasOverdueAtCutoff)
    const tasks_overdue = overdueRows.length
    const tasks_overdue_unique = uniqTasks(overdueRows)
    // Со сроком в наступающем периоде (для секции «3.x»)
    const dueNextRows = activeAtEnd.filter((r) => {
      const due = tasksDue.get(r.task_id)
      return due && due >= nextStartISO && due <= nextEndISO
    })
    const tasks_due_next = dueNextRows.length
    const tasks_due_next_unique = uniqTasks(dueNextRows)

    const eventsForObj = events.filter((e) => (e.object_ids ?? []).includes(oid))
    // events после сплита — всегда факты. В период попадают по date_computed/date_end в окне.
    const events_in_period = eventsForObj.filter((e) => {
      const d = e.date_computed ?? e.date_end
      return d != null && d >= startISO && d <= endISO
    }).length
    // Плановые срезы (next_period, overdue) — TODO: подтянуть из calendar_entries.
    const events_next_period = 0
    const events_overdue = 0
    void cutoffISO; void nextStartISO; void nextEndISO;

    // Группировка договоров и задач по подрядчику
    const objContracts = docsByObjectId.get(oid) ?? []
    const contractorIds = [...new Set(
      objContracts.map((c) => c.contractor_entity_id).filter((x): x is string => Boolean(x)),
    )]

    const contractors: ContractorGroup[] = contractorIds.map((ceid) => {
      const list = objContracts.filter((c) => c.contractor_entity_id === ceid)
      const cName = list[0]?.contractor_name ?? '—'
      // Per-contractor статистика: задачи объекта где tasks.assignee_entity_id = ceid
      // Все срезы — НА КОНЕЦ ПЕРИОДА (см. wasActiveAtCutoff / wasOverdueAtCutoff)
      const cTasks = tosForObj.filter((r) => tasksAssignee.get(r.task_id) === ceid)
      return {
        contractor_entity_id: ceid,
        contractor_name: cName,
        contracts: list,
        stats: {
          tasks_done: cTasks.filter((r) =>
            ['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO,
          ).length,
          tasks_active: cTasks.filter(wasActiveAtCutoff).length,
          tasks_overdue: cTasks.filter(wasOverdueAtCutoff).length,
        },
      }
    })

    // Блок «Без договора»: задачи где assignee_entity_id NULL или вне contractorIds
    const orphanTasks = tosForObj.filter((r) => {
      const aid = tasksAssignee.get(r.task_id)
      return !aid || !contractorIds.includes(aid)
    })
    if (orphanTasks.length > 0) {
      contractors.push({
        contractor_entity_id: null,
        contractor_name: 'Без договора',
        contracts: [],
        stats: {
          tasks_done: orphanTasks.filter((r) =>
            ['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO,
          ).length,
          tasks_active: orphanTasks.filter(wasActiveAtCutoff).length,
          tasks_overdue: orphanTasks.filter(wasOverdueAtCutoff).length,
        },
      })
    }

    const o = objectsById.get(oid)
    return {
      object_id: oid,
      object_code: o?.code ?? oid.slice(0, 8),
      object_name: o?.current_name ?? '—',
      tasks_done,
      tasks_active,
      tasks_overdue,
      tasks_due_next,
      tasks_done_unique,
      tasks_active_unique,
      tasks_overdue_unique,
      tasks_due_next_unique,
      events_in_period,
      events_next_period,
      events_overdue,
      topics_recent: topicsByObject.get(oid) ?? 0,
      contractors,
    }
  })
}
