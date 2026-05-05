import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildAllSectionStats } from '@/lib/reports/sectionStats'

// GET /api/reports/[id]/stats — массив количественных показателей
// по всем объектам отчёта. Используется в UI для отображения цифр над
// разделами объекта.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const r = await supabaseAdmin
    .from('reports')
    .select('period_type, period_start, period_end')
    .eq('id', id)
    .single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })

  const stats = await buildAllSectionStats(
    id,
    r.data.period_type as 'week' | 'month',
    new Date(r.data.period_start),
    new Date(r.data.period_end),
  )
  return NextResponse.json({ stats })
}
