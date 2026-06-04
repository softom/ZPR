// Определяет, утверждает ли llm_hint объекта «паузу/неактивность» — и при этом
// в БД есть свежая активность (задачи / темы / события за последние 30 дней).
// Используется для предупреждающего badge в UI отчёта.

export type RecentActivity = {
  tasks_active: number   // активных задач + закрытых за 30 дней
  topics_30d: number     // тем собраний за 30 дней
  events_30d: number     // событий-фактов за 30 дней
}

// ВАЖНО: в JS regex `\b` работает только для ASCII-букв — кириллицу не
// распознаёт. Поэтому используем lookbehind `(?<![а-яёa-zA-Z])` для границы
// слова, который ловит и кириллицу и латиницу.
const PAUSE_PATTERNS: RegExp[] = [
  /(?<![а-яёa-zA-Z])пауз[аеуы]/i,                          // "пауза", "на Паузе"
  /(?<![а-яёa-zA-Z])на\s+стопе(?![а-яёa-zA-Z])/i,          // "на стопе"
  /(?<![а-яёa-zA-Z])приостановл/i,                         // "приостановлен"
  /(?<![а-яёa-zA-Z])не\s+ведут(ся|сь)/i,                   // "не ведутся"
  /(?<![а-яёa-zA-Z])не\s+активн/i,                         // "не активный"
  /(?<![а-яёa-zA-Z])заморож/i,                             // "заморожен"
  /(?<![а-яёa-zA-Z])не\s+касают(ся|сь)\s+(данного|этого)/i, // "не касаются данного"
  /(?<![а-яёa-zA-Z])касают(ся|сь)[,\s]+других\s+объект/i,  // "касаются, других объектов"
]

export type StaleHintFinding = {
  isStale: boolean
  reasons: string[]            // ['hint утверждает паузу', '5 активных задач', ...]
  activitySummary: string      // компактное описание для tooltip
}

export function detectStaleLlmHint(
  hint: string | null | undefined,
  activity: RecentActivity | null | undefined,
): StaleHintFinding {
  const h = (hint ?? '').trim()
  if (h.length === 0 || !activity) {
    return { isStale: false, reasons: [], activitySummary: '' }
  }

  const matchedPattern = PAUSE_PATTERNS.find((re) => re.test(h))
  if (!matchedPattern) {
    return { isStale: false, reasons: [], activitySummary: '' }
  }

  const hasActivity = activity.tasks_active > 0
                   || activity.topics_30d > 0
                   || activity.events_30d > 0
  if (!hasActivity) {
    return { isStale: false, reasons: [], activitySummary: '' }
  }

  const reasons: string[] = ['hint утверждает паузу/неактивность']
  if (activity.tasks_active > 0) reasons.push(`${activity.tasks_active} активных задач`)
  if (activity.topics_30d > 0) reasons.push(`${activity.topics_30d} тем собраний за 30 дней`)
  if (activity.events_30d > 0) reasons.push(`${activity.events_30d} событий за 30 дней`)

  const activitySummary = [
    activity.tasks_active > 0 ? `задач: ${activity.tasks_active}` : '',
    activity.topics_30d > 0 ? `тем: ${activity.topics_30d}` : '',
    activity.events_30d > 0 ? `событий: ${activity.events_30d}` : '',
  ].filter(Boolean).join(' · ')

  return { isStale: true, reasons, activitySummary }
}
