import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { XMLParser } from 'fast-xml-parser'

export const dynamic = 'force-dynamic'

/**
 * POST /api/cadastrals/import-kpt
 *
 * Принимает multipart/form-data с XML-файлом (.xml или .xml.zip) формата КПТ v11.
 * Парсит все land_record, извлекает метаданные и геометрию,
 * вызывает RPC upsert_cadastral_from_kpt для каждого участка.
 *
 * Возвращает:
 * {
 *   total, created, updated, geom_set, errors,
 *   records: [{cad_number, action, has_geom, error?}]
 * }
 */

// ── Маппинг sk_id → SRID ───────────────────────────────────────────────────
const SK_ID_MAP: Record<string, number> = {
  '90.4': 970634,
  '63.4': 970634,
  'СК-63, зона 4': 970634,
  'СК 63': 970634,
  'СК-63': 970634,
}
const DEFAULT_SRID = 970634

// ── Утилиты ─────────────────────────────────────────────────────────────────

function extractText(el: any): string | null {
  if (el == null) return null
  if (typeof el === 'string') return el.trim() || null
  if (typeof el === 'number') return String(el)
  if (typeof el === 'object' && '#text' in el) return String(el['#text']).trim() || null
  return null
}

function extractNumber(el: any): number | null {
  const t = extractText(el)
  if (!t) return null
  const n = parseFloat(t)
  return isNaN(n) ? null : n
}

function cadQuarterFromNumber(cn: string): string | null {
  const m = cn.match(/^(\d+:\d+:\d+):/)
  return m ? m[1] : null
}

// ── Вспомогательный доступ к вложенным объектам XML ────────────────────────

function dig(obj: any, ...path: string[]): any {
  let cur = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

// ── Парсинг land_record ─────────────────────────────────────────────────────

interface KptRecord {
  cad_number: string
  address: string | null
  category: string | null
  vri: string | null
  area_m2: number | null
  cadastral_cost: number | null
  area_inaccuracy: number | null
  category_code: string | null
  subtype_code: string | null
  cad_quarter: string | null
  wkt: string | null
  srid: number
}

function parseOrdinates(spatialElement: any): [number, number][] {
  const coords: [number, number][] = []
  let ordinates = dig(spatialElement, 'ordinates', 'ordinate')
  if (!ordinates) return coords
  if (!Array.isArray(ordinates)) ordinates = [ordinates]

  for (const ord of ordinates) {
    const x = parseFloat(ord?.x)
    const y = parseFloat(ord?.y)
    if (!isNaN(x) && !isNaN(y)) {
      coords.push([x, y])
    }
  }
  return coords
}

function buildPolygonWkt(rings: [number, number][][]): string {
  const ringStrs = rings.map(ring => {
    // WKT: X=easting(y), Y=northing(x) — swap for СК-63
    const pts = ring.map(([x, y]) => `${y} ${x}`).join(', ')
    return `(${pts})`
  })
  return `POLYGON(${ringStrs.join(', ')})`
}

function parseSpatialElements(entitySpatial: any): { srid: number; rings: [number, number][][] } {
  const skId = extractText(entitySpatial?.sk_id) || ''
  const srid = SK_ID_MAP[skId] ?? DEFAULT_SRID

  let spatialElements = dig(entitySpatial, 'spatials_elements', 'spatial_element')
  if (!spatialElements) return { srid, rings: [] }
  if (!Array.isArray(spatialElements)) spatialElements = [spatialElements]

  const rings: [number, number][][] = []
  for (const se of spatialElements) {
    const coords = parseOrdinates(se)
    if (coords.length >= 3) {
      // Замыкаем кольцо
      if (coords[0][0] !== coords[coords.length - 1][0] ||
          coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([...coords[0]])
      }
      rings.push(coords)
    }
  }

  return { srid, rings }
}

function parseLandRecords(root: any): KptRecord[] {
  const results: KptRecord[] = []

  // Найти все land_record: могут быть на разных уровнях вложенности
  const landRecords = findAllDeep(root, 'land_record')

  for (const rec of landRecords) {
    const cadNumber = extractText(dig(rec, 'object', 'common_data', 'cad_number'))
    if (!cadNumber) continue

    // Метаданные
    const address = extractText(dig(rec, 'address_location', 'address', 'readable_address'))
    const category = extractText(dig(rec, 'params', 'category', 'type', 'value'))
    const categoryCode = extractText(dig(rec, 'params', 'category', 'type', 'code'))
    const vri = extractText(dig(rec, 'params', 'permitted_use', 'permitted_use_established', 'by_document'))
    const areaM2 = extractNumber(dig(rec, 'params', 'area', 'value'))
    const areaInaccuracy = extractNumber(dig(rec, 'params', 'area', 'inaccuracy'))
    const cadastralCost = extractNumber(dig(rec, 'cost', 'value'))
    const subtypeCode = extractText(dig(rec, 'object', 'subtype', 'code'))
    const cadQuarter = cadQuarterFromNumber(cadNumber)

    // Геометрия: может быть в entity_spatial или contours_location
    let allRings: [number, number][][] = []
    let srid = DEFAULT_SRID

    // 1) contours_location/contours/contour/entity_spatial
    const contours = findAllDeep(rec, 'entity_spatial')
    for (const es of contours) {
      const parsed = parseSpatialElements(es)
      srid = parsed.srid
      allRings.push(...parsed.rings)
    }

    const wkt = allRings.length > 0 ? buildPolygonWkt(allRings) : null

    results.push({
      cad_number: cadNumber,
      address,
      category,
      vri,
      area_m2: areaM2,
      cadastral_cost: cadastralCost,
      area_inaccuracy: areaInaccuracy,
      category_code: categoryCode,
      subtype_code: subtypeCode,
      cad_quarter: cadQuarter,
      wkt,
      srid,
    })
  }

  return results
}

/** Рекурсивный поиск всех узлов с заданным именем */
function findAllDeep(obj: any, key: string): any[] {
  const results: any[] = []
  if (obj == null || typeof obj !== 'object') return results

  if (key in obj) {
    const val = obj[key]
    if (Array.isArray(val)) {
      results.push(...val)
    } else {
      results.push(val)
    }
  }

  for (const k of Object.keys(obj)) {
    if (k === key) continue
    const val = obj[k]
    if (Array.isArray(val)) {
      for (const item of val) {
        results.push(...findAllDeep(item, key))
      }
    } else if (typeof val === 'object' && val !== null) {
      results.push(...findAllDeep(val, key))
    }
  }

  return results
}

// ── Распаковка ZIP ──────────────────────────────────────────────────────────

async function extractXmlFromZip(buffer: ArrayBuffer): Promise<string> {
  // Простой парсер ZIP (находим первый .xml файл)
  // ZIP End of Central Directory record
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // Ищем EOCD signature (0x06054b50) с конца
  let eocdOffset = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) throw new Error('Не найден ZIP End-of-Central-Directory')

  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const cdEntries = view.getUint16(eocdOffset + 10, true)

  let offset = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break

    const compMethod = view.getUint16(offset + 10, true)
    const compSize = view.getUint32(offset + 20, true)
    const uncompSize = view.getUint32(offset + 24, true)
    const fnLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)

    const fileName = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + fnLen))

    if (fileName.endsWith('.xml')) {
      // Читаем из local file header
      const lfhOffset = localHeaderOffset
      if (view.getUint32(lfhOffset, true) !== 0x04034b50) {
        throw new Error('Неверный Local File Header')
      }
      const lfnLen = view.getUint16(lfhOffset + 26, true)
      const lextraLen = view.getUint16(lfhOffset + 28, true)
      const dataOffset = lfhOffset + 30 + lfnLen + lextraLen

      if (compMethod === 0) {
        // STORED (не сжатый)
        const xmlBytes = bytes.slice(dataOffset, dataOffset + uncompSize)
        return new TextDecoder('utf-8').decode(xmlBytes)
      } else if (compMethod === 8) {
        // DEFLATE
        const compressed = bytes.slice(dataOffset, dataOffset + compSize)
        const ds = new DecompressionStream('deflate-raw')
        const writer = ds.writable.getWriter()
        writer.write(compressed)
        writer.close()
        const reader = ds.readable.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const total = chunks.reduce((s, c) => s + c.length, 0)
        const result = new Uint8Array(total)
        let pos = 0
        for (const chunk of chunks) {
          result.set(chunk, pos)
          pos += chunk.length
        }
        return new TextDecoder('utf-8').decode(result)
      } else {
        throw new Error(`Неподдерживаемый метод сжатия: ${compMethod}`)
      }
    }

    offset += 46 + fnLen + extraLen + commentLen
  }

  throw new Error('В ZIP нет XML-файлов')
}

// ── Основной обработчик ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'Файл не передан (поле "file")' }, { status: 400 })
    }

    // Извлекаем XML
    let xmlString: string
    const buffer = await file.arrayBuffer()

    if (file.name.endsWith('.zip') || file.name.endsWith('.xml.zip')) {
      xmlString = await extractXmlFromZip(buffer)
    } else {
      xmlString = new TextDecoder('utf-8').decode(buffer)
    }

    // Парсинг XML → JSON
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      isArray: (name) => {
        // Элементы, которые могут повторяться
        return ['land_record', 'spatial_element', 'ordinate', 'contour'].includes(name)
      },
    })
    const parsed = parser.parse(xmlString)

    // Извлекаем участки
    const records = parseLandRecords(parsed)

    if (records.length === 0) {
      return NextResponse.json({
        error: 'Не найдено участков (land_record) в XML',
        total: 0, created: 0, updated: 0, geom_set: 0, errors: 0, records: [],
      })
    }

    // Импорт через RPC
    const results: { cad_number: string; action: string; has_geom: boolean; error?: string }[] = []
    let created = 0, updated = 0, geomSet = 0, errors = 0

    for (const rec of records) {
      try {
        const { data, error } = await supabaseAdmin.rpc('upsert_cadastral_from_kpt', {
          p_cadastral_number: rec.cad_number,
          p_address: rec.address,
          p_category: rec.category,
          p_vri: rec.vri,
          p_area_m2: rec.area_m2,
          p_cadastral_cost: rec.cadastral_cost,
          p_area_inaccuracy: rec.area_inaccuracy,
          p_category_code: rec.category_code,
          p_subtype_code: rec.subtype_code,
          p_cad_quarter: rec.cad_quarter,
          p_wkt: rec.wkt,
          p_srid: rec.srid,
        })

        if (error) {
          results.push({ cad_number: rec.cad_number, action: 'error', has_geom: false, error: error.message })
          errors++
        } else {
          const action = data?.action || 'unknown'
          const hasGeom = data?.has_geom || false
          results.push({ cad_number: rec.cad_number, action, has_geom: hasGeom })
          if (action === 'created') created++
          if (action === 'updated') updated++
          if (hasGeom) geomSet++
        }
      } catch (e: any) {
        results.push({ cad_number: rec.cad_number, action: 'error', has_geom: false, error: e.message })
        errors++
      }
    }

    return NextResponse.json({
      total: records.length,
      created,
      updated,
      geom_set: geomSet,
      errors,
      records: results,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: `Ошибка обработки: ${err.message}` },
      { status: 500 },
    )
  }
}
