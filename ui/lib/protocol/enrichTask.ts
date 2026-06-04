/**
 * Серверный модуль: enrichTaskFromTranscript — вызов LLM (Polza.AI /
 * claude-sonnet-4.6) для ОДНОЙ задачи. По краткому описанию от пользователя
 * («что добавить в протокол») LLM ищет в транскрипции детали:
 * цитаты, исполнителя (по списку юр.лиц), срок, приоритет, объекты.
 *
 * Используется в режиме «правки утверждённого протокола» (см. route
 * /api/protocols/[id]/enrich-task), когда организация присылает замечание
 * «вы забыли вот это поручение, добавьте» — пользователь вводит фразу,
 * мы предзаполняем форму задачи, дальше человек правит и сохраняет.
 *
 * По образцу lib/protocol/extractTasksAndTopics.ts.
 */

import type { MeetingContext, TaskDraft } from './extractTasksAndTopics'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

const TEXT_LIMIT = 90_000

const SYSTEM_PROMPT = `Ты — ассистент руководителя проекта «Золотые Пески России».
Тебе дана транскрипция рабочего собрания и КРАТКОЕ ОПИСАНИЕ задачи от пользователя,
которую он хочет добавить в протокол (часто по замечанию организации после утверждения).

Твоя работа:
1. Найди в транскрипции место, где обсуждалось то, что описал пользователь.
2. Сформулируй задачу: title (короткий, до 70 символов, начинай с глагола),
   explanation (1-2 предложения, что именно сделать).
3. Извлеки 1-3 дословные цитаты из транскрипции, подтверждающие задачу.
4. Определи исполнителя (assignee_org) — это **юр.лицо, КОМУ поручили
   работу**, а НЕ тот, кто это произнёс на собрании. Правила:
   - Прямое обращение «<Орг>, сделайте X» / «<ФИО>, сделайте X»
     → assignee = эта организация (для ФИО — её юр.лицо из списка
     участников).
   - «Мы сделаем» / «я подготовлю» → assignee = организация говорящего.
   - Действие без явного адресата + типовая работа подрядчика
     → assignee = юр.лицо с role='contractor'.
   - Не назначай задачу заказчику (role='customer'), если он сам не
     взял её на себя.
   - Если однозначного исполнителя нет — null. Лучше null, чем неверное.
5. Определи срок (due_date YYYY-MM-DD) если он явно прозвучал — иначе null.
6. Приоритет: high | medium | low. По умолчанию medium.
7. Объекты (object_codes): коды из списка объектов проекта, к которым
   относится задача. Если описание/обсуждение не привязано к конкретному
   объекту — пустой массив.

Если в транскрипции НИЧЕГО похожего нет — всё равно верни задачу с пустыми
quotes ([]), но осмысленным title/explanation по описанию пользователя.
Помечай это в поле "found_in_transcript": false. Иначе true.

ВЕРНИ ТОЛЬКО валидный JSON. Без пояснений, без markdown-блоков.`

export interface EnrichedTaskDraft extends TaskDraft {
  /** false — LLM не нашла подтверждения в транскрипции (quotes пусты) */
  found_in_transcript: boolean
}

/**
 * Возвращает один черновик задачи, обогащённый по транскрипции.
 *
 * @param transcript текст транскрипции собрания (как из parseTranscriptFile)
 * @param ctx        контекст собрания (объекты/юр.лица/участники)
 * @param description краткое описание от пользователя — что нужно добавить
 */
export async function enrichTaskFromTranscript(
  transcript: string,
  ctx: MeetingContext,
  description: string,
): Promise<EnrichedTaskDraft> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в окружении')
  if (!description.trim()) throw new Error('description пустой')

  const text = transcript.length > TEXT_LIMIT
    ? transcript.slice(0, TEXT_LIMIT) + '\n[обрезано до 90 000 символов]'
    : transcript

  const orgsList = ctx.legal_entities
    .map((e) => {
      const roleStr = e.role ? ` [роль: ${e.role}]` : ''
      const aliasesStr = e.aliases.length ? ` (also: ${e.aliases.slice(0, 3).join(', ')})` : ''
      return `- ${e.name}${roleStr}${aliasesStr}`
    })
    .join('\n') || '(не указаны)'

  const objectsList = ctx.objects
    .map((o) => `- ${o.code}: ${o.current_name}`)
    .join('\n') || '(нет объектов)'

  const meetingObjects = ctx.object_codes.length > 0 ? ctx.object_codes.join(', ') : '(не указаны)'

  const userPrompt = `Контекст собрания:
- Дата: ${ctx.meeting_date}
- Название: ${ctx.title}
- Обсуждаемые объекты: ${meetingObjects}

Юр.лица собрания (используй ТОЧНЫЕ названия из этого списка для assignee_org).
Роли: contractor=подрядчик-исполнитель, customer=заказчик, operator=оператор, investor=инвестор, expert=эксперт, participant=прочий участник.
ВАЖНО: assignee_org = тот, КОМУ поручили действие, а НЕ тот, кто его произнёс.
Если в транскрипции явного исполнителя нет, и действие — типовая работа подрядчика, ставь assignee_org = юр.лицо с role=contractor.
Если не уверен — null.
${orgsList}

Все объекты проекта (используй коды для object_codes):
${objectsList}

Описание задачи от пользователя:
"""
${description.trim()}
"""

Транскрипция:
"""
${text}
"""

Верни строго следующий JSON (одну задачу):
{
  "title": "до 70 символов, начать с глагола",
  "explanation": "1-2 предложения раскрывающих суть",
  "assignee_org": "точное имя из списка юр.лиц или null",
  "due_date": "YYYY-MM-DD или null",
  "priority": "high|medium|low",
  "object_codes": ["NN_TYPE_NUM", ...],
  "quotes": [{"speaker_org": "организация или ?", "text": "дословная цитата"}],
  "found_in_transcript": true | false
}`

  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POLZA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`LLM HTTP ${response.status}: ${errText.slice(0, 500)}`)
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
  }
  const choice = json.choices?.[0]
  const content = choice?.message?.content
  if (!content) throw new Error('LLM вернула пустой ответ')

  if (choice?.finish_reason === 'length') {
    throw new Error('LLM-ответ обрезан по max_tokens. Сократите описание или транскрипцию.')
  }

  const parsed = parseJson(content)

  // Лёгкая нормализация. quotes/object_codes должны быть массивами,
  // priority — допустимое значение.
  const priority: 'high' | 'medium' | 'low' = parsed.priority === 'high' || parsed.priority === 'low'
    ? parsed.priority
    : 'medium'

  // Нормализуем quotes — оба поля обязательны в QuoteRef.
  const quotes = Array.isArray(parsed.quotes)
    ? parsed.quotes.map((q) => ({
        speaker_org: (q?.speaker_org ?? '?').toString(),
        text: (q?.text ?? '').toString(),
      })).filter((q) => q.text.length > 0)
    : []

  return {
    title: String(parsed.title ?? '').trim(),
    explanation: String(parsed.explanation ?? '').trim(),
    assignee_org: parsed.assignee_org ?? null,
    due_date: parsed.due_date ?? null,
    priority,
    object_codes: Array.isArray(parsed.object_codes) ? parsed.object_codes : [],
    quotes,
    found_in_transcript: Boolean(parsed.found_in_transcript),
  }
}

/** Парсинг JSON с устойчивостью к markdown-обёрткам. */
function parseJson(raw: string): {
  title?: string
  explanation?: string
  assignee_org?: string | null
  due_date?: string | null
  priority?: string
  object_codes?: string[]
  quotes?: { speaker_org?: string; text?: string }[]
  found_in_transcript?: boolean
} {
  const trimmed = raw.trim()
  const candidates: string[] = [trimmed]

  const fence = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/)
  if (fence) candidates.push(fence[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1))
  }

  let lastErr: unknown = null
  for (const c of candidates) {
    try { return JSON.parse(c) } catch (e) { lastErr = e }
  }
  throw new Error(
    `Не удалось распарсить JSON ответа LLM (${
      lastErr instanceof Error ? lastErr.message : 'parse error'
    }). Начало: ${trimmed.slice(0, 200)}`,
  )
}
