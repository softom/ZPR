import type { SectionStatsWithObject } from './sectionStats'
import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// Контекст одной секции для пересказа на уровне отчёта (6 полей).
export type SectionContext = {
  object_code: string
  object_name: string
  project_movement: string | null
  achievements: string | null
  achievements_list: string | null
  next_period_tasks: string | null
  next_period_tasks_list: string | null
  risks: string | null
}

// LLM-сводка по всему проекту в Markdown.
// Источник: текст всех секций объектов + агрегатные показатели + per-object числа.
export async function generateSummary(
  periodLabel: string,
  sections: SectionContext[],
  stats: SectionStatsWithObject[],
  options?: { include_financials?: boolean },
): Promise<string> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')

  const totals = stats.reduce(
    (acc, s) => ({
      tasks_done: acc.tasks_done + s.tasks_done,
      tasks_active: acc.tasks_active + s.tasks_active,
      tasks_overdue: acc.tasks_overdue + s.tasks_overdue,
      tasks_due_next: acc.tasks_due_next + s.tasks_due_next,
      events_in_period: acc.events_in_period + s.events_in_period,
      events_next_period: acc.events_next_period + s.events_next_period,
      events_overdue: acc.events_overdue + s.events_overdue,
    }),
    { tasks_done: 0, tasks_active: 0, tasks_overdue: 0, tasks_due_next: 0, events_in_period: 0, events_next_period: 0, events_overdue: 0 },
  )

  // Маппинг object_code → stats для подстановки чисел в каждую секцию
  const statsByCode = new Map<string, SectionStatsWithObject>()
  for (const st of stats) statsByCode.set(st.object_code, st)

  const sectionsText = sections.map((s) => {
    const st = statsByCode.get(s.object_code)
    const numbersLine = st
      ? `**Показатели за период:** закрыто задач — ${st.tasks_done}; активных задач — ${st.tasks_active} (просрочено ${st.tasks_overdue}); событий состоялось — ${st.events_in_period}; плановых далее — ${st.events_next_period}; просрочено событий — ${st.events_overdue}; тем обсуждений — ${st.topics_recent}.`
      : ''

    const totalActivity = st
      ? st.tasks_done + st.tasks_active + st.events_in_period + st.events_next_period + st.events_overdue + st.topics_recent
      : 0
    const noActivity = totalActivity === 0
    const allSectionsEmpty = ![s.project_movement, s.achievements, s.next_period_tasks, s.risks]
      .some((v) => v && v.trim().length > 0)
    const marker = noActivity && allSectionsEmpty
      ? ' _(объект без активности в периоде)_'
      : ''

    const achievementsBlock = [s.achievements?.trim(), s.achievements_list?.trim()].filter(Boolean).join('\n')
    const nextBlock = [s.next_period_tasks?.trim(), s.next_period_tasks_list?.trim()].filter(Boolean).join('\n')
    const lines = [
      `### ${s.object_code} — ${s.object_name}${marker}`,
      numbersLine,
      `**Существующее движение:** ${s.project_movement?.trim() || '—'}`,
      `**Достижения:**\n${achievementsBlock || '—'}`,
      `**Задачи наступающего периода:**\n${nextBlock || '—'}`,
      `**Риски:** ${s.risks?.trim() || '—'}`,
    ].filter(Boolean)
    return lines.join('\n')
  }).join('\n\n')

  const activeCount = stats.filter((st) =>
    st.tasks_done + st.tasks_active + st.events_in_period + st.events_next_period + st.events_overdue + st.topics_recent > 0
  ).length
  const inactiveCount = stats.length - activeCount

  const includeFin = options?.include_financials ?? false
  const financeBlock = includeFin ? '' : `

ВАЖНО: Флаг «включать финансовые события» ВЫКЛЮЧЕН для этого отчёта.
НЕ включай в сводку:
- платежи, авансы, оплаты, бюджеты, освоение средств
- финансовые условия договоров (суммы, штрафы, гарантии)
- риски и достижения, связанные исключительно с финансовой стороной
Если в секциях объектов упоминаются финансовые аспекты — игнорируй их при
формировании общей сводки.
`

  const prompt = `Ты — помощник руководителя строительного проекта «Золотые Пески России».
Сформируй общую сводку по проекту за ${periodLabel} на основе разделов по объектам.

${PROJECT_GLOSSARY}
${financeBlock}

═══ АГРЕГАТНЫЕ ПОКАЗАТЕЛИ ПО ВСЕМ ОБЪЕКТАМ ═══

Задачи:
- закрыто за период: ${totals.tasks_done}
- активных всего сейчас: ${totals.tasks_active}
- просроченных: ${totals.tasks_overdue}
- со сроком в наступающем периоде: ${totals.tasks_due_next}

События:
- состоявшихся: ${totals.events_in_period}
- плановых на наступающий период: ${totals.events_next_period}
- просроченных: ${totals.events_overdue}

Объектов в отчёте: ${sections.length} (с активностью: ${activeCount}, без активности в периоде: ${inactiveCount})

═══ ПО ОБЪЕКТАМ ═══

Внимание: для каждого объекта ниже указаны (a) числовые показатели за период,
(b) текстовые секции (если они заполнены LLM). Если у объекта числа > 0, но секции
пустые — это значит, что объект имеет активность по событиям/задачам, просто
его раздел ещё не сгенерирован. Учитывай это в обобщении: упоминай такой объект
по числам, не пиши «нет движения».

${sectionsText}

═══ ЗАДАЧА ═══

Верни сводку в Markdown по структуре:

## Общая сводка периода

(2-3 абзаца обобщения: ключевые сдвиги по проекту в целом — что произошло на крупных
объектах, где главные точки прогресса, где общая динамика. Не пересказывай каждый
объект отдельно, обобщай по подрядчикам/группам объектов. **Объектов с реальной
активностью** (числа > 0) — ${activeCount}; **без активности в периоде** —
${inactiveCount}. Опиши именно эту картину распределения. НЕ пиши «остальные объекты
не показали движения», если у них есть закрытые задачи или прошедшие события —
такие объекты тоже движутся, просто их секция не сгенерирована.)

## Ключевые достижения

(маркированный список из 3-5 главных результатов периода через "- ". Каждый — короткое
утверждение. Если у объекта числа > 0 (закрыты задачи, состоялись события) — это
повод включить его в достижения, даже если текстовая секция пустая. Не упоминай
коды задач.)

## Главные риски

(маркированный список из 3-5 ключевых рисков через "- ". Каждый — конкретная угроза
с указанием, где это проявляется (например «по корпоративным согласованиям» или «у
подрядчика по проектированию»). Если у объекта много просрочек по числам — это риск.)

## Фокус наступающего периода

(2-3 предложения: на что сместится внимание в следующий период. Учти числа плановых
событий и задач со сроком впереди.)

ТРЕБОВАНИЯ:
- Деловой нейтральный тон
- Не упоминай коды задач (ПРОТ-…)
- Именами организаций оперируй только когда это даёт смысл (ответственный за блок)
- Не дублируй цифры из таблицы показателей дословно — обобщай словами
- Возвращай ТОЛЬКО Markdown. Без \`\`\` обёртки.`

  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err}`)
  }
  const data = await response.json()
  let content: string = data.choices?.[0]?.message?.content ?? ''
  // Очистка markdown-fence на случай, если модель проигнорировала запрет
  content = content.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  return content.trim()
}
