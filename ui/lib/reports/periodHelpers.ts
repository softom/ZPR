// Period helpers для отчётов (week/month).
// week  = пн-вс, 7 дней. period_start = понедельник, period_end = воскресенье.
// month = 1-е по последнее число календарного месяца.

export type PeriodType = 'week' | 'month'

// Снэп даты к началу периода: пн (для week) или 1-е число месяца.
export function snapToPeriodStart(date: Date | string, periodType: PeriodType): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  if (periodType === 'week') {
    // ISO неделя: пн = 1, вс = 7. JS getDay(): вс = 0, пн = 1.
    const day = d.getDay() || 7
    d.setDate(d.getDate() - (day - 1))
    return d
  }
  // month: 1-е число
  d.setDate(1)
  return d
}

// Конец периода (последний день — включительно).
export function periodEnd(start: Date | string, periodType: PeriodType): Date {
  const d = new Date(start)
  d.setHours(0, 0, 0, 0)
  if (periodType === 'week') {
    d.setDate(d.getDate() + 6)
    return d
  }
  // month: последний день месяца — день 0 следующего месяца
  const next = new Date(d)
  next.setMonth(next.getMonth() + 1, 1)
  next.setDate(0)
  return next
}

// Длина периода в днях (вкл. границы).
export function periodLengthDays(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1
}

// Следующий период (для «Задач наступающего периода»):
//   week  → следующие 7 дней (пн-вс)
//   month → следующий календарный месяц
export function nextPeriod(end: Date, periodType: PeriodType): { start: Date; end: Date } {
  const nextStart = new Date(end)
  nextStart.setDate(end.getDate() + 1)
  return { start: nextStart, end: periodEnd(nextStart, periodType) }
}

// ISO date string YYYY-MM-DD (для Supabase).
export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// Человекочитаемый заголовок периода (короткий, для списков).
export function formatPeriodTitle(start: Date, end: Date, periodType: PeriodType): string {
  const fmt = (d: Date) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  if (periodType === 'week') {
    return `Неделя ${fmt(start)} — ${fmt(end)}`
  }
  // month: "Январь 2026"
  const monthName = start.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
  return monthName.charAt(0).toUpperCase() + monthName.slice(1)
}

// Тип отчёта в форме прилагательного для титула: «Отчёт еженедельный …».
export function periodKindWord(periodType: PeriodType): string {
  return periodType === 'week' ? 'еженедельный' : 'ежемесячный'
}

// Фраза периода для расширенного титула:
//   week  — "с 13 по 19 мая 2026 года" (если один месяц/год)
//             "с 27 апреля по 3 мая 2026 года" (разные месяцы)
//             "с 27 декабря 2025 по 2 января 2026 года" (разные годы)
//   month — "май 2026 года" (родительный падеж)
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]

export function formatPeriodPhrase(start: Date, end: Date, periodType: PeriodType): string {
  if (periodType === 'month') {
    const m = MONTHS_NOMINATIVE[start.getMonth()]
    return `${m} ${start.getFullYear()} года`
  }
  // week: "с D[ M] по D M YYYY года"
  const sd = start.getDate()
  const ed = end.getDate()
  const sm = MONTHS_GENITIVE[start.getMonth()]
  const em = MONTHS_GENITIVE[end.getMonth()]
  const sy = start.getFullYear()
  const ey = end.getFullYear()

  if (sy !== ey) {
    return `с ${sd} ${sm} ${sy} по ${ed} ${em} ${ey} года`
  }
  if (start.getMonth() !== end.getMonth()) {
    return `с ${sd} ${sm} по ${ed} ${em} ${ey} года`
  }
  return `с ${sd} по ${ed} ${em} ${ey} года`
}
