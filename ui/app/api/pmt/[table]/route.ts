import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAllowedPmtTable, getPmtTableMeta } from '@/lib/pmt/tables'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/**
 * GET /api/pmt/[table]?limit=100&offset=0&order=col&dir=asc&search=text
 *
 * Возвращает содержимое стейджинг-таблицы pmt_*.
 *
 * Параметры:
 *   - limit:   количество строк (1..1000, default 100)
 *   - offset:  сдвиг
 *   - order:   имя колонки для сортировки (опц.)
 *   - dir:     'asc' | 'desc' (default 'asc')
 *   - search:  подстрока для текстового поиска по всем text-колонкам (через OR ilike) — опционально
 *
 * Защита: имя таблицы проверяется по whitelist в @/lib/pmt/tables, чтобы избежать
 * непреднамеренного SELECT по любой таблице в схеме.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ table: string }> }
) {
  const { table } = await params

  if (!isAllowedPmtTable(table)) {
    return NextResponse.json(
      { error: `Table "${table}" not in pmt_* whitelist` },
      { status: 400 }
    )
  }

  const url = new URL(req.url)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)))
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
  const order = url.searchParams.get('order')
  const dir = url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc'

  let q = supabaseAdmin
    .from(table)
    .select('*', { count: 'exact' })
    .range(offset, offset + limit - 1)

  if (order) {
    q = q.order(order, { ascending: dir === 'asc' })
  }

  const { data, count, error } = await q

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    table,
    meta: getPmtTableMeta(table),
    limit,
    offset,
    rowCount: count ?? 0,
    rows: data ?? [],
  })
}
