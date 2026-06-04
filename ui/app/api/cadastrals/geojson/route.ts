import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cadastrals/geojson?ownership=all&seizure=all
 *
 * GeoJSON из RPC cadastrals_geojson(p_ownership, p_seizure).
 * Возвращает FeatureCollection исходных кадастровых участков,
 * у которых есть связанные plots с геометрией.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ownership = url.searchParams.get('ownership') ?? 'all'
  const seizure = url.searchParams.get('seizure') ?? 'all'

  const { data, error } = await supabaseAdmin.rpc('cadastrals_geojson', {
    p_ownership: ownership,
    p_seizure: seizure,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data ?? { type: 'FeatureCollection', features: [] })
}
