import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = new Set(['all', 'plot', 'servitude'])

/**
 * GET /api/plots/geojson?role=plot|servitude|all
 *
 * Возвращает GeoJSON из ЦЕЛЕВОЙ модели (v_plots_current + functional_objects +
 * objects + pmt_oks). Multi-part собран в один Feature. Каждый feature содержит
 * `object_code`/`object_color` для раскраски по бизнес-объекту ЗПР и массив `oks`
 * с этажностью/ёмкостью.
 *
 * Реализация — RPC `public.plots_geojson(p_role)` (миграция 20260519010015).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const role = url.searchParams.get('role') ?? 'all'

  if (!ALLOWED_ROLES.has(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${[...ALLOWED_ROLES].join(', ')}` },
      { status: 400 }
    )
  }

  const { data, error } = await supabaseAdmin.rpc('plots_geojson', { p_role: role })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data ?? { type: 'FeatureCollection', features: [] })
}
