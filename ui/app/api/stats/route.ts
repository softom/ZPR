import { NextRequest, NextResponse } from 'next/server'
import { buildStatsForPeriod } from '@/lib/reports/sectionStats'
import { snapToPeriodStart, periodEnd as periodEndFn, type PeriodType } from '@/lib/reports/periodHelpers'

// GET /api/stats?type=week|month&start=YYYY-MM-DD
//
// Экспресс-статистика по всем активным объектам за выбранный период.
// Не сохраняется в reports — это «срез на лету» для страницы /reports/stats.
//
// Если start не указан — текущий период (понедельник этой недели / 1-е число месяца).
// Если период включает сегодня — срез на today; если завершён — на period_end.
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const typeRaw = url.searchParams.get('type') ?? 'week'
  if (typeRaw !== 'week' && typeRaw !== 'month') {
    return NextResponse.json({ error: 'type должен быть week|month' }, { status: 400 })
  }
  const periodType = typeRaw as PeriodType
  const startRaw = url.searchParams.get('start') ?? new Date().toISOString().slice(0, 10)

  const periodStart = snapToPeriodStart(startRaw, periodType)
  const periodEndDate = periodEndFn(periodStart, periodType)

  const { stats, totals } = await buildStatsForPeriod(periodType, periodStart, periodEndDate)

  return NextResponse.json({
    period: {
      type: periodType,
      start: periodStart.toISOString().slice(0, 10),
      end: periodEndDate.toISOString().slice(0, 10),
    },
    stats,
    totals,
  })
}
