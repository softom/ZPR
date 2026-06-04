/**
 * GET /api/schedule/imports — история импортов MSPDI
 *
 * Query: ?limit=50 (default), ?offset=0
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)

  const { data, error } = await supabaseAdmin
    .from('schedule_imports')
    .select(
      `id, file_name, file_size, project_name, project_start_date, project_finish_date,
       object_field, mspdi_uid_max, tasks_total, tasks_inserted, tasks_updated,
       tasks_unmapped, predecessors_total, notes, imported_by_email, imported_at`,
    )
    .order('imported_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ imports: data ?? [] })
}
