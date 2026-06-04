import type { ReportContext, EventRow, TaskRow, TopicRow } from './buildContext'
import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// Поля секции отчёта по объекту.
//
// MONTH (legacy 6-секционная структура — для месячных отчётов):
//   project_movement       — абзац о движении проекта
//   achievements           — описание достижений (абзац)
//   achievements_list      — основные пункты достижений (Markdown-список)
//   next_period_tasks      — описание задач следующего периода (абзац)
//   next_period_tasks_list — основные пункты задач (Markdown-список)
//   risks                  — абзац о рисках
//
// WEEK v3 (с 14.05.2026 — новая структура из weekly_report_DRAFT.md):
//   project_movement       — 1 абзац «Движение проекта за неделю»
//   weekly_done_brief      — Markdown-список «✓ Выполнено / зафиксировано»
//                            (события + закрытые задачи)
//   weekly_topics_brief    — связный абзац-обобщение тем собраний (курсивом
//                            в финальном MD, после блока «Выполнено»)
//   weekly_upcoming_brief  — Markdown-список «🔜 Предстоит» (активные задачи,
//                            задачи следующего периода)
export const REPORT_FIELDS = [
  'project_movement',
  'achievements',
  'achievements_list',
  'next_period_tasks',
  'next_period_tasks_list',
  'risks',
] as const

export const WEEKLY_V3_FIELDS = [
  'project_movement',
  'weekly_done_brief',
  'weekly_topics_brief',
  'weekly_upcoming_brief',
] as const

export type ReportField = typeof REPORT_FIELDS[number] | typeof WEEKLY_V3_FIELDS[number]

export type GeneratedSections = Partial<Record<ReportField, string>>

const FIELD_PROMPTS: Record<ReportField, string> = {
  // ─── Weekly v3 поля ───────────────────────────────────────────
  weekly_done_brief:
`"weekly_done_brief" — Список «✓ Выполнено / зафиксировано за неделю».
Markdown-список из 2-7 пунктов через "* " (звёздочка + пробел). Каждый пункт:
- ОБЯЗАТЕЛЬНО начинается с **даты в формате "DD.MM"** жирным шрифтом
- Далее — короткое утверждение что произошло (1 предложение)
- Если это закрытая задача — упомяни в утверждении (без кода задачи)
Если за неделю на объекте ничего не зафиксировано — верни строку
"* За отчётную неделю активности по объекту не зафиксировано."
Пример пункта:
"* **30.04** — получен документ «Инструкция по дизайну для номеров Club» от МЛА+."`,

  weekly_topics_brief:
`"weekly_topics_brief" — Краткое обобщение тем собраний за неделю
(если собрания были).
1 связный абзац, 2-4 предложения. ОБЪЕДИНЯЕТ темы в нарратив:
"Темы собрания DD.MM: согласовано X; зафиксирована Y; рассмотрены Z..."
Если за неделю собраний не было — верни пустую строку "".
Пример:
"Темы собрания 30.04: согласована смена бренда Select → Club с расширением
минимальной категории номера; зафиксирована концепция закрытого периметра
«всё включено»; рассмотрены 4 варианта массинга (отобраны 2 перспективных);
принят рабочий график до 10.06.2026 с контрольными точками 07.05 / 21.05 / 28.05."`,

  weekly_upcoming_brief:
`"weekly_upcoming_brief" — Список «🔜 Предстоит».
Markdown-список из 2-7 пунктов через "* ". В каждом пункте:
- Если есть срок — начинать с **жирным "до DD.MM"** или **жирным "до DD.MM.YYYY"**
- Если срока нет — начинать со слова "без срока"
- Дальше — суть задачи (короткое утверждение, без кода)
- В скобках в конце: исполнитель + приоритет курсивом, например "(МЛА+, _high_)"
Если нечего написать — "* На наступающую неделю плановых задач не запланировано."
Пример пункта:
"* **до 21.05** — представить планировочные решения на собрании (МЛА+, _high_)"`,

  // ─── Month/Legacy поля ─────────────────────────────────────────
  project_movement:
`"project_movement" — Движение проекта на этом объекте за период.
2-4 предложения. **СУХАЯ КОНСТАТАЦИЯ ФАКТОВ**, отчёт ТЗ для руководства.

ЗАПРЕЩЕНО:
- Оценочные слова: «активная», «успешно», «эффективно», «прогресс»,
  «свидетельствует о», «значительный», «существенный», «качественно».
- Интерпретации и выводы («что говорит о…», «это означает что…»).
- Эмоциональные формулировки.

ТРЕБОВАНИЯ К СОДЕРЖАНИЮ:
1. Сначала — что **закрыто в этот период**: количество завершённых задач,
   закрытых проблем (resolved-events). Если значимые есть — упомянуть в первой
   фразе («За период закрыты N задач, в том числе…»).
2. Затем — что **в работе сейчас** (активные задачи) — отдельной фразой,
   без слова «активная» (можно «В работе N задач», «Ведётся работа по N задачам»).
3. Если были собрания за период — упомяни факт («Состоялось N собраний»),
   без оценки результата.

Допустимо упомянуть числа — это факты. Запрещены прилагательные-оценки.

Если активности нет — «За период активных работ и закрытых задач не зафиксировано.»`,

  achievements:
`"achievements" — Достижения за период (общее описание, абзац без списка).
1-3 предложения: что в целом было достигнуто на этом объекте за период, куда
сместился прогресс. Без перечисления — это раздел-обобщение. Список самих пунктов
вернётся в "achievements_list".
Если за период нет ни одного события и ни одной закрытой задачи — «За отчётный
период завершённых задач и событий не зафиксировано.»`,

  achievements_list:
`"achievements_list" — Достижения за период (Markdown-список основных пунктов).
2-7 пунктов через "- ". Каждый пункт — одно событие или одно завершённое
направление работ; короткое описательное утверждение (1-2 предложения).
Включай как состоявшиеся события, так и закрытые задачи (задачи — обобщённо:
«Согласован вариант X», а не «Закрыта задача о согласовании X»).
Если за период действительно нет завершённых задач/событий — верни строку
"- За отчётный период завершённых задач и событий не зафиксировано." (никогда
не возвращай пустую строку).`,

  next_period_tasks:
`"next_period_tasks" — Задачи наступающего периода (общее описание, абзац без списка).
1-3 предложения: к чему предстоит прийти на этом объекте, какая общая ставка.
Без перечисления — список вернётся в "next_period_tasks_list".
Если ничего не запланировано — «На наступающий период плановых задач и событий
не запланировано.»`,

  next_period_tasks_list:
`"next_period_tasks_list" — Задачи наступающего периода (Markdown-список).
2-7 пунктов через "- ". Каждый — одна задача со сроком в окне или плановое
событие. В строке: что нужно сделать + кто ответственный (если есть) + срок
(если задан). Если плановых задач/событий в окне мало — добавь общие задачи
из активных, которые логично должны быть выполнены в этот период.
Если ничего не запланировано даже косвенно — верни строку
"- На наступающий период плановых задач и событий не запланировано."
(никогда не возвращай пустую строку).`,

  risks:
`"risks" — Риски на этом объекте.
2-4 предложения. Просрочки задач/событий на ЭТОМ объекте, темы с рисками из
обсуждений, накопившиеся проблемы. Если пусто — «Критичных рисков на дату
формирования отчёта не выявлено.»`,
}

// Один LLM-вызов на объект → возвращает запрошенные поля.
// По умолчанию:
//   - week  → 4 поля Weekly v3 (project_movement + 3 weekly_*)
//   - month → 6 полей legacy-структуры
// Если fields задан явно — используется как есть.
export async function generateSections(
  ctx: ReportContext,
  fields?: ReportField[],
): Promise<GeneratedSections> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')
  const defaultFields: readonly ReportField[] = ctx.period.type === 'week'
    ? WEEKLY_V3_FIELDS as readonly ReportField[]
    : REPORT_FIELDS as readonly ReportField[]
  const requested = fields && fields.length > 0 ? fields : defaultFields.slice()

  const prompt = buildPrompt(ctx, requested as ReportField[])

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
  const out: GeneratedSections = {}
  for (const f of requested as ReportField[]) {
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
    try {
      return JSON.parse(t) as Record<string, unknown>
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`Не удалось разобрать ответ LLM: ${(lastErr as Error)?.message ?? 'unknown'}. Первые 300 символов: ${raw.slice(0, 300)}`)
}

function buildPrompt(ctx: ReportContext, fields: ReportField[]): string {
  const { object, period } = ctx
  const objectLabel = `${object.code} — ${object.current_name}`
  const periodLabel = period.type === 'week'
    ? `неделя ${ddmmyyyy(period.start)} — ${ddmmyyyy(period.end)}`
    : `месяц ${ddmmyyyy(period.start)} — ${ddmmyyyy(period.end)}`
  const nextPeriodLabel = `${ddmmyyyy(period.nextStart)} — ${ddmmyyyy(period.nextEnd)}`

  // Выходной JSON-шаблон под запрошенные поля
  const jsonTemplate = `{\n${fields.map((f) => `  "${f}": "..."`).join(',\n')}\n}`

  // Описания только запрошенных полей
  const fieldDescriptions = fields.map((f) => FIELD_PROMPTS[f]).join('\n\n')

  const ownerHint = ctx.object.llm_hint?.trim()
  const includeFin = ctx.include_financials ?? false

  const ownerHintBlock = ownerHint
    ? `

═══════════════════════════════════════════════════
ПРИОРИТЕТНЫЙ КОНТЕКСТ ОТ ВЛАДЕЛЬЦА ОБЪЕКТА
═══════════════════════════════════════════════════
Владелец проекта дал ключевые факты по этому объекту, которые ВАЖНО
использовать при формировании любого раздела (особенно когда автоматических
данных мало). Считай это самой надёжной информацией:

${ownerHint}
`
    : ''

  const financeBlock = includeFin
    ? ''
    : `
═══════════════════════════════════════════════════
ФИНАНСОВЫЕ СОБЫТИЯ — НЕ ВКЛЮЧАТЬ
═══════════════════════════════════════════════════
В этом отчёте флаг «включать финансовые события» ВЫКЛЮЧЕН. НЕ упоминай:
- платежи, авансы, оплаты, возвраты
- бюджетные показатели, освоение средств
- финансовые условия договоров (суммы, штрафы, гарантии)
- задачи и события, связанные с финансовым учётом
Если задача или событие чисто финансовые — пропусти. Если содержит и
финансовый, и проектный аспект — пиши только о проектной части.
`

  // Блок договоров — для контекста (LLM использует чтобы понимать кто исполнитель
  // и какой текущий этап). Не выводится в финальный текст разделов.
  const contractsBlock = ctx.contracts && ctx.contracts.length > 0
    ? `
═══════════════════════════════════════════════════
ДОГОВОРЫ ПО ОБЪЕКТУ (контекст)
═══════════════════════════════════════════════════
${ctx.contracts.map((c) => {
  const parts = ['•']
  if (c.doc_number) parts.push(`№ ${c.doc_number}`)
  if (c.signed_date) parts.push(`от ${c.signed_date}`)
  if (c.contractor_name) parts.push(`с ${c.contractor_name}`)
  if (c.current_stage_name) parts.push(`— текущий этап: ${c.current_stage_name}`)
  return parts.join(' ')
}).join('\n')}
`
    : ''

  return `Ты — помощник руководителя строительного проекта «Золотые пески России».
Сформируй раздел отчёта по объекту «${objectLabel}» за ${periodLabel}.

${PROJECT_GLOSSARY}

═══════════════════════════════════════════════════
СТРОГОЕ ПРАВИЛО — ФОКУС НА ОДНОМ ОБЪЕКТЕ
═══════════════════════════════════════════════════
Это раздел отчёта **только** по объекту «${objectLabel}». Всё, что ты напишешь,
должно относиться к работе на ЭТОМ объекте. Если задача или событие связаны с
несколькими объектами — пиши про них только в части, относящейся к «${objectLabel}».
${contractsBlock}
Не упоминай другие объекты по именам или кодам.
${ownerHintBlock}${financeBlock}

═══ КОЛИЧЕСТВЕННЫЕ ПОКАЗАТЕЛИ ═══

Задачи на этом объекте:
- закрыто за период: ${ctx.tasks_done_in_period.length}
- активных всего сейчас: ${ctx.tasks_active.length}
- из них просроченных: ${ctx.tasks_overdue.length}
- со сроком в наступающем периоде: ${ctx.tasks_due_next_period.length}

События на этом объекте:
- состоявшихся в период: ${ctx.events_in_period.length}
- плановых на наступающий период: ${ctx.events_next_period.length}
- просроченных: ${ctx.events_overdue.length}

Темы обсуждений (±2 недели от периода): ${ctx.recent_topics.length}

═══ КОНТЕКСТ — СПИСКИ ═══

ВЫПОЛНЕНО ЗА ПЕРИОД (${ctx.tasks_done_in_period.length} задач):
${formatTasks(ctx.tasks_done_in_period)}

СОБЫТИЯ ЗА ПЕРИОД (${ctx.events_in_period.length}):
${formatEvents(ctx.events_in_period)}

ТЕКУЩИЕ АКТИВНЫЕ ЗАДАЧИ (${ctx.tasks_active.length}):
${formatTasks(ctx.tasks_active)}

ОБСУЖДЕНИЯ С СОБРАНИЙ (${ctx.recent_topics.length}):
${formatTopics(ctx.recent_topics)}

ПЛАНОВЫЕ СОБЫТИЯ В НАСТУПАЮЩЕМ ПЕРИОДЕ (${nextPeriodLabel}, ${ctx.events_next_period.length}):
${formatEvents(ctx.events_next_period)}

ЗАДАЧИ К НАСТУПАЮЩЕМУ ПЕРИОДУ (${ctx.tasks_due_next_period.length}):
${formatTasks(ctx.tasks_due_next_period)}

ПРОСРОЧЕННЫЕ ЗАДАЧИ (${ctx.tasks_overdue.length}):
${formatTasks(ctx.tasks_overdue)}

ПРОСРОЧЕННЫЕ СОБЫТИЯ (${ctx.events_overdue.length}):
${formatEvents(ctx.events_overdue)}

═══ LIFECYCLE ВАЖНЫХ СОБЫТИЙ (importance ∈ {high, critical}) ═══

Семантика трёх категорий важных событий:

✓ ПРОБЛЕМЫ, РЕШЁННЫЕ ЗА ПЕРИОД (${ctx.events_resolved_in_period.length}):
[Дата закрытия (resolution_date) в окне отчёта. → ДОСТИЖЕНИЯ — упомянуть с
указанием цепочки «выявлено → решено».]
${formatEventsWithLifecycle(ctx.events_resolved_in_period)}

🔓 ВАЖНЫЕ СОБЫТИЯ С АКТИВНЫМ FOLLOWUP (${ctx.events_active_problems.length}):
[Есть raised-задача open/in_progress по этому событию. → Это работы в процессе.
Упомянуть как факт + индикация прогресса. НЕ заявлять как «риск», если событие
по своей сути нейтральное (например, «получены замечания» — это рабочий факт).]
${formatEventsWithLifecycle(ctx.events_active_problems)}

📌 ВАЖНЫЕ ФАКТЫ БЕЗ ЗАДАЧИ-FOLLOWUP (${ctx.events_risk_no_followup.length}):
[Важное событие без раздела-followup. ⚠ ВНИМАНИЕ: эта категория НЕ обязательно
«риски»! Здесь могут быть и положительные/нейтральные факты:
  • «Получены ТУ» — позитив, в Движение/Достижения
  • «Согласован вариант» — позитив, в Движение/Достижения
  • «Утверждены показатели» — позитив, в Достижения
  • «Направлен документ» — нейтральный факт, в Движение
  • «Выявлено отставание» — негатив, в Риски

АНАЛИЗИРУЙ каждое событие по содержанию title и направляй в правильный
раздел отчёта: положительные/нейтральные — в Движение или Достижения,
явные негативы («выявлено», «отставание», «проблема», «не выполнено») —
в Риски.]
${formatEventsWithLifecycle(ctx.events_risk_no_followup)}

═══ ЗАДАЧА ═══

Верни строго JSON (без markdown-обёртки) c полями ниже:

${jsonTemplate}

ПРАВИЛА:
- **СУХАЯ КОНСТАТАЦИЯ ФАКТОВ. Это отчёт, не статья и не пресс-релиз.**
- ЗАПРЕЩЕНЫ оценочные/интерпретирующие слова: «активная», «успешно»,
  «эффективно», «прогресс», «свидетельствует о», «значительный»,
  «существенный», «качественно», «успешный», «продуктивный», «фокус на».
- Не делай выводов о «фазе проекта», «этапе работ» из косвенных признаков —
  если фаза не зафиксирована явно в данных, не упоминай её.
- **РАЗЛИЧАЙ «закрыто за период» (resolved/done) и «в работе сейчас» (active).**
  Это разные категории — не смешивай их в одном утверждении.
  Закрытое идёт в первой фразе как достижение, активное — отдельно.
- **КРИТИЧНО — НЕ СМЕШИВАЙ АТРИБУТЫ РАЗНЫХ ЗАДАЧ/СОБЫТИЙ.** Каждая задача
  в контексте обозначена префиксом [ID:КОД] — это её собственный идентификатор.
  Все её атрибуты (срок, исполнитель, статус, объяснение) относятся ИСКЛЮЧИТЕЛЬНО
  к ней. Если упоминаешь срок задачи — это срок именно этой задачи, не другой.
  Если упоминаешь две задачи — каждая со своим сроком, не объединяй их.
- **НЕ ПРИДУМЫВАЙ ДАТЫ.** Используй только даты из контекста — поле [срок:DD.MM.YYYY],
  [выполнено:DD.MM.YYYY], дата события «[DD.MM.YYYY]». Не сочиняй и не вычисляй сам.
- Деловой нейтральный тон, как сводка
- Не упоминай коды задач (ПРОТ-…, СОБЫТ-…, [ID:…]) — это внутренние идентификаторы
- Не упоминай другие объекты по именам/кодам
- Не используй фразы «по списку», «как видно из задач»
- Если поле "..._list" — это Markdown-список через "- ", иначе обычный абзац
- Если по полю нет данных — верни пустую строку "" (для list-полей) или явный
  fallback ("На объекте в текущем периоде активных работ не зафиксировано." и т.п.)

ОПИСАНИЯ ПОЛЕЙ:

${fieldDescriptions}

Верни ТОЛЬКО JSON. Без префиксов, без \`\`\`.`
}

// ─── форматтеры ─────────────────────────────────────────────────

function formatTasks(items: TaskRow[]): string {
  if (items.length === 0) return '— нет —'
  // Каждая задача начинается с код-идентификатора в [ID:...] — он нужен
  // только LLM для трекинга атрибутов (срок, статус, исполнитель — относятся
  // к ЭТОЙ конкретной задаче). В итоговый нарратив этот ID НЕ переносится
  // (запрещено в общих правилах промпта).
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
    // events после сплита 20260508 — всегда факты; date = date_computed/date_end
    const d = e.date_computed ?? e.date_end
    if (d) parts.push(`[${d}]`)
    if (e.note) parts.push(`— ${e.note}`)
    return parts.join(' ')
  }).join('\n')
}

// Расширенный формат с lifecycle-инфо: цепочка «выявлено → resolved-task → resolved-event».
// Используется в блоках «Решено за период» / «Активные проблемы» / «Риски».
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

function formatTopics(items: TopicRow[]): string {
  if (items.length === 0) return '— нет —'
  return items.map((t, i) => {
    const parts = [`${i + 1}.`, `«${t.title}»`]
    if (t.meeting_date) parts.push(`(собрание ${t.meeting_date})`)
    if (t.content) parts.push(`— ${t.content}`)
    return parts.join(' ')
  }).join('\n')
}

function ddmmyyyy(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
