import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildAllSectionStats } from '@/lib/reports/sectionStats'
import { generateSummary, type SectionContext } from '@/lib/reports/generateSummary'
import { formatPeriodTitle, type PeriodType } from '@/lib/reports/periodHelpers'

export const maxDuration = 90

// POST /api/reports/[id]/summary/generate — LLM-сводка по всем секциям.
// Использует уже заполненные object_reports + агрегатные показатели.
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const r = await supabaseAdmin
    .from('reports')
    .select('period_type, period_start, period_end, status, include_financials')
    .eq('id', id)
    .single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (r.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя пересобрать' }, { status: 409 })
  }

  const periodType = r.data.period_type as PeriodType
  const periodStart = new Date(r.data.period_start)
  const periodEndDate = new Date(r.data.period_end)
  const periodLabel = formatPeriodTitle(periodStart, periodEndDate, periodType)

  // Все секции отчёта + объекты
  const [secRes, objRes, stats] = await Promise.all([
    supabaseAdmin
      .from('object_reports')
      .select('object_id, project_movement, achievements, achievements_list, next_period_tasks, next_period_tasks_list, risks')
      .eq('report_id', id),
    supabaseAdmin.from('objects').select('id, code, current_name'),
    buildAllSectionStats(id, periodType, periodStart, periodEndDate),
  ])

  const objById = new Map<string, { code: string; current_name: string }>()
  for (const o of (objRes.data ?? []) as Array<{ id: string; code: string; current_name: string }>) {
    objById.set(o.id, { code: o.code, current_name: o.current_name })
  }
  const sections: SectionContext[] = (secRes.data ?? [])
    .map((s) => {
      const o = objById.get(s.object_id as string)
      if (!o) return null
      return {
        object_code: o.code,
        object_name: o.current_name,
        project_movement: s.project_movement as string | null,
        achievements: s.achievements as string | null,
        achievements_list: s.achievements_list as string | null,
        next_period_tasks: s.next_period_tasks as string | null,
        next_period_tasks_list: s.next_period_tasks_list as string | null,
        risks: s.risks as string | null,
      }
    })
    .filter((x): x is SectionContext => Boolean(x))
    .sort((a, b) => a.object_code.localeCompare(b.object_code))

  const filled = sections.filter((s) =>
    [s.project_movement, s.achievements, s.achievements_list, s.next_period_tasks, s.next_period_tasks_list, s.risks]
      .some((v) => v && v.trim().length > 0)
  )
  if (filled.length === 0) {
    return NextResponse.json({
      error: 'В отчёте нет ни одной заполненной секции — нечего обобщать. Сначала сгенерируйте секции по объектам.',
    }, { status: 409 })
  }

  let summary_md: string
  try {
    summary_md = await generateSummary(periodLabel, sections, stats, {
      include_financials: Boolean(r.data.include_financials),
    })
  } catch (e) {
    return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
  }

  const upd = await supabaseAdmin
    .from('reports')
    .update({ summary_md })
    .eq('id', id)
  if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 })

  return NextResponse.json({ summary_md })
}
