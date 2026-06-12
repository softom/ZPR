/**
 * GET /api/schedule/versions
 *
 * Список версий импортов MS Project с кол-вом задач по каждой.
 * Сортировка: сначала новые.
 */

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('schedule_imports')
    .select('id, version_name, file_name, file_size, project_name, imported_at, imported_by_email, is_active, notes, tasks_total, tasks_inserted, tasks_updated, tasks_unmapped, predecessors_total, xml_content')
    .order('imported_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Кол-во записей calendar_entries per version
  const ids = (data ?? []).map(r => r.id)
  let countMap: Record<string, number> = {}
  if (ids.length > 0) {
    const { data: counts } = await supabaseAdmin
      .from('calendar_entries')
      .select('schedule_version_id')
      .in('schedule_version_id', ids)
    for (const row of counts ?? []) {
      const vid = row.schedule_version_id as string
      countMap[vid] = (countMap[vid] ?? 0) + 1
    }
  }

  const versions = (data ?? []).map(r => ({
    ...r,
    has_xml: r.xml_content !== null,
    xml_content: undefined,  // не отдаём XML в список (может быть большим)
    entry_count: countMap[r.id] ?? 0,
  }))

  return NextResponse.json(versions)
}
