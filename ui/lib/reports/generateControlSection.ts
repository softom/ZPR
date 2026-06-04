import type { ControlContext, CalendarEntryRow } from './buildControlContext'
import type { EventRow, TaskRow, TopicRow } from './buildContext'
import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// Поля раздела control-отчёта по объекту.
//   narrative        — основной текстовый блок (3-5 абзацев, для руководства)
//   contract_summary — этапы договора (Массинг/ОПР/МОП) со сроками. Markdown-список.
//   decisions        — ключевые решения и поручения. Markdown-список.
export const CONTROL_FIELDS = ['narrative', 'contract_summary', 'decisions'] as const
export type ControlField = typeof CONTROL_FIELDS[number]
export type GeneratedControlSections = Partial<Record<ControlField, string>>

const FIELD_PROMPTS: Record<ControlField, string> = {
  narrative:
`"narrative" — Сжатый сухой нарратив по объекту для руководства/акционеров.
**ОБЪЁМ: 1 АБЗАЦ, 4-6 ПРЕДЛОЖЕНИЙ. БЕЗ ВОДЫ.**
**СУХАЯ КОНСТАТАЦИЯ ФАКТОВ. Это отчёт ТЗ, не статья.**

ЗАПРЕЩЕНО:
- Оценочные слова: «активная», «успешно», «эффективно», «прогресс»,
  «свидетельствует о», «значительный», «существенный», «качественно».
- Интерпретации («что говорит о…», «это означает что…»).
- Вывод о «фазе проекта» из косвенных признаков — упоминай только то что
  явно зафиксировано в данных.

ТРЕБОВАНИЯ:
1. **Открой первой фразой тем, что произошло за последнюю неделю** (за 7 дней
   до даты справки — точные даты окна даны ниже в промпте): свежие события,
   закрытые задачи, решённые за этот срок проблемы. Это главное «сейчас».
2. Затем — общая картина по объекту: что в целом закрыто/решено и что
   **в работе** (active-задачи, активные проблемы).
3. Ближайшие контрольные точки, срок ТЭП — одной фразой.
4. Изменения ФЗ — одной фразой, если были.

**НЕ начинай нарратив с вводного оборота про срок/окно выборки данных**
(никаких «за последние N дней», «за отчётный период N дней» в первой фразе —
окно сбора служебное и в текст справки не выносится). Первая фраза — сразу
КОНКРЕТНЫЕ свежие факты за последнюю неделю (см. «ОКНО ДЛЯ ПЕРВОЙ ФРАЗЫ»):
что получено / закрыто / решено за эти дни. Если за неделю событий нет —
начни с самого свежего факта по дате, тоже не упоминая длину окна. Пиши по
сути событий, а не про период их выборки.

**РАЗЛИЧАЙ «закрыто» (resolved/done) и «в работе» (active) — не смешивай в
одном утверждении.**

НЕ дублировать инфу из блока «Сводка» (подрядчик, № договора, текущий этап —
там уже отрисованы детерминированно).
НЕ делать длинные перечисления вариантов массинга / тем — для этого есть
decisions и contract_summary.

Если активности нет — «Активности по объекту за последний период не зафиксировано.»`,

  contract_summary:
`"contract_summary" — Этапы договора со сроками (Markdown-список, 2-5 пунктов).
Каждый пункт начинается с "- " и содержит:
- Название этапа (Массинг / Объёмно-планировочные решения / Места общего пользования / ТЭП)
- Статус: завершён / в работе / запланирован / не начат
- Срок: фактический или плановый (DD.MM.YYYY)
Если в источниках нет этапов договора — верни строку
"- Информация об этапах договора отсутствует."
Никогда не возвращай пустую строку.`,

  decisions:
`"decisions" — Ключевые решения и поручения по объекту (Markdown-список, 2-6 пунктов).
Каждый пункт через "- " — одно конкретное решение, поручение или обязательство:
- что решено / поручено
- кому (если назвали)
- срок (если был задан)
Включай решения с собраний, изменения ФЗ, поручения переговорной позиции.
Если ничего нет — верни строку
"- Ключевых решений за отчётный период не зафиксировано."`,
}

export async function generateControlSections(
  ctx: ControlContext,
  fields?: ControlField[],
): Promise<GeneratedControlSections> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')
  const requested = fields && fields.length > 0 ? fields : (CONTROL_FIELDS as readonly ControlField[]).slice()

  const prompt = buildPrompt(ctx, requested as ControlField[])

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
      response_format: { type: 'json_object' },
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err}`)
  }
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = parseLlmJson(content)
  const out: GeneratedControlSections = {}
  for (const f of requested as ControlField[]) {
    const v = parsed[f]
    out[f] = typeof v === 'string' ? v.trim() : ''
  }
  return out
}

function parseLlmJson(raw: string): Record<string, unknown> {
  const tries: string[] = [raw]
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  if (stripped !== raw) tries.push(stripped)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) tries.push(raw.slice(first, last + 1))
  let lastErr: unknown = null
  for (const t of tries) {
    try { return JSON.parse(t) as Record<string, unknown> } catch (e) { lastErr = e }
  }
  throw new Error(`Не удалось разобрать ответ LLM: ${(lastErr as Error)?.message ?? 'unknown'}. Первые 300 символов: ${raw.slice(0, 300)}`)
}

function buildPrompt(ctx: ControlContext, fields: ControlField[]): string {
  const { object, snapshotDate } = ctx
  const objectLabel = `${object.code} — ${object.current_name}`
  const snap = snapshotDate.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  // Граница «последней недели» — для выделения свежих событий в первой фразе.
  // Окно сбора данных глубже (60 дней), но первый акцент — на 7 днях.
  const weekAgoDate = new Date(snapshotDate.getTime() - 7 * 24 * 60 * 60 * 1000)
  const weekAgo = weekAgoDate.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })

  const jsonTemplate = `{\n${fields.map((f) => `  "${f}": "..."`).join(',\n')}\n}`
  const fieldDescriptions = fields.map((f) => FIELD_PROMPTS[f]).join('\n\n')

  const ownerHint = ctx.object.llm_hint?.trim()
  const includeFin = ctx.include_financials ?? false
  const tepLine = ctx.object.tep_deadline
    ? `Срок формирования ТЭП объекта: ${ctx.object.tep_deadline}.`
    : 'Срок формирования ТЭП — не задан в системе.'

  const ownerHintBlock = ownerHint
    ? `
═══════════════════════════════════════════════════
ПРИОРИТЕТНЫЙ КОНТЕКСТ ОТ ВЛАДЕЛЬЦА ОБЪЕКТА
═══════════════════════════════════════════════════
Считай эту информацию самой надёжной:

${ownerHint}
`
    : ''

  const financeBlock = includeFin
    ? ''
    : `
═══════════════════════════════════════════════════
ФИНАНСОВЫЕ СОБЫТИЯ — НЕ ВКЛЮЧАТЬ
═══════════════════════════════════════════════════
В этой Справке ТЗ финансовые аспекты НЕ упоминать (платежи, авансы, бюджеты,
суммы договоров). Только проектная и техническая составляющая.
`

  // Блок «Сводка» — детерминированно отрисуется в render. В промпте даём только
  // как КОНТЕКСТ, чтобы LLM не дублировал эту инфу в narrative.
  const aliasesPart = ctx.object.aliases?.length
    ? `Алиасы: ${ctx.object.aliases.join(', ')}.`
    : ''
  const contractsBlock = ctx.contracts && ctx.contracts.length > 0
    ? `
═══════════════════════════════════════════════════
БЛОК «СВОДКА» — УЖЕ ОТРИСОВАН В ОТЧЁТЕ (не дублируй!)
═══════════════════════════════════════════════════
Эти данные читатель видит ОТДЕЛЬНЫМ блоком над нарративом.
Не повторяй их в narrative — пиши ПРО что сейчас происходит, а не что есть.
${aliasesPart}
Договоры по объекту:
${ctx.contracts.map((c) => {
  const num = c.doc_number ? `№ ${c.doc_number}` : '(без номера)'
  const sd = c.signed_date ? `от ${c.signed_date}` : ''
  const contr = c.contractor_name ?? '— подрядчик не указан —'
  const stage = c.current_stage_name
    ? `текущий этап: ${c.current_stage_name}`
    : 'текущий этап не определён'
  return `• ${c.type} ${num} ${sd} с ${contr}, ${stage}`.replace(/\s+/g, ' ').trim()
}).join('\n')}
`
    : ''

  return `Ты — помощник руководителя строительного проекта «Золотые пески России».
Формируешь раздел Справки технического заказчика для РУКОВОДСТВА И АКЦИОНЕРОВ
на дату ${snap}.

${PROJECT_GLOSSARY}

Раздел — по объекту «${objectLabel}».
${tepLine}
${ownerHintBlock}${financeBlock}${contractsBlock}

═══════════════════════════════════════════════════
АУДИТОРИЯ И ТОН
═══════════════════════════════════════════════════
Это не технический отчёт за период, а ИНТЕГРАЛЬНЫЙ СНИМОК состояния объекта
на ${snap}, который ляжет на стол руководству и акционерам. Тон:
- деловой, нейтральный, без жаргона и кодов задач (ПРОТ-…)
- по существу: договор / этап / срок ТЭП / ключевые решения / переговорные позиции
- без перечисления «закрыто N задач, осталось M» — это для технического week-отчёта
- не упоминай другие объекты по именам/кодам (раздел — только про «${objectLabel}»)

═══ ОКНО ДЛЯ ПЕРВОЙ ФРАЗЫ ═══
Дата справки: ${snap}. Последняя неделя — с ${weekAgo} по ${snap}.
В ПЕРВОЙ фразе нарратива выдели события/задачи с датой в этом диапазоне
(самые свежие факты). Остальные источники ниже — общий фон глубже недели:
используй их для картины, но НЕ датируй текст «60 днями» и окно не озвучивай.

═══ КОЛИЧЕСТВЕННЫЕ ПОКАЗАТЕЛИ (для справки, не цитировать) ═══

Активных задач на объекте: ${ctx.tasks_active.length}
Из них просроченных: ${ctx.tasks_overdue.length}
Закрыто задач (недавних): ${ctx.tasks_recently_done.length}
Событий-фактов (недавних): ${ctx.events_recent.length}
Плановых этапов в графике: ${ctx.calendar_planned.length}
Тем обсуждений с собраний: ${ctx.recent_topics.length}

═══ ИСТОЧНИКИ ═══

АКТИВНЫЕ ЗАДАЧИ (${ctx.tasks_active.length}):
${formatTasks(ctx.tasks_active)}

ПРОСРОЧЕННЫЕ ЗАДАЧИ (${ctx.tasks_overdue.length}):
${formatTasks(ctx.tasks_overdue)}

ЗАКРЫТЫЕ ЗАДАЧИ — НЕДАВНИЕ (${ctx.tasks_recently_done.length}):
${formatTasks(ctx.tasks_recently_done)}

СОБЫТИЯ-ФАКТЫ — НЕДАВНИЕ (${ctx.events_recent.length}):
${formatEvents(ctx.events_recent)}

ПЛАНОВЫЕ ЭТАПЫ В ГРАФИКЕ (${ctx.calendar_planned.length}):
${formatCalendar(ctx.calendar_planned)}

ТЕМЫ ОБСУЖДЕНИЙ С СОБРАНИЙ (${ctx.recent_topics.length}):
${formatTopics(ctx.recent_topics)}

═══ LIFECYCLE ВАЖНЫХ СОБЫТИЙ (importance ∈ {high, critical}) ═══

✓ ПРОБЛЕМЫ, РЕШЁННЫЕ — НЕДАВНИЕ (${ctx.events_resolved_recent.length}):
[Дата закрытия (resolution_date) ≤ snapshot. → Это ДОСТИЖЕНИЯ.]
${formatEventsWithLifecycle(ctx.events_resolved_recent)}

🔓 ВАЖНЫЕ СОБЫТИЯ С АКТИВНЫМ FOLLOWUP (${ctx.events_active_problems.length}):
[Есть raised-задача open/in_progress. → Это работы в процессе. НЕ заявлять
как «риск», если событие нейтральное.]
${formatEventsWithLifecycle(ctx.events_active_problems)}

📌 ВАЖНЫЕ ФАКТЫ БЕЗ ЗАДАЧИ-FOLLOWUP (${ctx.events_risk_no_followup.length}):
[Важное событие без followup. ⚠ НЕ обязательно «риск»! Анализируй по title:
  • Положительные («получены», «согласован», «утверждены», «принято решение»)
    → в нарратив как достижение/движение.
  • Нейтральные («направлен», «представлен», «провёл») → как факт движения.
  • Явные негативы («выявлено», «отставание», «проблема», «не выполнено»)
    → в decisions с пометкой «требуется план действий».]
${formatEventsWithLifecycle(ctx.events_risk_no_followup)}

═══ ЗАДАЧА ═══

Верни строго JSON (без markdown-обёртки):

${jsonTemplate}

ОПИСАНИЯ ПОЛЕЙ:

${fieldDescriptions}

КРИТИЧНЫЕ ПРАВИЛА (повторно):
- НЕ СМЕШИВАЙ АТРИБУТЫ РАЗНЫХ задач/событий. Каждая задача обозначена
  префиксом [ID:КОД]. Все её атрибуты ([срок], [исполнено], исполнитель)
  принадлежат ИСКЛЮЧИТЕЛЬНО ей. Не переноси срок одной задачи на другую.
- НЕ ПРИДУМЫВАЙ ДАТЫ. Только из контекста: [срок:DD.MM.YYYY], [DD.MM.YYYY].
- НЕ упоминай коды задач (ПРОТ-…, СОБЫТ-…, [ID:…]) — это внутренние идентификаторы.
- Различай задачи и события — это разные сущности.

Верни ТОЛЬКО JSON. Без префиксов, без \`\`\`.`
}

function formatTasks(items: TaskRow[]): string {
  if (items.length === 0) return '— нет —'
  // [ID:КОД] — для LLM-трекинга атрибутов. В нарратив код не переносится.
  return items.map((t, i) => {
    const parts = [`${i + 1}.`, `[ID:${t.code}]`, `«${t.title}»`]
    if (t.assignee_org) parts.push(`(${t.assignee_org})`)
    if (t.priority) parts.push(`[приоритет:${t.priority}]`)
    if (t.due_date) parts.push(`[срок:${t.due_date}]`)
    if (t.done_date) parts.push(`[выполнено:${t.done_date}]`)
    if (t.explanation) parts.push(`— ${t.explanation}`)
    return parts.join(' ')
  }).join('\n')
}

function formatEvents(items: EventRow[]): string {
  if (items.length === 0) return '— нет —'
  return items.map((e, i) => {
    const parts = [`${i + 1}.`, `«${e.title}»`]
    const d = e.date_computed ?? e.date_end
    if (d) parts.push(`[${d}]`)
    if (e.note) parts.push(`— ${e.note}`)
    return parts.join(' ')
  }).join('\n')
}

function formatEventsWithLifecycle(items: EventRow[]): string {
  if (items.length === 0) return '— нет —'
  return items.map((e, i) => {
    const parts = [`${i + 1}.`, `«${e.title}»`]
    const d = e.date_computed ?? e.date_end
    if (d) parts.push(`[выявлено ${d}]`)
    if (e.importance) parts.push(`[★${e.importance}]`)
    if (e.is_resolved && e.resolved_date) {
      parts.push(`[РЕШЕНО ${e.resolved_date}: «${e.resolved_by_title ?? '—'}»]`)
    } else if (e.has_active_task) {
      parts.push(`[В РАБОТЕ: ${e.task_count ?? 0} задача(и)]`)
    } else if ((e.task_count ?? 0) === 0) {
      parts.push(`[нет followup-задачи]`)
    }
    if (e.note) parts.push(`— ${e.note}`)
    return parts.join(' ')
  }).join('\n')
}

function formatCalendar(items: CalendarEntryRow[]): string {
  if (items.length === 0) return '— нет —'
  return items.map((c, i) => {
    const parts = [`${i + 1}.`, `«${c.title}»`]
    if (c.entry_type) parts.push(`[${c.entry_type}]`)
    const d = c.date_planned ?? c.date_end
    if (d) parts.push(`[план ${d}]`)
    if (c.note) parts.push(`— ${c.note}`)
    return parts.join(' ')
  }).join('\n')
}

function formatTopics(items: TopicRow[]): string {
  if (items.length === 0) return '— нет —'
  return items.map((t, i) => {
    const parts = [`${i + 1}.`, `«${t.title}»`]
    if (t.meeting_date) parts.push(`(собрание ${t.meeting_date})`)
    if (t.content) parts.push(`— ${t.content}`)
    return parts.join(' ')
  }).join('\n')
}
