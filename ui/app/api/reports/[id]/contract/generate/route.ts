import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildContractContext } from '@/lib/reports/buildContractContext'
import { generateContractReport } from '@/lib/reports/generateContractReport'

export const maxDuration = 120

// POST /api/reports/[id]/contract/generate
// Body опц.: { source_report_id }. Если не задан — берётся reports.appendix_report_id.
// Собирает «Отчёт по договору ТЗ» из выбранного месячного отчёта-источника
// и кладёт markdown в reports.summary_md.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const r = await supabaseAdmin
    .from('reports')
    .select('period_type, status, appendix_report_id')
    .eq('id', id)
    .single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (r.data.period_type !== 'contract') {
    return NextResponse.json({ error: 'Это не отчёт по договору' }, { status: 400 })
  }
  if (r.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя пересобрать' }, { status: 409 })
  }

  let sourceId = (r.data.appendix_report_id as string | null) ?? null
  try {
    const raw = await request.text()
    if (raw.trim()) {
      const body = JSON.parse(raw) as { source_report_id?: string }
      if (body.source_report_id) sourceId = body.source_report_id
    }
  } catch { /* пустой/битый body — игнор */ }

  if (!sourceId) {
    return NextResponse.json({
      error: 'Не выбран отчёт-источник (Приложение). Выберите месячный отчёт ЗПР.',
    }, { status: 422 })
  }

  let ctxData
  try {
    ctxData = await buildContractContext(sourceId)
  } catch (e) {
    return NextResponse.json({ error: `Контекст: ${(e as Error).message}` }, { status: 500 })
  }

  let md
  try {
    md = await generateContractReport(ctxData)
  } catch (e) {
    return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
  }

  const { data, error } = await supabaseAdmin
    .from('reports')
    .update({ summary_md: md, appendix_report_id: sourceId })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ report: data })
}
