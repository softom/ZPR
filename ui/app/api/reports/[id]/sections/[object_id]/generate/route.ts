import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildContext } from '@/lib/reports/buildContext'
import { generateSections, REPORT_FIELDS, type ReportField } from '@/lib/reports/generateSection'

export const maxDuration = 90

// POST /api/reports/[id]/sections/[object_id]/generate
// Body опц.: { fields?: string[] } — какие поля сгенерировать.
// Без body → все 6 полей. С указанными — только они (для частичной перегенерации).
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; object_id: string }> },
) {
  const { id, object_id } = await ctx.params

  // Опциональный fields из body. Парсим через text() → JSON.parse (надёжнее
  // для пустых POST тел чем request.json() на некоторых Next runtime).
  let requestedFields: ReportField[] | undefined
  try {
    const raw = await request.text()
    if (raw.trim().length > 0) {
      const body = JSON.parse(raw) as { fields?: unknown }
      if (body && Array.isArray(body.fields)) {
        const valid = body.fields.filter((f: unknown): f is ReportField =>
          typeof f === 'string' && (REPORT_FIELDS as readonly string[]).includes(f)
        )
        if (valid.length > 0) requestedFields = valid
      }
    }
  } catch { /* битый body — игнорируем, генерируем все поля */ }

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

  const periodType = r.data.period_type as 'week' | 'month'
  const periodStart = new Date(r.data.period_start)
  const periodEndDate = new Date(r.data.period_end)

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
    sections = await generateSections(ctxData, requestedFields)
  } catch (e) {
    return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
  }

  // Update только сгенерированных НЕПУСТЫХ полей + generated_at.
  // Пустую строку трактуем как «LLM нечего написать» — оставляем старое
  // значение в БД, чтобы пользователь не терял ранее сгенерированный/правленый текст.
  const update: Record<string, string | null> = {}
  let nonEmptyCount = 0
  for (const f of (requestedFields ?? REPORT_FIELDS) as ReportField[]) {
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
