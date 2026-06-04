import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { PMT_TABLES, CATEGORY_LABELS, type PmtTableMeta } from '@/lib/pmt/tables'

export const dynamic = 'force-dynamic'

/**
 * GET /api/pmt/tables
 *
 * Возвращает список стейджинг-таблиц `pmt_*` с количеством строк (count: exact).
 * Группировка по категориям делается на клиенте, здесь — плоский список.
 *
 * Используется в /plots/staging для боковой панели viewer'а.
 */
export async function GET() {
  const results = await Promise.all(
    PMT_TABLES.map(async (meta: PmtTableMeta) => {
      const { count, error } = await supabaseAdmin
        .from(meta.name)
        .select('*', { count: 'exact', head: true })

      return {
        ...meta,
        rowCount: error ? null : (count ?? 0),
        error: error ? error.message : null,
      }
    })
  )

  return NextResponse.json({
    categories: CATEGORY_LABELS,
    tables: results,
  })
}
