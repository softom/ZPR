'use client'

// SVG-схема комплекса для печатной формы отчёта.
// Рендерит общий план: граница проекта + все функциональные объекты.
// Текущий объект (по targetObjectCode) выделяется красным.
// Без OSM-фона — это техническая схема, не карта.

type LngLat = [number, number]                  // [lon, lat]
type Ring = LngLat[]                            // outer/inner ring
type Polygon = { type: 'Polygon'; coordinates: Ring[] }
type MultiPolygon = { type: 'MultiPolygon'; coordinates: Ring[][] }
type Geometry = Polygon | MultiPolygon

type ObjectRef = { id: string; code: string; name: string; color?: string | null }

export type GeoFeature = {
  type: 'Feature'
  id?: string
  geometry: Geometry
  properties: {
    zone_code?: string
    zone_name?: string
    kind?: string
    area_calc_m2?: number
    objects?: ObjectRef[]
    [k: string]: unknown
  }
}

export type MapGeoData = {
  boundary: Geometry | null   // граница проекта (Polygon/MultiPolygon)
  features: { type: 'FeatureCollection'; features: GeoFeature[] } | null
}

// Суммарная площадь участков объекта (м²). Возвращает 0 если связи нет.
// Для МАСТЕРПЛАН — площадь не считаем (это весь проект, не отдельный участок).
export function getObjectAreaM2(geoData: MapGeoData | null, targetObjectCode: string): number {
  if (!geoData?.features?.features) return 0
  if (/МАСТЕРПЛАН/i.test(targetObjectCode)) return 0
  let sum = 0
  for (const f of geoData.features.features) {
    const codes = (f.properties?.objects ?? []).map((o) => o.code)
    if (codes.includes(targetObjectCode)) {
      sum += Number(f.properties?.area_calc_m2) || 0
    }
  }
  return sum
}

type Props = {
  targetObjectCode: string
  targetObjectName?: string | null
  geoData: MapGeoData
  // Размеры SVG в px (для печати — fit к ширине страницы)
  width?: number
  height?: number
}

// Линейная проекция lon/lat → SVG-координаты с правильным aspect ratio.
function buildProjector(bbox: [number, number, number, number], w: number, h: number) {
  const [minLon, minLat, maxLon, maxLat] = bbox
  // Корректировка по широте — на 45° параллели cos(45°) ≈ 0.707, чтобы
  // долгота визуально не растягивалась. Без этого формы вытягиваются по X.
  const midLat = (minLat + maxLat) / 2
  const latCos = Math.cos((midLat * Math.PI) / 180)
  const padding = 8                                  // отступы внутри SVG
  const availW = w - 2 * padding
  const availH = h - 2 * padding

  const lonRange = (maxLon - minLon) * latCos
  const latRange = maxLat - minLat
  const scale = Math.min(availW / lonRange, availH / latRange)
  // Центрируем
  const projectedW = lonRange * scale
  const projectedH = latRange * scale
  const offsetX = padding + (availW - projectedW) / 2
  const offsetY = padding + (availH - projectedH) / 2

  return (lon: number, lat: number): [number, number] => [
    offsetX + (lon - minLon) * latCos * scale,
    // Реверс Y (lat растёт вверх, SVG y-вниз)
    offsetY + (maxLat - lat) * scale,
  ]
}

function ringToPath(ring: Ring, project: (lon: number, lat: number) => [number, number]): string {
  if (ring.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i]
    const [x, y] = project(lon, lat)
    parts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

function geometryToPath(g: Geometry, project: (lon: number, lat: number) => [number, number]): string {
  if (g.type === 'Polygon') {
    return g.coordinates.map((ring) => ringToPath(ring, project)).join(' ')
  }
  // MultiPolygon
  return g.coordinates.flatMap((poly) => poly.map((ring) => ringToPath(ring, project))).join(' ')
}

// Вычисление bbox из geometry (для зума на границе проекта)
function geometryBbox(g: Geometry): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  const visit = (rings: Ring[]) => {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon
        if (lat < minLat) minLat = lat
        if (lon > maxLon) maxLon = lon
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  if (g.type === 'Polygon') visit(g.coordinates)
  else for (const poly of g.coordinates) visit(poly)
  return [minLon, minLat, maxLon, maxLat]
}

// Центроид (приблизительный — среднее точек). Для подписи и стрелки.
function geometryCentroid(g: Geometry): [number, number] {
  let sumLon = 0, sumLat = 0, n = 0
  const visit = (rings: Ring[]) => {
    for (const ring of rings) {
      // Берём только outer ring (первое кольцо), inner кольца пропускаем
      for (const [lon, lat] of ring) {
        sumLon += lon
        sumLat += lat
        n++
      }
      break
    }
  }
  if (g.type === 'Polygon') visit(g.coordinates)
  else for (const poly of g.coordinates) visit(poly)
  return n > 0 ? [sumLon / n, sumLat / n] : [0, 0]
}

export default function ObjectSchema({
  targetObjectCode, targetObjectName, geoData, width = 760, height = 480,
}: Props) {
  const { boundary, features } = geoData
  if (!boundary) return null

  const bbox = geometryBbox(boundary)
  const project = buildProjector(bbox, width, height)

  const boundaryPath = geometryToPath(boundary, project)

  // Особый случай: МАСТЕРПЛАН — это «зонтичный» объект всего комплекса,
  // у него нет functional_object. Подсвечиваем красным саму ГРАНИЦУ проекта
  // (вместо отдельных участков).
  const isMasterplan = /МАСТЕРПЛАН/i.test(targetObjectCode)

  // Разделяем features: целевой (содержит наш object code) и остальные
  const allFeatures = features?.features ?? []
  const targetFeatures: GeoFeature[] = []
  const otherFeatures: GeoFeature[] = []
  for (const f of allFeatures) {
    const codes = (f.properties?.objects ?? []).map((o) => o.code)
    if (codes.includes(targetObjectCode)) targetFeatures.push(f)
    else otherFeatures.push(f)
  }

  // (centroidPx, totalAreaM2, targetObjectName — больше не нужны для SVG:
  // подпись/площадь выводятся над схемой в HTML-блоке.)
  // Подавляем unused warning:
  void targetObjectName; void geometryCentroid;

  return (
    <figure className="object-schema my-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxHeight: `${height}px`, background: '#fff' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Граница проекта — пунктир. Для МАСТЕРПЛАН подсвечиваем красным
            (специальная семантика: МАСТЕРПЛАН = весь проект целиком). */}
        <path
          d={boundaryPath}
          fill={isMasterplan ? '#fca5a5' : 'none'}
          fillOpacity={isMasterplan ? 0.18 : 1}
          stroke={isMasterplan ? '#dc2626' : '#9ca3af'}
          strokeWidth={isMasterplan ? '2' : '1.2'}
          strokeDasharray={isMasterplan ? '' : '6 4'}
        />

        {/* Остальные функциональные объекты — серым */}
        {otherFeatures.map((f, i) => (
          <path
            key={`o-${i}`}
            d={geometryToPath(f.geometry, project)}
            fill="#e5e7eb"
            stroke="#9ca3af"
            strokeWidth="0.6"
          />
        ))}

        {/* Целевой объект — красным */}
        {targetFeatures.map((f, i) => (
          <path
            key={`t-${i}`}
            d={geometryToPath(f.geometry, project)}
            fill="#fca5a5"
            stroke="#dc2626"
            strokeWidth="1.6"
          />
        ))}

        {/* Выноска и текстовая подпись убраны — название + площадь
            выводятся над схемой в HTML-блоке (см. ObjectTitlePage в page.tsx).
            На самом SVG: только красная заливка участка/границы. */}
      </svg>
      <figcaption className="text-[10px] text-gray-500 text-center mt-1">
        Схема: общий план комплекса «Золотые Пески России» с выделением участка объекта.
      </figcaption>
    </figure>
  )
}
