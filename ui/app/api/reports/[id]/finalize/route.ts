import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// POST /api/reports/[id]/finalize — перевод status draft → final
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const { data, error } = await supabaseAdmin
    .from('reports')
    .update({ status: 'final', finalized_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Отчёт не найден или уже финализирован' }, { status: 409 })
  }
  return NextResponse.json({ report: data })
}
