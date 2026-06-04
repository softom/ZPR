/**
 * Серверный модуль: вызов LLM (Polza.AI / claude-sonnet-4.6) для извлечения
 * задач и тем «Обсудили» из транскрипции рабочего собрания.
 *
 * По образцу lib/parser/extractClauses.ts.
 */

import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

const TEXT_LIMIT = 90_000

export interface MeetingContext {
  meeting_date: string                            // YYYY-MM-DD
  title: string
  object_codes: string[]
  objects: { code: string; current_name: string }[]
  /**
   * Юр.лица собрания. role — из meeting_legal_entities.role
   * (contractor / customer / operator / investor / expert / participant).
   * LLM использует это, чтобы по умолчанию назначать assignee_org = подрядчик,
   * когда из текста явно не следует другой исполнитель.
   */
  legal_entities: { id: string; name: string; aliases: string[]; role?: string }[]
  participants: { fio: string; org: string; role?: string }[]
}

export interface QuoteRef {
  speaker_org: string
  text: string
}

export interface TaskDraft {
  title: string
  explanation: string
  assignee_org: string | null
  due_date: string | null    // YYYY-MM-DD
  priority: 'high' | 'medium' | 'low'
  object_codes: string[]
  quotes: QuoteRef[]
}

export interface TopicDraft {
  title: string
  content: string
  raised_by_org: string | null
  object_codes: string[]
  quotes: QuoteRef[]
}

export interface ExtractResult {
  tasks: TaskDraft[]
  topics: TopicDraft[]
}

const SYSTEM_PROMPT = `Ты — ассистент руководителя проекта «Золотые Пески России» (туристический комплекс из 8 объектов).
Извлеки из транскрипции рабочего собрания ЗАДАЧИ и ТЕМЫ.

${PROJECT_GLOSSARY}

ЗАДАЧИ — поручения с явным действием (глагол) и ответственным:
- Формулировка: «Подготовить X», «Направить Y», «Доработать Z»
- Признак: конкретное действие + исполнитель
- Опционально: срок, приоритет, объекты

ТЕМЫ (Обсудили) — пункты обсуждения без действия:
- Констатации фактов
- Решения без поручения
- Обмен мнениями, обсуждения подходов
- Формулировка: «Обсудили X», «Принято решение Y», «Подтверждено Z»

═══ КРИТИЧЕСКОЕ ПРАВИЛО про assignee_org ═══

assignee_org — это **ЮРИДИЧЕСКОЕ ЛИЦО-ИСПОЛНИТЕЛЬ**, тот, КОМУ поручили
сделать работу. Это НЕ «кто произнёс реплику».

❌ Частая ошибка: брать организацию говорящего из транскрипции.
   Пример: представитель ТЗ-ЮГ говорит «Хэдс Групп, подготовьте чертежи».
   НЕВЕРНО: assignee_org = "ООО «Технический заказчик-ЮГ»" (это спикер).
   ВЕРНО:   assignee_org = "ООО «Хэдс Групп»" (тот, кому поручили).

Правила выбора assignee_org:
1. Прямое обращение «<Орг>, сделайте X» / «<ФИО>, сделайте X»
   → assignee = эта организация (для ФИО — её юр.лицо из списка участников).
2. «Мы сделаем» / «я подготовлю» — assignee = организация говорящего
   (исполнитель сам взял обязательство).
3. Действие без явного адресата («нужно подготовить X») и контекст
   подсказывает «это работа подрядчика» → assignee = юр.лицо с
   role='contractor' из списка юр.лиц собрания. Иначе — null.
4. Не назначай задачу заказчику (role='customer'), если он сам не взял
   её словами «я / мы сделаем».
5. Если однозначного исполнителя нет → null. Лучше null, чем неверное юр.лицо.

speaker_org в quotes — это «кто произнёс эту фразу». Это **другое поле**,
оно не определяет assignee_org.

═══════════════════════════════════════════════════

При двусмысленности (задача или тема) — приоритет «задача».
Не дублируй между tasks и topics.
Не повторяй одну и ту же мысль в разных пунктах.
title — краткий, до 70 символов, с глагола (для задач) или с темы (для topics).
quotes — 1-3 дословные цитаты из транскрипции.

ВЕРНИ ТОЛЬКО валидный JSON. Без пояснений, без markdown-блоков.`

export async function extractTasksAndTopics(
  transcript: string,
  ctx: MeetingContext,
): Promise<ExtractResult> {
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

  const participantsList = ctx.participants
    .map((p) => `- ${p.fio} (${p.org}${p.role ? `, ${p.role}` : ''})`)
    .join('\n') || '(не указаны)'

  const meetingObjects = ctx.object_codes.length > 0 ? ctx.object_codes.join(', ') : '(не указаны)'

  const userPrompt = `Контекст собрания:
- Дата: ${ctx.meeting_date}
- Название: ${ctx.title}
- Обсуждаемые объекты: ${meetingObjects}

Юр.лица собрания (используй ТОЧНЫЕ названия из этого списка для assignee_org / raised_by_org).
Роли: contractor=подрядчик-исполнитель, customer=заказчик, operator=оператор, investor=инвестор, expert=эксперт, participant=прочий участник.
ВАЖНО: assignee_org = тот, КОМУ поручили действие, а НЕ тот, кто его произнёс.
Если в реплике явного исполнителя нет, и действие — типовая работа подрядчика, ставь assignee_org = юр.лицо с role=contractor.
Если не уверен — null.
${orgsList}

Все объекты проекта (используй коды из этого списка для object_codes):
${objectsList}

Участники собрания:
${participantsList}

Транскрипция:
"""
${text}
"""

Верни строго следующий JSON:
{
  "tasks": [
    {
      "title": "до 70 символов, начать с глагола",
      "explanation": "1-2 предложения раскрывающих суть",
      "assignee_org": "точное имя из списка юр.лиц или null",
      "due_date": "YYYY-MM-DD или null",
      "priority": "high|medium|low",
      "object_codes": ["NN_TYPE_NUM", ...],
      "quotes": [{"speaker_org": "организация-говорящий или ?", "text": "дословная цитата"}]
    }
  ],
  "topics": [
    {
      "title": "короткий заголовок темы",
      "content": "1-3 предложения, что именно обсуждалось",
      "raised_by_org": "организация поднявшая или null",
      "object_codes": [...],
      "quotes": [{"speaker_org": "...", "text": "..."}]
    }
  ]
}`

  if (!POLZA_API_KEY) {
    throw new Error('POLZA_API_KEY не задан в окружении')
  }

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
      // 16k токенов на ответ. При 90k символов транскрипции и большом количестве
      // тем/задач (8–15 каждой) JSON-вывод легко улетает за 8k. Claude Sonnet 4.6
      // поддерживает до 64k output tokens; здесь оставляем разумный запас.
      max_tokens: 16000,
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
  const finishReason = choice?.finish_reason
  if (!content) throw new Error('LLM вернула пустой ответ')

  // Защита от обрезанного ответа (finish_reason='length' — модель уперлась в
  // max_tokens). Парсер на таком ответе всё равно упадёт с «Expected ',' or ']'»,
  // но без явной диагностики причина не видна. Сообщаем сразу и понятно.
  if (finishReason === 'length') {
    throw new Error(
      'LLM-ответ обрезан по max_tokens (finish_reason=length). ' +
      `Получено ~${content.length.toLocaleString('ru-RU')} символов JSON. ` +
      'Уменьшите размер транскрипции или поднимите max_tokens в extractTasksAndTopics.ts.',
    )
  }

  const parsed = parseLlmJson(content)

  return {
    tasks: (parsed.tasks ?? []).filter((t): t is TaskDraft => Boolean(t?.title)),
    topics: (parsed.topics ?? []).filter((t): t is TopicDraft => Boolean(t?.title)),
  }
}

/**
 * Парсит JSON-ответ LLM устойчиво к markdown-обёрткам и преамбуле.
 * Claude через прокси часто оборачивает ответ в ```json ... ```, даже когда
 * запрошен response_format: json_object.
 */
function parseLlmJson(raw: string): { tasks?: TaskDraft[]; topics?: TopicDraft[] } {
  const candidates: string[] = []
  const trimmed = raw.trim()

  // 1) как есть
  candidates.push(trimmed)

  // 2) снимаем ```json ... ``` или ``` ... ```
  const fence = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/)
  if (fence) candidates.push(fence[1].trim())

  // 3) первая большая фигурная скобка до последней
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1))
  }

  let lastErr: unknown = null
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch (e) {
      lastErr = e
    }
  }

  // Эвристическая диагностика: если ответ не заканчивается на `}` или `} ````
  // — почти наверняка он обрезан. Это даёт пользователю осмысленное сообщение
  // вместо «Expected ',' or ']' at position N».
  const tail = trimmed.slice(-200).replace(/\n/g, ' ')
  const head = trimmed.slice(0, 300).replace(/\n/g, ' ')
  const looksTruncated = !/[}`]\s*$/.test(trimmed)
  const hint = looksTruncated
    ? ` Похоже, ответ обрезан (длина ${trimmed.length.toLocaleString('ru-RU')} симв., конец: «…${tail}»).`
    : ''
  throw new Error(
    `Не удалось распарсить JSON LLM (${
      lastErr instanceof Error ? lastErr.message : 'parse error'
    }).${hint} Начало ответа: ${head}`,
  )
}
