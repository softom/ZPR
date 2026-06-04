import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/plots?object_id=<uuid>&unassigned=true&include_inactive=true
 *
 * Список логических земельных участков с опциональными фильтрами:
 *   - object_id:         прямая привязка plots.object_id
 *   - unassigned=true:   только участки без прямой привязки к бизнес-объекту
 *   - include_inactive:  включить деактивированные (по умолчанию active=true)
 *
 * Возвращает { items: [...] } с вложенным functional_objects (если есть).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const objectId = url.searchParams.get('object_id')
  const unassigned = url.searchParams.get('unassigned') === 'true'
  const includeInactive = url.searchParams.get('include_inactive') === 'true'

  let query = supabaseAdmin
    .from('plots')
    .select(`
      id, code, name, role, object_id, functional_object_id,
      permitted_use, category, area_declared_m2, cadastral_number,
      source_pmt_zu, parent_plot_id, active,
      functional_objects(id, zone_code, queue, kind, name)
    `)
    .order('code')

  if (!includeInactive) query = query.eq('active', true)

  if (objectId) {
    query = query.eq('object_id', objectId)
  }
  if (unassigned) {
    query = query.is('object_id', null)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ items: data ?? [] })
}
