import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  isoDate, snapToPeriodStart, periodEnd as periodEndFn,
  type PeriodType,
} from '@/lib/reports/periodHelpers'

// GET /api/stats/details?type=week|month&start=YYYY-MM-DD&category=...
//
// category ∈ {
//   tasks_done       — задачи закрытые в период (по task_object_status.done_date)
//   tasks_active     — активные на cutoff (по тем же правилам что в buildStatsForPeriod)
//   tasks_overdue    — просроченные на cutoff
//   events           — события состоявшиеся в период
//   topics           — темы собраний за окно ±14 дней
// }
//
// Возвращает плоский список items с object_codes для каждого пункта.

const CATEGORIES = ['tasks_done', 'tasks_active', 'tasks_overdue', 'events', 'topics'] as const
type Category = typeof CATEGORIES[number]

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const typeRaw = url.searchParams.get('type') ?? 'week'
  const cat = url.searchParams.get('category') as Category | null
  if (typeRaw !== 'week' && typeRaw !== 'month') {
    return NextResponse.json({ error: 'type должен быть week|month' }, { status: 400 })
  }
  if (!cat || !(CATEGORIES as readonly string[]).includes(cat)) {
    return NextResponse.json({ error: `category должен быть одним из ${CATEGORIES.join('|')}` }, { status: 400 })
  }
  const periodType = typeRaw as PeriodType
  const startRaw = url.searchParams.get('start') ?? new Date().toISOString().slice(0, 10)
  const periodStart = snapToPeriodStart(startRaw, periodType)
  const periodEndDate = periodEndFn(periodStart, periodType)
  const startISO = isoDate(periodStart)
  const endISO = isoDate(periodEndDate)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cutoffISO = today < periodEndDate ? isoDate(today) : endISO

  // Активные объекты — для фильтра
  const objsRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name')
    .eq('active', true)
  const objectsById = new Map<string, { code: string; current_name: string }>()
  const activeObjectIds: string[] = []
  for (const o of (objsRes.data ?? []) as Array<{ id: string; code: string; current_name: string }>) {
    objectsById.set(o.id, { code: o.code, current_name: o.current_name })
    activeObjectIds.push(o.id)
  }
  if (activeObjectIds.length === 0) return NextResponse.json({ items: [] })

  if (cat === 'events') {
    const evRes = await supabaseAdmin
      .from('events')
      .select('id, title, event_type, date_computed, date_end, note, object_ids')
      .overlaps('object_ids', activeObjectIds)
      .order('date_computed', { ascending: true, nullsFirst: false })
    const items: Array<Record<string, unknown>> = []
    for (const ev of (evRes.data ?? []) as Array<{
      id: string; title: string; event_type: string; date_computed: string | null;
      date_end: string | null; note: string | null; object_ids: string[]
    }>) {
      const d = ev.date_computed ?? ev.date_end
      if (!d || d < startISO || d > endISO) continue
      items.push({
        id: ev.id,
        title: ev.title,
        subtitle: [ev.event_type, d ? `дата ${d}` : null, ev.note].filter(Boolean).join(' · '),
        object_codes: (ev.object_ids ?? []).map((oid) => objectsById.get(oid)?.code).filter(Boolean),
        link: `/events/${ev.id}`,
      })
    }
    return NextResponse.json({ items })
  }

  if (cat === 'topics') {
    const lo = isoDate(new Date(periodStart.getTime() - 14 * 86400000))
    const hi = isoDate(new Date(periodEndDate.getTime() + 14 * 86400000))
    const mRes = await supabaseAdmin
      .from('meetings')
      .select('id, meeting_date, title')
      .gte('meeting_date', lo)
      .lte('meeting_date', hi)
    const meetingById = new Map<string, { date: string; title: string }>()
    for (const m of (mRes.data ?? []) as Array<{ id: string; meeting_date: string; title: string }>) {
      meetingById.set(m.id, { date: m.meeting_date, title: m.title })
    }
    if (meetingById.size === 0) return NextResponse.json({ items: [] })

    const tRes = await supabaseAdmin
      .from('meeting_topics')
      .select('id, title, content, raised_by_org, meeting_id, object_ids, status')
      .in('meeting_id', [...meetingById.keys()])
      .eq('status', 'approved')
      .order('seq')
    const items: Array<Record<string, unknown>> = []
    for (const t of (tRes.data ?? []) as Array<{
      id: string; title: string; content: string; raised_by_org: string | null;
      meeting_id: string; object_ids: string[]
    }>) {
      const objs = (t.object_ids ?? []).filter((oid) => activeObjectIds.includes(oid))
      if (objs.length === 0) continue
      const m = meetingById.get(t.meeting_id)
      items.push({
        id: t.id,
        title: t.title,
        subtitle: [m ? `собрание ${m.date}` : null, t.raised_by_org].filter(Boolean).join(' · '),
        object_codes: objs.map((oid) => objectsById.get(oid)?.code).filter(Boolean),
        link: m ? `/protocols/${t.meeting_id}` : null,
      })
    }
    return NextResponse.json({ items })
  }

  // tasks_*: запрос task_object_status и tasks
  const tosRes = await supabaseAdmin
    .from('task_object_status')
    .select('task_id, object_id, status, done_date')
    .in('object_id', activeObjectIds)
  const tos = (tosRes.data ?? []) as Array<{ task_id: string; object_id: string; status: string; done_date: string | null }>
  if (tos.length === 0) return NextResponse.json({ items: [] })

  const taskIds = [...new Set(tos.map((r) => r.task_id))]
  const tRes = await supabaseAdmin
    .from('tasks')
    .select('id, code, title, assignee_org, due_date, created_at, object_ids')
    .in('id', taskIds)
  const taskById = new Map<string, {
    id: string; code: string; title: string; assignee_org: string | null;
    due_date: string | null; created_at: string; object_ids: string[]
  }>()
  for (const t of (tRes.data ?? []) as Array<{
    id: string; code: string; title: string; assignee_org: string | null;
    due_date: string | null; created_at: string; object_ids: string[]
  }>) {
    taskById.set(t.id, t)
  }

  // Группируем подходящие пары (task, object) по task_id.
  // pair_count = всего пар (соответствует счётчику на главной плитке).
  // items = по уникальным задачам, в чипах — только те объекты, на которых
  // задача реально попадает в категорию (не все object_ids задачи).
  const matchedObjectsByTask = new Map<string, string[]>()
  let pairCount = 0
  for (const r of tos) {
    const t = taskById.get(r.task_id)
    if (!t) continue

    let matches = false
    if (cat === 'tasks_done') {
      matches = ['done', 'closed'].includes(r.status)
        && !!r.done_date && r.done_date >= startISO && r.done_date <= endISO
    } else {
      // active/overdue: cutoff-логика
      const created = (t.created_at ?? '').slice(0, 10)
      if (created > cutoffISO) continue
      let active = false
      if (r.status === 'open' || r.status === 'in_progress') active = true
      else if (r.done_date && r.done_date > cutoffISO) active = true
      if (!active) continue

      if (cat === 'tasks_active') {
        matches = true
      } else if (cat === 'tasks_overdue') {
        matches = !!t.due_date && t.due_date < cutoffISO
      }
    }

    if (matches) {
      pairCount += 1
      const list = matchedObjectsByTask.get(r.task_id) ?? []
      list.push(r.object_id)
      matchedObjectsByTask.set(r.task_id, list)
    }
  }

  const items: Array<Record<string, unknown>> = []
  for (const [tid, matchedObjectIds] of matchedObjectsByTask.entries()) {
    const t = taskById.get(tid)!
    const subtitleParts: string[] = []
    if (t.assignee_org) subtitleParts.push(t.assignee_org)
    if (t.due_date) subtitleParts.push(`срок ${t.due_date}`)
    if (cat === 'tasks_done') {
      const tos_for_task = tos.filter((r) =>
        r.task_id === tid
        && ['done', 'closed'].includes(r.status)
        && r.done_date && r.done_date >= startISO && r.done_date <= endISO,
      )
      const dd = tos_for_task[0]?.done_date
      if (dd) subtitleParts.push(`закрыто ${dd}`)
    }
    items.push({
      id: t.id,
      code: t.code,
      title: t.title,
      subtitle: subtitleParts.join(' · '),
      // Только объекты, на которых задача попала в категорию
      object_codes: matchedObjectIds.map((oid) => objectsById.get(oid)?.code).filter(Boolean),
      link: `/tasks?focus=${t.id}`,
    })
  }
  // Сортируем по subtitle (заодно — по сроку/дате закрытия)
  items.sort((a, b) => {
    const ax = (a.subtitle as string) || ''
    const bx = (b.subtitle as string) || ''
    return ax.localeCompare(bx)
  })

  return NextResponse.json({
    items,
    task_count: items.length,
    pair_count: pairCount,
  })
}
