/**
 * GET /api/schedule/gantt
 *
 * Read-only датасет активной версии графика для DHTMLX Gantt (Community/MIT).
 *
 * Поток:
 *   1. Активная версия = schedule_imports WHERE is_active=true.
 *   2. calendar_entries этой версии (фильтр schedule_version_id),
 *      исключая outline_level 0/NULL (строки-разделители MS Project — они
 *      ломают иерархию, как и в exportMspdi.ts).
 *   3. calendar_predecessors — постранично по 1000 (PostgREST режет ответ
 *      жёстким cap-ом 1000), фильтр обеих сторон связи по idSet версии.
 *   4. Мапперы из lib/schedule/ganttModel.ts → { data: GanttTask[], links: GanttLink[] }.
 *
 * ВАЖНО: read-only. Ничего не пишет в БД (в отличие от export, который back-fill-ит
 * mspdi_uid). Контракт сохранения экспорта не затрагивается.
 */

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  entryToGanttTask,
  predToGanttLink,
  type CalendarEntryRow,
  type PredecessorRow,
  type GanttTask,
  type GanttLink,
} from '@/lib/schedule/ganttModel'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Колонки calendar_entries для рендера. Намеренно БЕЗ mspdi_passthrough —
// для гантта он не нужен (CalendarEntryRow его не содержит).
const ENTRY_COLUMNS = `
  id, mspdi_uid, mspdi_id, title, outline_level, outline_number, parent_entry_id,
  is_summary, is_project_wide, task_mode, date_start, date_end, percent_complete,
  mspdi_notes, mspdi_duration, schedule_raw_text, object_ids, entry_type
` as const

export async function GET() {
  try {
    // 1. Активная версия.
    const { data: activeImp, error: impErr } = await supabaseAdmin
      .from('schedule_imports')
      .select('id')
      .eq('is_active', true)
      .maybeSingle()
    if (impErr) {
      return NextResponse.json({ error: `schedule_imports select: ${impErr.message}` }, { status: 500 })
    }
    const versionId = activeImp?.id ?? null
    if (!versionId) {
      // Нет активной версии — пустой датасет (UI рисует пустой гантт).
      return NextResponse.json({ data: [], links: [] })
    }

    // 2. calendar_entries активной версии. outline_level 0/NULL —
    //    строки-разделители MS Project, не рендерим (как в exportMspdi.ts).
    const { data: entries, error: entriesErr } = await supabaseAdmin
      .from('calendar_entries')
      .select(ENTRY_COLUMNS)
      .eq('schedule_version_id', versionId)
      .not('outline_level', 'is', null)
      .neq('outline_level', 0)
    if (entriesErr) {
      return NextResponse.json({ error: `calendar_entries select: ${entriesErr.message}` }, { status: 500 })
    }

    const rows = (entries ?? []) as CalendarEntryRow[]
    if (rows.length === 0) {
      return NextResponse.json({ data: [], links: [] })
    }

    const idSet = new Set(rows.map(r => r.id))

    // 3. Предшественники — постранично по 1000 (PostgREST cap), как в exportMspdi.ts.
    //    Селектим всё и фильтруем в JS: .in() с сотнями UUID превышает лимит URL.
    const allPreds: PredecessorRow[] = []
    for (let from = 0; ; from += 1000) {
      const { data: page, error: pErr } = await supabaseAdmin
        .from('calendar_predecessors')
        .select('calendar_id, predecessor_id, link_type, lag, lag_type')
        .range(from, from + 999)
      if (pErr) {
        return NextResponse.json({ error: `calendar_predecessors select: ${pErr.message}` }, { status: 500 })
      }
      if (!page || page.length === 0) break
      allPreds.push(...(page as PredecessorRow[]))
      if (page.length < 1000) break
    }

    // 4. Мапперы → DHTMLX датасет.
    //    Связь оставляем только если обе стороны входят в видимый набор задач
    //    (иначе DHTMLX даст висячую стрелку на несуществующий id).
    const data: GanttTask[] = rows.map(entryToGanttTask)
    // Перепривязка висячих родителей: если parent указывает на отфильтрованную
    // строку-разделитель (outline_level 0/NULL), DHTMLX не отрендерит узел —
    // поднимаем такую задачу к корню '0'.
    for (const t of data) {
      if (t.parent !== '0' && !idSet.has(t.parent)) t.parent = '0'
    }
    const links: GanttLink[] = allPreds
      .filter(p => idSet.has(p.calendar_id) && idSet.has(p.predecessor_id))
      .map(predToGanttLink)

    return NextResponse.json({ data, links })
  } catch (e) {
    console.error('[schedule/gantt] failed', e)
    return NextResponse.json(
      { error: `Загрузка гантта упала: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}
