import { NextRequest, NextResponse } from 'next/server'
import { Pool, PoolClient } from 'pg'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Table mappings: source view (postgres DB) -> target table (zpr_gis DB)
// ---------------------------------------------------------------------------

type TableMapping = {
  srcView: string
  dstTable: string
  columns: string[]          // column names in the destination table
  selectExpr: string         // SELECT expression (may alias geom_sk63 -> geom)
}

const TABLES: TableMapping[] = [
  {
    srcView: 'gis_plots',
    dstTable: 'gis_plots_sk63',
    columns: [
      'objectid', 'id', 'code', 'name', 'functional_zone_code', 'objects_csv',
      'area_m2', 'load_water', 'load_sewer', 'load_storm', 'load_heat',
      'load_gas', 'load_power', 'loads_summary', 'geom',
    ],
    selectExpr: `objectid, id, code, name, functional_zone_code, objects_csv,
      area_m2, load_water, load_sewer, load_storm, load_heat,
      load_gas, load_power, loads_summary, geom_sk63 AS geom`,
  },
  {
    srcView: 'gis_objects',
    dstTable: 'gis_objects_sk63',
    columns: ['objectid', 'id', 'code', 'name', 'contractor', 'color', 'plots_count', 'area_m2', 'geom'],
    selectExpr: 'objectid, id, code, name, contractor, color, plots_count, area_m2, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_functional_zones',
    dstTable: 'gis_functional_zones_sk63',
    columns: ['objectid', 'id', 'zone_code', 'zone_name', 'kind', 'objects_csv', 'loads_summary', 'area_m2', 'geom'],
    selectExpr: 'objectid, id, zone_code, zone_name, kind, objects_csv, loads_summary, area_m2, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_cadastrals',
    dstTable: 'gis_cadastrals_sk63',
    columns: ['objectid', 'id', 'cadastral_number', 'ownership', 'is_seizure', 'area_declared_m2', 'geom'],
    selectExpr: 'objectid, id, cadastral_number, ownership, is_seizure, area_declared_m2, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_object_polygons',
    dstTable: 'gis_object_polygons_sk63',
    columns: ['objectid', 'id', 'object_code', 'kind', 'name', 'geom'],
    selectExpr: 'objectid, id, object_code, kind, name, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_object_lines',
    dstTable: 'gis_object_lines_sk63',
    columns: ['objectid', 'id', 'object_code', 'kind', 'name', 'geom'],
    selectExpr: 'objectid, id, object_code, kind, name, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_object_points',
    dstTable: 'gis_object_points_sk63',
    columns: ['objectid', 'id', 'object_code', 'kind', 'name', 'geom'],
    selectExpr: 'objectid, id, object_code, kind, name, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_raster_footprints',
    dstTable: 'gis_raster_footprints_sk63',
    columns: ['objectid', 'id', 'object_code', 'title', 'kind', 'storage_url', 'captured_at', 'geom'],
    selectExpr: 'objectid, id, object_code, title, kind, storage_url, captured_at, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_project_boundary',
    dstTable: 'gis_project_boundary_sk63',
    columns: ['objectid', 'id', 'name', 'area_m2', 'geom'],
    selectExpr: 'objectid, id, name, area_m2, geom_sk63 AS geom',
  },
  // --- ПМТ ДОРОГА layers ---
  {
    srcView: 'gis_doroga_coords',
    dstTable: 'gis_doroga_coords_sk63',
    columns: ['objectid', 'id', 'label', 'point_num', 'geom'],
    selectExpr: 'objectid, id, label, point_num, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_doroga_boundary',
    dstTable: 'gis_doroga_boundary_sk63',
    columns: ['objectid', 'id', 'name', 'length_m', 'geom'],
    selectExpr: 'objectid, id, name, length_m, geom_sk63 AS geom',
  },
  {
    srcView: 'gis_doroga_zu',
    dstTable: 'gis_doroga_zu_sk63',
    columns: ['objectid', 'id', 'plot_name', 'area_m2', 'num_points', 'geom'],
    selectExpr: 'objectid, id, plot_name, area_m2, num_points, geom_sk63 AS geom',
  },
]

// ---------------------------------------------------------------------------
// Auth check: localhost or service_role key
// ---------------------------------------------------------------------------

function isAuthorized(req: NextRequest): boolean {
  // Allow from localhost
  const host = req.headers.get('host') ?? ''
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return true
  }

  // Allow with service_role key in Authorization header
  const auth = req.headers.get('authorization') ?? ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceKey && auth === `Bearer ${serviceKey}`) {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Sync one table: read from src, write to dst
// ---------------------------------------------------------------------------

type SyncResult = {
  table: string
  rows: number
  durationMs: number
  error?: string
}

async function syncTable(
  mapping: TableMapping,
  srcPool: Pool,
  dstClient: PoolClient,
): Promise<SyncResult> {
  const t0 = Date.now()
  try {
    // 1. Read rows from source view in postgres DB
    const srcResult = await srcPool.query(
      `SELECT ${mapping.selectExpr} FROM ${mapping.srcView}`
    )
    const rows = srcResult.rows

    // 2. TRUNCATE destination table in zpr_gis
    await dstClient.query(`TRUNCATE TABLE ${mapping.dstTable}`)

    if (rows.length === 0) {
      return { table: mapping.dstTable, rows: 0, durationMs: Date.now() - t0 }
    }

    // 3. Bulk INSERT using parameterized values
    //    Build a single INSERT with multi-row VALUES for efficiency
    const colCount = mapping.columns.length
    const placeholders: string[] = []
    const values: unknown[] = []

    for (let i = 0; i < rows.length; i++) {
      const rowPlaceholders: string[] = []
      for (let j = 0; j < colCount; j++) {
        values.push(rows[i][mapping.columns[j]])
        rowPlaceholders.push(`$${i * colCount + j + 1}`)
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`)
    }

    // For very large datasets, batch in chunks of 500 rows to avoid
    // hitting PostgreSQL parameter limit (65535)
    const BATCH_SIZE = 500
    let totalInserted = 0

    if (rows.length <= BATCH_SIZE) {
      const sql = `INSERT INTO ${mapping.dstTable} (${mapping.columns.join(', ')}) VALUES ${placeholders.join(', ')}`
      await dstClient.query(sql, values)
      totalInserted = rows.length
    } else {
      // Batched insert for large datasets
      for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length)
        const batchRows = rows.slice(batchStart, batchEnd)
        const batchPlaceholders: string[] = []
        const batchValues: unknown[] = []

        for (let i = 0; i < batchRows.length; i++) {
          const rowPh: string[] = []
          for (let j = 0; j < colCount; j++) {
            batchValues.push(batchRows[i][mapping.columns[j]])
            rowPh.push(`$${i * colCount + j + 1}`)
          }
          batchPlaceholders.push(`(${rowPh.join(', ')})`)
        }

        const sql = `INSERT INTO ${mapping.dstTable} (${mapping.columns.join(', ')}) VALUES ${batchPlaceholders.join(', ')}`
        await dstClient.query(sql, batchValues)
        totalInserted += batchRows.length
      }
    }

    return { table: mapping.dstTable, rows: totalInserted, durationMs: Date.now() - t0 }
  } catch (err) {
    return {
      table: mapping.dstTable,
      rows: 0,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/gis/sync
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { error: 'Unauthorized. Call from localhost or pass service_role key.' },
      { status: 401 },
    )
  }

  const PG_HOST = process.env.PG_HOST ?? '127.0.0.1'
  const PG_PORT = parseInt(process.env.PG_PORT ?? '54322', 10)
  const PG_USER = process.env.PG_USER ?? 'postgres'
  const PG_PASS = process.env.PG_PASS ?? 'postgres'

  const srcPool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: 'postgres',
    user: PG_USER,
    password: PG_PASS,
    max: 2,
  })

  const dstPool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: 'zpr_gis',
    user: PG_USER,
    password: PG_PASS,
    max: 2,
  })

  const results: SyncResult[] = []
  let dstClient: PoolClient | null = null

  try {
    // Use a single client from dstPool for the entire operation
    // so we can wrap everything in a transaction
    dstClient = await dstPool.connect()
    await dstClient.query('BEGIN')

    for (const mapping of TABLES) {
      const result = await syncTable(mapping, srcPool, dstClient)
      results.push(result)

      // If any table fails, abort the whole transaction
      if (result.error) {
        await dstClient.query('ROLLBACK')
        return NextResponse.json({
          ok: false,
          error: `Failed on ${result.table}: ${result.error}`,
          results,
        }, { status: 500 })
      }
    }

    await dstClient.query('COMMIT')

    const totalRows = results.reduce((sum, r) => sum + r.rows, 0)

    return NextResponse.json({
      ok: true,
      totalRows,
      tables: results,
    })
  } catch (err) {
    if (dstClient) {
      try { await dstClient.query('ROLLBACK') } catch { /* ignore */ }
    }
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      results,
    }, { status: 500 })
  } finally {
    if (dstClient) dstClient.release()
    await srcPool.end()
    await dstPool.end()
  }
}
