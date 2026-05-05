// Расчёт количественных показателей секции отчёта (одного объекта).
// Используется в UI карточки и в LLM-промпте сводки по проекту.

import { supabaseAdmin } from '@/lib/supabase-admin'
import { isoDate, nextPeriod, type PeriodType } from './periodHelpers'

export type SectionStats = {
  tasks_done: number
  tasks_active: number
  tasks_overdue: number
  tasks_due_next: number
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

// Подсчёт показателей для всех объектов отчёта одним батчем (для UI и summary).
export async function buildAllSectionStats(
  reportId: string,
  periodType: PeriodType,
  periodStart: Date,
  periodEnd: Date,
): Promise<SectionStatsWithObject[]> {
  const next = nextPeriod(periodEnd, periodType)
  const startISO = isoDate(periodStart)
  const endISO = isoDate(periodEnd)
  const nextStartISO = isoDate(next.start)
  const nextEndISO = isoDate(next.end)
  // todayISO больше не используется — все срезы делаем на endISO (конец отчётного периода)
  // (если потребуется в каких-то метриках — раскомментировать)
  // const todayISO = isoDate(new Date())

  // Список объектов отчёта (через object_reports → objects)
  const sectionsRes = await supabaseAdmin
    .from('object_reports')
    .select('object_id')
    .eq('report_id', reportId)
  const objectIds = (sectionsRes.data ?? []).map((s) => s.object_id as string)
  if (objectIds.length === 0) return []

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

  // Срез задач на конец периода (а не «сейчас»):
  //   была ли существующая задача активна на дату endISO?
  //   срез по: created_at ≤ endISO AND (status active сейчас OR done_date > endISO)
  function wasActiveAtEnd(r: { task_id: string; status: string; done_date: string | null }): boolean {
    const created = tasksCreated.get(r.task_id) ?? ''
    // created_at в БД — timestamptz, сравниваем с endISO как 'YYYY-MM-DD':
    // строковое сравнение работает (ISO-формат). endISO трактуем как конец дня
    // через сравнение «<= endISO» на дате part-of-timestamp.
    if (created.slice(0, 10) > endISO) return false
    if (r.status === 'open' || r.status === 'in_progress') return true
    // Закрыта/отменена: если закрыта позже периода — на конец периода была активна
    if (r.done_date && r.done_date > endISO) return true
    return false
  }

  function wasOverdueAtEnd(r: { task_id: string; status: string; done_date: string | null }): boolean {
    const due = tasksDue.get(r.task_id)
    if (!due) return false
    if (due >= endISO) return false  // срок ещё не наступал к концу периода
    return wasActiveAtEnd(r)
  }

  // События по любому из object_ids (один запрос)
  const evRes = await supabaseAdmin
    .from('events')
    .select('id, object_ids, fact_date, date_computed, date_end, is_planned')
    .overlaps('object_ids', objectIds)
  const events = (evRes.data ?? []) as Array<{
    id: string; object_ids: string[]; fact_date: string | null;
    date_computed: string | null; date_end: string | null; is_planned: boolean
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

  // Сборка по объектам. Срезы на КОНЕЦ ОТЧЁТНОГО ПЕРИОДА (period_end).
  return objectIds.map((oid) => {
    const tosForObj = tos.filter((r) => r.object_id === oid)
    // Закрыто за период: done_date в [start, end]
    const tasks_done = tosForObj.filter((r) =>
      ['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO
    ).length
    // Активна на конец периода (а не «сейчас»)
    const activeAtEnd = tosForObj.filter(wasActiveAtEnd)
    const tasks_active = activeAtEnd.length
    // Просрочена на конец периода (срок < end И активна на end)
    const tasks_overdue = tosForObj.filter(wasOverdueAtEnd).length
    // Со сроком в наступающем периоде (для секции «3.x») — берём из активных-на-end,
    // проверяем due_date в окне next_period
    const tasks_due_next = activeAtEnd.filter((r) => {
      const due = tasksDue.get(r.task_id)
      return due && due >= nextStartISO && due <= nextEndISO
    }).length

    const eventsForObj = events.filter((e) => (e.object_ids ?? []).includes(oid))
    const events_in_period = eventsForObj.filter((e) => {
      const factD = e.fact_date
      const planD = e.date_computed ?? e.date_end
      if (factD && factD >= startISO && factD <= endISO) return true
      if (!factD && planD && planD >= startISO && planD <= endISO) return true
      return false
    }).length
    const events_next_period = eventsForObj.filter((e) => {
      const planD = e.date_computed ?? e.date_end
      return !e.fact_date && planD && planD >= nextStartISO && planD <= nextEndISO
    }).length
    // Просрочено НА КОНЕЦ ПЕРИОДА: план < end И факта нет к концу периода
    // (если факт есть, но позже end — на конец периода тоже не было)
    const events_overdue = eventsForObj.filter((e) => {
      const planD = e.date_computed ?? e.date_end
      if (!planD || planD >= endISO) return false
      if (!e.is_planned) return false
      const fact = e.fact_date
      return !fact || fact > endISO
    }).length

    // Группировка договоров и задач по подрядчику
    const objContracts = docsByObjectId.get(oid) ?? []
    const contractorIds = [...new Set(
      objContracts.map((c) => c.contractor_entity_id).filter((x): x is string => Boolean(x)),
    )]

    const contractors: ContractorGroup[] = contractorIds.map((ceid) => {
      const list = objContracts.filter((c) => c.contractor_entity_id === ceid)
      const cName = list[0]?.contractor_name ?? '—'
      // Per-contractor статистика: задачи объекта где tasks.assignee_entity_id = ceid
      // Все срезы — НА КОНЕЦ ПЕРИОДА (см. wasActiveAtEnd / wasOverdueAtEnd)
      const cTasks = tosForObj.filter((r) => tasksAssignee.get(r.task_id) === ceid)
      return {
        contractor_entity_id: ceid,
        contractor_name: cName,
        contracts: list,
        stats: {
          tasks_done: cTasks.filter((r) =>
            ['done', 'closed'].includes(r.status) && r.done_date && r.done_date >= startISO && r.done_date <= endISO,
          ).length,
          tasks_active: cTasks.filter(wasActiveAtEnd).length,
          tasks_overdue: cTasks.filter(wasOverdueAtEnd).length,
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
          tasks_active: orphanTasks.filter(wasActiveAtEnd).length,
          tasks_overdue: orphanTasks.filter(wasOverdueAtEnd).length,
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
      events_in_period,
      events_next_period,
      events_overdue,
      topics_recent: topicsByObject.get(oid) ?? 0,
      contractors,
    }
  })
}
