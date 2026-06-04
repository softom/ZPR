import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cadastrals/geometry/stats
 * → handled below via ?action=stats
 *
 * POST /api/cadastrals/geometry
 * Body: { cadastral_number: string, geometry: GeoJSON }        — single
 *   or: { features: [{cadastral_number, geometry}, ...] }      — batch
 *   or: { type: "FeatureCollection", features: [...] }         — GeoJSON FC
 *
 * Записывает геометрию в cadastrals.geom (MultiPolygon, 4326).
 */

function ensureMultiPolygon(geom: any): any {
  if (!geom || !geom.type) return null
  if (geom.type === 'MultiPolygon') return geom
  if (geom.type === 'Polygon') {
    return { type: 'MultiPolygon', coordinates: [geom.coordinates] }
  }
  return null
}

/** GET — статистика по геометрии кадастров */
export async function GET() {
  const { data, error } = await supabaseAdmin.rpc('cadastrals_geom_stats')

  // Если RPC не существует, считаем вручную
  if (error) {
    const { data: all } = await supabaseAdmin
      .from('cadastrals')
      .select('id, cadastral_number, geom')
      .eq('active', true)

    const total = all?.length ?? 0
    const withGeom = all?.filter((r: any) => r.geom != null).length ?? 0
    return NextResponse.json({ total, with_geom: withGeom, without_geom: total - withGeom })
  }

  return NextResponse.json(data)
}

/** POST — загрузка геометрии (одна или batch) */
export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Нормализация входных данных в массив {cadastral_number, geometry}
  type GeomEntry = { cadastral_number: string; geometry: any }
  const entries: GeomEntry[] = []

  if (body.type === 'FeatureCollection' && Array.isArray(body.features)) {
    // GeoJSON FeatureCollection
    for (const feat of body.features) {
      const kn = feat.id || feat.properties?.cadastral_number
      const geom = feat.geometry
      if (kn && geom) entries.push({ cadastral_number: kn, geometry: geom })
    }
  } else if (Array.isArray(body.features)) {
    // Batch: {features: [{cadastral_number, geometry}]}
    for (const f of body.features) {
      if (f.cadastral_number && f.geometry) entries.push(f)
    }
  } else if (body.cadastral_number && body.geometry) {
    // Single: {cadastral_number, geometry}
    entries.push({ cadastral_number: body.cadastral_number, geometry: body.geometry })
  } else if (typeof body === 'object' && !body.type) {
    // Dict: {"90:18:...": {geometry}, ...}
    for (const [kn, geom] of Object.entries(body)) {
      if (typeof geom === 'object' && (geom as any)?.type) {
        entries.push({ cadastral_number: kn, geometry: geom })
      }
    }
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { error: 'No geometry entries found. Expected FeatureCollection, {cadastral_number, geometry}, or {kn: geometry} format.' },
      { status: 400 },
    )
  }

  // Обработка
  const results: { kn: string; status: 'ok' | 'not_found' | 'invalid' | 'error'; error?: string }[] = []

  for (const entry of entries) {
    const geom = ensureMultiPolygon(entry.geometry)
    if (!geom) {
      results.push({ kn: entry.cadastral_number, status: 'invalid', error: `Unsupported type: ${entry.geometry?.type}` })
      continue
    }

    // Найти кадастр по номеру
    const { data: found } = await supabaseAdmin
      .from('cadastrals')
      .select('id')
      .eq('cadastral_number', entry.cadastral_number)
      .eq('active', true)
      .limit(1)

    if (!found || found.length === 0) {
      results.push({ kn: entry.cadastral_number, status: 'not_found' })
      continue
    }

    // Записать геометрию
    const { error: updateError } = await supabaseAdmin
      .from('cadastrals')
      .update({ geom: JSON.stringify(geom) })
      .eq('id', found[0].id)

    if (updateError) {
      results.push({ kn: entry.cadastral_number, status: 'error', error: updateError.message })
    } else {
      results.push({ kn: entry.cadastral_number, status: 'ok' })
    }
  }

  const okCount = results.filter(r => r.status === 'ok').length
  return NextResponse.json({
    total: entries.length,
    ok: okCount,
    failed: entries.length - okCount,
    results,
  })
}
