/**
 * POST /api/schedule/delete-orphans
 *
 * Удаляет конкретные calendar_entries (по списку UUID) и связанные с ними
 * entity_links + calendar_predecessors.
 *
 * Body: { ids: string[] }   — список UUID задач для удаления
 *
 * Назначение: после импорта пользователь видит список «осиротевших» —
 * задач, которые были в БД, но отсутствуют в новом XML. Если правки в БД
 * нужно сохранить — пользователь подтверждает удаление этого списка.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  let body: { ids?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const ids = (body.ids ?? []).filter(Boolean)
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids[] обязателен и не пуст' }, { status: 400 })
  }

  const BATCH = 200
  let deletedLinks = 0
  let deletedPredecessors = 0
  let deletedEntries = 0

  // 1. entity_links для этих задач
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const { count, error } = await supabaseAdmin
      .from('entity_links')
      .delete({ count: 'exact' })
      .eq('from_type', 'calendar_entry')
      .in('from_id', batch)
    if (error) console.warn(`[delete-orphans] entity_links: ${error.message}`)
    else deletedLinks += count ?? 0
  }

  // 2. predecessors (CASCADE FK тоже сработает, но явный DELETE даст счёт)
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const { count, error } = await supabaseAdmin
      .from('calendar_predecessors')
      .delete({ count: 'exact' })
      .in('calendar_id', batch)
    if (error) console.warn(`[delete-orphans] predecessors: ${error.message}`)
    else deletedPredecessors += count ?? 0
  }

  // 3. сами задачи
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const { count, error } = await supabaseAdmin
      .from('calendar_entries')
      .delete({ count: 'exact' })
      .in('id', batch)
    if (error) return NextResponse.json({ error: `calendar_entries delete: ${error.message}` }, { status: 500 })
    deletedEntries += count ?? 0
  }

  console.log(`[delete-orphans] ${deletedEntries} entries, ${deletedPredecessors} preds, ${deletedLinks} links`)
  return NextResponse.json({
    deleted: {
      calendarEntries: deletedEntries,
      predecessors: deletedPredecessors,
      entityLinks: deletedLinks,
    },
  })
}
