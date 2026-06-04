import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

const ALLOWED_KINDS = new Set(['all', 'участок', 'контур', 'сервитут'])

/**
 * GET /api/pmt/geojson?kind=участок|контур|сервитут|all
 *
 * Возвращает GeoJSON FeatureCollection (EPSG:4326) — все ЗУ из стейджинга.
 * Реализация — RPC `public.pmt_zu_geojson(p_kind text)`:
 *   1) точки из pmt_zu_points группируются по `zu` (сортировка по point_n::int),
 *   2) собирается WKT POLYGON с замыканием в OGC порядке (Y X),
 *   3) ST_GeomFromText(..., 970634) → ST_Transform → EPSG:4326,
 *   4) ST_AsGeoJSON → Feature; всё в FeatureCollection.
 *
 * Невалидные геометрии (Self-intersection) отфильтрованы внутри RPC.
 *
 * Используется в /plots/map для отображения карты на OSM-подложке.
 * См. миграцию `20260519010011_pmt_zu_geojson_rpc.sql`.
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

  const { data, error } = await supabaseAdmin.rpc('pmt_zu_geojson', { p_kind: kind })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data ?? { type: 'FeatureCollection', features: [] })
}
