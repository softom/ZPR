import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  isoDate, periodEnd, snapToPeriodStart, formatPeriodTitle,
  type PeriodType,
} from '@/lib/reports/periodHelpers'

// GET /api/reports — список отчётов (фильтр period_type, status)
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const periodType = url.searchParams.get('period_type')
  const status = url.searchParams.get('status')

  let q = supabaseAdmin
    .from('reports')
    .select('id, period_type, period_start, period_end, title, status, created_at, finalized_at')
    .order('period_start', { ascending: false })

  if (periodType === 'week' || periodType === 'month') q = q.eq('period_type', periodType)
  if (status === 'draft' || status === 'final') q = q.eq('status', status)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // К каждому отчёту — счётчик заполненных секций / всего
  const ids = (data ?? []).map((r) => r.id)
  let countsByReport = new Map<string, { total: number; filled: number }>()
  if (ids.length > 0) {
    const sec = await supabaseAdmin
      .from('object_reports')
      .select('report_id, project_movement, achievements, next_period_tasks, risks')
      .in('report_id', ids)
    for (const s of (sec.data ?? []) as Array<{
      report_id: string; project_movement: string | null; achievements: string | null;
      next_period_tasks: string | null; risks: string | null
    }>) {
      const c = countsByReport.get(s.report_id) ?? { total: 0, filled: 0 }
      c.total += 1
      const filled = [s.project_movement, s.achievements, s.next_period_tasks, s.risks]
        .filter((x) => x && x.trim().length > 0).length
      if (filled === 4) c.filled += 1
      countsByReport.set(s.report_id, c)
    }
  }

  const reports = (data ?? []).map((r) => ({
    ...r,
    sections_total: countsByReport.get(r.id)?.total ?? 0,
    sections_filled: countsByReport.get(r.id)?.filled ?? 0,
  }))

  return NextResponse.json({ reports })
}

// POST /api/reports — создать отчёт + авто-секции по всем active=true объектам
// Body: { period_type: 'week'|'month', period_start: 'YYYY-MM-DD' }
export async function POST(request: NextRequest) {
  let body: { period_type?: string; period_start?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const periodType = body.period_type as PeriodType
  if (periodType !== 'week' && periodType !== 'month') {
    return NextResponse.json({ error: 'period_type должен быть week|month' }, { status: 400 })
  }
  if (!body.period_start) {
    return NextResponse.json({ error: 'period_start обязателен (YYYY-MM-DD)' }, { status: 400 })
  }

  const start = snapToPeriodStart(body.period_start, periodType)
  const end = periodEnd(start, periodType)
  const title = formatPeriodTitle(start, end, periodType)

  // Создаём report
  const { data: report, error: rErr } = await supabaseAdmin
    .from('reports')
    .insert({
      period_type: periodType,
      period_start: isoDate(start),
      period_end: isoDate(end),
      title,
      status: 'draft',
    })
    .select('*')
    .single()
  if (rErr || !report) {
    // unique_violation: 23505
    if (rErr?.code === '23505') {
      return NextResponse.json({ error: `Отчёт за этот период уже существует` }, { status: 409 })
    }
    return NextResponse.json({ error: rErr?.message ?? 'unknown' }, { status: 500 })
  }

  // Активные объекты, отсортированные по code (000_МАСТЕРПЛАН — первым)
  const { data: objects, error: oErr } = await supabaseAdmin
    .from('objects')
    .select('id, code')
    .eq('active', true)
    .order('code', { ascending: true })
  if (oErr) return NextResponse.json({ error: oErr.message }, { status: 500 })

  // Создаём пустые object_reports
  const sectionsToInsert = (objects ?? []).map((o) => ({
    report_id: report.id,
    object_id: o.id,
    period_start: report.period_start,
    period_end: report.period_end,
    project_movement: null,
    achievements: null,
    next_period_tasks: null,
    risks: null,
  }))
  if (sectionsToInsert.length > 0) {
    const { error: sErr } = await supabaseAdmin
      .from('object_reports')
      .insert(sectionsToInsert)
    if (sErr) {
      // Откатим report чтобы не оставлять висящий
      await supabaseAdmin.from('reports').delete().eq('id', report.id)
      return NextResponse.json({ error: sErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({
    report,
    sections_created: sectionsToInsert.length,
  })
}
