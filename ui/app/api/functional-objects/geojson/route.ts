import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

const ALLOWED_KINDS = new Set([
  'all',
  'hotel',
  'transit_hotel',
  'sport_entertainment',
  'food',
  'transport_infra',
  'utility',
  'promenade',
  'energy',
  'other',
])

/**
 * GET /api/functional-objects/geojson?kind=hotel|all|...
 *
 * Возвращает GeoJSON функциональных зон ППТ. Геометрия зоны — ST_Union участков
 * с одинаковым functional_object_id. Атрибуты: pmt_zone_params + pmt_oks + objects.
 *
 * Реализация — RPC `public.functional_objects_geojson(p_kind)` (миграция 20260519010016).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') ?? 'all'

  if (!ALLOWED_KINDS.has(kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${[...ALLOWED_KINDS].join(', ')}` },
      { status: 400 }
    )
  }

  const { data, error } = await supabaseAdmin.rpc('functional_objects_geojson', { p_kind: kind })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data ?? { type: 'FeatureCollection', features: [] })
}
