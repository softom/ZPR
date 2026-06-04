import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * POST /api/cadastrals/geometry/fetch
 * Body: { cadastral_number: string }
 *
 * Получает геометрию одного кадастрового участка из ПКК (pkk.rosreestr.ru),
 * нормализует в MultiPolygon и сохраняет в cadastrals.geom.
 *
 * Возвращает:
 *   { status: 'ok', kn, polygons }
 *   { status: 'not_found_pkk', kn }     — ПКК не знает такой КН
 *   { status: 'no_geometry', kn }        — КН найден, но без контура
 *   { status: 'not_found_db', kn }       — КН нет в нашей БД
 *   { status: 'error', kn, error }       — ошибка сети/записи
 */

const PKK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
  Referer: 'https://pkk.rosreestr.ru/',
}

const PKK_TIMEOUT = 25_000

async function fetchFromPKK(cadastralNumber: string): Promise<
  | { ok: true; geometry: any }
  | { ok: false; reason: 'not_found' | 'no_geometry' | 'error'; error?: string }
> {
  try {
    // Шаг 1: поиск по КН
    const searchUrl = `https://pkk.rosreestr.ru/api/features/1?text=${encodeURIComponent(cadastralNumber)}&limit=1&tolerance=4`
    const searchResp = await fetch(searchUrl, {
      headers: PKK_HEADERS,
      signal: AbortSignal.timeout(PKK_TIMEOUT),
    })

    if (!searchResp.ok) {
      return { ok: false, reason: 'error', error: `PKK search HTTP ${searchResp.status}` }
    }

    const searchData = await searchResp.json()
    const features = searchData?.features
    if (!features || features.length === 0) {
      return { ok: false, reason: 'not_found' }
    }

    const featureId = features[0]?.attrs?.id
    if (!featureId) {
      return { ok: false, reason: 'not_found' }
    }

    // Шаг 2: получить полную геометрию
    const geomUrl = `https://pkk.rosreestr.ru/api/features/1/${featureId}`
    const geomResp = await fetch(geomUrl, {
      headers: PKK_HEADERS,
      signal: AbortSignal.timeout(PKK_TIMEOUT),
    })

    if (!geomResp.ok) {
      return { ok: false, reason: 'error', error: `PKK geom HTTP ${geomResp.status}` }
    }

    const geomData = await geomResp.json()
    const geometry = geomData?.feature?.geometry

    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
      return { ok: false, reason: 'no_geometry' }
    }

    return { ok: true, geometry }
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, reason: 'error', error: 'timeout' }
    }
    return { ok: false, reason: 'error', error: String(err?.message || err) }
  }
}

function ensureMultiPolygon(geom: any): any {
  if (geom.type === 'MultiPolygon') return geom
  if (geom.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [geom.coordinates] }
  return null
}

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ status: 'error', kn: '?', error: 'Invalid JSON' }, { status: 400 })
  }

  const kn = body?.cadastral_number
  if (!kn || typeof kn !== 'string') {
    return NextResponse.json({ status: 'error', kn: '?', error: 'cadastral_number required' }, { status: 400 })
  }

  // Проверяем, что КН есть в БД
  const { data: found } = await supabaseAdmin
    .from('cadastrals')
    .select('id')
    .eq('cadastral_number', kn)
    .eq('active', true)
    .limit(1)

  if (!found || found.length === 0) {
    return NextResponse.json({ status: 'not_found_db', kn })
  }

  // Запрос к ПКК
  const pkkResult = await fetchFromPKK(kn)

  if (!pkkResult.ok) {
    return NextResponse.json({
      status: pkkResult.reason === 'not_found' ? 'not_found_pkk' : pkkResult.reason === 'no_geometry' ? 'no_geometry' : 'error',
      kn,
      error: pkkResult.error,
    })
  }

  // Нормализация
  const multiGeom = ensureMultiPolygon(pkkResult.geometry)
  if (!multiGeom) {
    return NextResponse.json({ status: 'error', kn, error: `Unsupported geometry type: ${pkkResult.geometry?.type}` })
  }

  // Запись в БД
  const { error: updateError } = await supabaseAdmin
    .from('cadastrals')
    .update({ geom: JSON.stringify(multiGeom) })
    .eq('id', found[0].id)

  if (updateError) {
    return NextResponse.json({ status: 'error', kn, error: updateError.message })
  }

  const polygonCount = multiGeom.coordinates?.length ?? 0
  return NextResponse.json({ status: 'ok', kn, polygons: polygonCount })
}
