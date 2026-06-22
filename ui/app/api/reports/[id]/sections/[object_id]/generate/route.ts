import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildContext } from '@/lib/reports/buildContext'
import { buildControlContext } from '@/lib/reports/buildControlContext'
import { generateSections, REPORT_FIELDS, WEEKLY_V3_FIELDS, type ReportField } from '@/lib/reports/generateSection'
import { generateControlSections, CONTROL_FIELDS, type ControlField } from '@/lib/reports/generateControlSection'
import { buildShortContext } from '@/lib/reports/buildShortContext'
import { generateShortSections, SHORT_FIELDS, type ShortField } from '@/lib/reports/generateShortSection'

export const maxDuration = 120

// POST /api/reports/[id]/sections/[object_id]/generate
// Body опц.: { fields?: string[] } — какие поля сгенерировать.
// Без body → все поля (6 для week/month, 3 для control).
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; object_id: string }> },
) {
  const { id, object_id } = await ctx.params

  // Загрузить отчёт (для периода + флага финансов)
  const r = await supabaseAdmin
    .from('reports')
    .select('period_type, period_start, period_end, status, include_financials')
    .eq('id', id)
    .single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (r.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя пересобрать' }, { status: 409 })
  }

  const periodType = r.data.period_type as 'week' | 'month' | 'control' | 'short'
  const periodStart = new Date(r.data.period_start)
  const periodEndDate = new Date(r.data.period_end)

  // Парсим fields (валидный набор зависит от типа отчёта).
  // week → поля Weekly v3 (project_movement + 3 weekly_*); month → legacy 6 полей.
  const weekOrMonthFields = (periodType === 'week' ? WEEKLY_V3_FIELDS : REPORT_FIELDS) as readonly string[]
  const allowedFields = periodType === 'control'
    ? (CONTROL_FIELDS as readonly string[])
    : periodType === 'short'
    ? (SHORT_FIELDS as readonly string[])
    : weekOrMonthFields

  let requestedFields: string[] | undefined
  try {
    const raw = await request.text()
    if (raw.trim().length > 0) {
      const body = JSON.parse(raw) as { fields?: unknown }
      if (body && Array.isArray(body.fields)) {
        const valid = body.fields.filter((f: unknown): f is string =>
          typeof f === 'string' && allowedFields.includes(f)
        )
        if (valid.length > 0) requestedFields = valid
      }
    }
  } catch { /* битый body — игнорируем */ }

  // === control ветка ===
  if (periodType === 'control') {
    let ctxData
    try {
      ctxData = await buildControlContext(object_id, periodStart, {
        include_financials: Boolean(r.data.include_financials),
      })
      // Подтянем tep_deadline и priority_group из object_reports — чтобы LLM получил
      // актуальный срок и понимал статус приоритета
      const orRes = await supabaseAdmin
        .from('object_reports')
        .select('tep_deadline, priority_group')
        .eq('report_id', id)
        .eq('object_id', object_id)
        .single()
      if (orRes.data) {
        ctxData.object.tep_deadline = orRes.data.tep_deadline ?? null
        ctxData.object.priority_group = (orRes.data.priority_group as 'priority' | 'secondary' | null) ?? null
      }
    } catch (e) {
      return NextResponse.json({ error: `Контекст: ${(e as Error).message}` }, { status: 500 })
    }

    let sections
    try {
      sections = await generateControlSections(ctxData, requestedFields as ControlField[] | undefined)
    } catch (e) {
      return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
    }

    const update: Record<string, string> = {}
    let nonEmptyCount = 0
    for (const f of (requestedFields ?? CONTROL_FIELDS) as ControlField[]) {
      if (!(f in sections)) continue
      const v = sections[f] ?? ''
      if (v.trim().length === 0) continue
      update[f] = v
      nonEmptyCount += 1
    }
    if (nonEmptyCount === 0) {
      return NextResponse.json({
        error: 'LLM вернул пустые значения. Проверь что у объекта есть данные (события, задачи, темы) или впиши контекст вручную.',
      }, { status: 422 })
    }
    update.generated_at = new Date().toISOString()
    update.model_used = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

    const { data, error } = await supabaseAdmin
      .from('object_reports')
      .update(update)
      .eq('report_id', id)
      .eq('object_id', object_id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ section: data })
  }

  // === short ветка (Короткая справка: утверждённые варианты «в работу») ===
  if (periodType === 'short') {
    let ctxData
    try {
      ctxData = await buildShortContext(object_id, periodStart)
    } catch (e) {
      return NextResponse.json({ error: `Контекст: ${(e as Error).message}` }, { status: 500 })
    }
    let sections
    try {
      sections = await generateShortSections(ctxData, requestedFields as ShortField[] | undefined)
    } catch (e) {
      return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
    }
    const update: Record<string, string> = {}
    let nonEmptyCount = 0
    for (const f of (requestedFields ?? SHORT_FIELDS) as ShortField[]) {
      if (!(f in sections)) continue
      const v = sections[f] ?? ''
      if (v.trim().length === 0) continue
      update[f] = v
      nonEmptyCount += 1
    }
    if (nonEmptyCount === 0) {
      return NextResponse.json({
        error: 'LLM вернул пустые значения. Возможно, по объекту нет утверждённых вариантов в источниках (собрания/события).',
      }, { status: 422 })
    }
    update.generated_at = new Date().toISOString()
    update.model_used = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'
    const { data, error } = await supabaseAdmin
      .from('object_reports')
      .update(update)
      .eq('report_id', id)
      .eq('object_id', object_id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ section: data })
  }

  // === week / month ветка (без изменений) ===
  let ctxData
  try {
    ctxData = await buildContext(object_id, periodType, periodStart, periodEndDate, {
      include_financials: Boolean(r.data.include_financials),
    })
  } catch (e) {
    return NextResponse.json({ error: `Контекст: ${(e as Error).message}` }, { status: 500 })
  }

  let sections
  try {
    sections = await generateSections(ctxData, requestedFields as ReportField[] | undefined)
  } catch (e) {
    return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
  }

  const update: Record<string, string | null> = {}
  let nonEmptyCount = 0
  for (const f of (requestedFields ?? weekOrMonthFields) as ReportField[]) {
    if (!(f in sections)) continue
    const v = sections[f] ?? ''
    if (v.trim().length === 0) continue
    update[f] = v
    nonEmptyCount += 1
  }

  if (nonEmptyCount === 0) {
    return NextResponse.json({
      error: 'LLM вернул пустые значения. Проверь что у объекта есть данные за период (события, задачи, темы) или впиши контекст вручную.',
    }, { status: 422 })
  }

  update.generated_at = new Date().toISOString() as unknown as string
  update.model_used = (process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6') as string

  const { data, error } = await supabaseAdmin
    .from('object_reports')
    .update(update)
    .eq('report_id', id)
    .eq('object_id', object_id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ section: data })
}
