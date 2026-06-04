import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// GET /api/reports/map/geojson — общие GIS-данные для всех отчётов:
//   • boundary — граница проекта (Polygon)
//   • features — функциональные объекты со связанными objects[]
// Используется компонентом <ObjectSchema> для рендера SVG-схемы
// (общий план комплекса + выделение текущего объекта красным).
export async function GET() {
  const [boundary, features] = await Promise.all([
    supabaseAdmin.rpc('project_boundary_geojson'),
    supabaseAdmin.rpc('functional_objects_geojson', { p_kind: 'all' }),
  ])

  if (boundary.error) {
    return NextResponse.json({ error: `boundary: ${boundary.error.message}` }, { status: 500 })
  }
  if (features.error) {
    return NextResponse.json({ error: `features: ${features.error.message}` }, { status: 500 })
  }

  // project_boundary_geojson() возвращает FeatureCollection — извлекаем
  // первую (и единственную) геометрию для удобства SVG-компонента.
  type GeoJSONFC = { features?: Array<{ geometry?: unknown }> }
  const bdData = boundary.data as GeoJSONFC | null
  const boundaryGeom = (bdData?.features?.[0]?.geometry ?? null) as unknown

  return NextResponse.json({
    boundary: boundaryGeom,
    features: features.data,
  })
}
