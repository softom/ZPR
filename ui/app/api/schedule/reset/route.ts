/**
 * POST /api/schedule/reset
 *
 * Удаляет все импортированные из MS Project XML данные:
 *   - calendar_entries c mspdi_uid IS NOT NULL
 *   - связанные calendar_predecessors (CASCADE FK от calendar_entries)
 *   - entity_links calendar_entry → object/legal_entity для затронутых
 *   - schedule_imports — вся история
 *
 * НЕ удаляет:
 *   - objects, schedule_object_mapping (маппинги переиспользуются),
 *     договорные/иные calendar_entries (без mspdi_uid).
 *
 * Body (опц., JSON):
 *   { withMappings?: boolean }    // если true — стереть и маппинги
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  let withMappings = false
  try {
    const body = (await request.json().catch(() => null)) as { withMappings?: boolean } | null
    withMappings = Boolean(body?.withMappings)
  } catch {
    // нет тела — норма
  }

  console.log(`[schedule/reset] starting (withMappings=${withMappings})`)

  // 1. Список UUID импортированных задач (нужен для удаления entity_links)
  const { data: idsRows, error: idsErr } = await supabaseAdmin
    .from('calendar_entries')
    .select('id')
    .not('mspdi_uid', 'is', null)
  if (idsErr) {
    return NextResponse.json({ error: `select impacted ids: ${idsErr.message}` }, { status: 500 })
  }
  const ids = (idsRows ?? []).map(r => r.id as string)

  let deletedLinks = 0
  let deletedPredecessors = 0
  let deletedEntries = 0
  let deletedImports = 0
  let deletedMappings = 0

  // 2. entity_links calendar_entry → * для этих задач
  if (ids.length > 0) {
    // .in() с тысячами UUID может «не влезть» в URL → разбиваем на батчи
    const BATCH = 200
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      const { count, error } = await supabaseAdmin
        .from('entity_links')
        .delete({ count: 'exact' })
        .eq('from_type', 'calendar_entry')
        .in('from_id', batch)
      if (error) console.warn(`[reset] entity_links delete batch ${i / BATCH}: ${error.message}`)
      else deletedLinks += count ?? 0
    }
  }

  // 3. calendar_predecessors — каскад от calendar_entries, но удалим явно для подсчёта
  if (ids.length > 0) {
    const BATCH = 200
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      const { count, error } = await supabaseAdmin
        .from('calendar_predecessors')
        .delete({ count: 'exact' })
        .in('calendar_id', batch)
      if (error) console.warn(`[reset] predecessors batch ${i / BATCH}: ${error.message}`)
      else deletedPredecessors += count ?? 0
    }
  }

  // 4. calendar_entries
  {
    const { count, error } = await supabaseAdmin
      .from('calendar_entries')
      .delete({ count: 'exact' })
      .not('mspdi_uid', 'is', null)
    if (error) return NextResponse.json({ error: `delete calendar_entries: ${error.message}` }, { status: 500 })
    deletedEntries = count ?? 0
  }

  // 5. schedule_imports
  {
    const { count, error } = await supabaseAdmin
      .from('schedule_imports')
      .delete({ count: 'exact' })
      .not('id', 'is', null)
    if (error) console.warn(`[reset] schedule_imports: ${error.message}`)
    else deletedImports = count ?? 0
  }

  // 6. По желанию — маппинги
  if (withMappings) {
    const { count, error } = await supabaseAdmin
      .from('schedule_object_mapping')
      .delete({ count: 'exact' })
      .not('id', 'is', null)
    if (error) console.warn(`[reset] mappings: ${error.message}`)
    else deletedMappings = count ?? 0
  }

  const result = {
    deleted: {
      calendarEntries: deletedEntries,
      predecessors: deletedPredecessors,
      entityLinks: deletedLinks,
      scheduleImports: deletedImports,
      mappings: deletedMappings,
    },
    withMappings,
  }
  console.log('[schedule/reset] done', result)
  return NextResponse.json(result)
}
