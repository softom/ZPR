/**
 * Серверный модуль: LLM-распознавание спикеров транскрипции.
 *
 * На вход — текст транскрипции, контекст собрания (участники + юр.лица) и
 * список «сырых» меток спикеров из самой транскрипции («Спикер 1», «Speaker A»,
 * `c8c4a3...` — что нашёл parseTranscript.extractSpeakers).
 *
 * На выход — словарь { rawSpeakerLabel → LLMSpeakerSuggestion }, где
 * suggestion содержит:
 *   - fio_mention:  «Светлана Иванова» / «Иван Петрович» / «Иван» / null
 *   - org_mention:  «ООО Хэдс Групп» / «ХГ» / null
 *   - confidence:   'high' | 'medium' | 'low' | 'unknown'
 *   - evidence:     1-3 типизированных цитат из транскрипции
 *
 * LLM в этом модуле ТОЛЬКО извлекает упоминания. Сопоставление имён/орг
 * с реальными meeting_participants / legal_entities делает сервер
 * детерминированно — это снимает риск галлюцинации ФИО (см.
 * /api/protocols/[id]/analyze-speakers/route.ts).
 *
 * Эвристика двух проходов реализована ВНУТРИ системного промпта: модель
 * сама сначала ищет явные сигналы (self-intro, прямое обращение по имени),
 * потом — косвенные. Это компромисс: один LLM-call вместо двух последовательных,
 * но с явной инструкцией о приоритизации сигналов.
 */

import type { MeetingContext } from './extractTasksAndTopics'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

const TEXT_LIMIT = 90_000

export type EvidenceType =
  | 'self_intro'           // «Меня зовут Иван, я от ТЗ-ЮГ»
  | 'addressed_by_name'    // «Иван Петрович, подскажите…» (от другого спикера)
  | 'addressed_to_company' // «Слушаю, Хэдс Групп» — следующая реплика спикера этой орг
  | 'mentioned_company'    // «У нас в Хэдс Групп», «наш проект»
  | 'first_name_only'      // «Светлана, расскажите» (без отчества/фамилии)
  | 'role_mention'         // обсуждает архитектуру → архитектор; финансы → финансист
  | 'third_person'         // «как сказала Светлана», «Иван предложил вчера»
  | 'other'                // другие сигналы

export interface SpeakerEvidence {
  type: EvidenceType
  text: string   // дословная цитата
}

export interface LLMSpeakerSuggestion {
  /** «Иван Петрович», «Светлана», null если ФИО в тексте не упоминается */
  fio_mention: string | null
  /** «ООО Хэдс Групп», «ХГ», null если организация не определена */
  org_mention: string | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  evidence: SpeakerEvidence[]
}

export type LLMSpeakerMap = Record<string, LLMSpeakerSuggestion>

const SYSTEM_PROMPT = `Ты — ассистент руководителя проекта «Золотые Пески России».
Тебе дана транскрипция рабочего собрания с метками говорящих перед каждой
репликой. Метки могут быть в любом формате — «Спикер 1», «Speaker A»,
«Участник 3», «Говорящий 2» и т.д. Имена реальных людей в метках НЕ
записаны — их нужно определить по контексту самих реплик.

Твоя цель — для КАЖДОГО спикера из списка ниже найти упоминание его имени
и/или организации в самой транскрипции. Ты ТОЛЬКО извлекаешь дословные
упоминания. Сопоставлять найденное с реальными участниками — НЕ твоя задача,
это сделает сервер.

═══ ТИПЫ СИГНАЛОВ (от самых сильных к слабым) ═══

SELF_INTRO (high) — спикер сам представился:
  «Меня зовут Иван», «Я Светлана Васильевна», «Я представляю Хэдс Групп»,
  «От лица Технического заказчика-ЮГ хочу сказать…»

ADDRESSED_BY_NAME (high) — другой спикер обратился к нему по ФИО:
  «Иван Петрович, прокомментируйте» → СЛЕДУЮЩАЯ реплика — Иван Петрович.
  Самый надёжный сигнал. Цитируешь ту реплику, где обратились.

ADDRESSED_TO_COMPANY (medium/high) — другой спикер обратился к организации:
  «Слушаю, Хэдс Групп», «Передаём слово Технический заказчик-ЮГ»
  → СЛЕДУЮЩАЯ реплика — представитель этой орг.

MENTIONED_COMPANY (medium) — спикер сам упомянул свою организацию:
  «У нас в Хэдс Групп два варианта», «Наша команда АЯКС-сервис»,
  «Мы по своему направлению…» (с упоминанием направления).

FIRST_NAME_ONLY (medium) — обращение по имени без фамилии:
  «Светлана, расскажите», «Алексей, ты что думаешь»

ROLE_MENTION (low/medium) — спикер обсуждает свою профессиональную тему:
  Тема архитектуры (планировки, фасады, метры) → говорит архитектор.
  Тема финансов (бюджет, ставка, окупаемость) → финансист.
  Тема стройки (бетон, графики, монтаж) → ГИП / прораб.
  Сопоставь с job_title из списка участников.

THIRD_PERSON (low) — упоминание спикера в третьем лице:
  «Как сказала Светлана», «Иван предложил вчера» — это упоминание
  Светланы/Ивана, но они скорее всего ДРУГИЕ спикеры (не тот, кто говорит).

═══ ПРАВИЛА ═══

- НЕ выдумывай имена. Если в тексте нет упоминания — оставь null.
- НЕ маппи на список участников. Возвращай ровно то, что нашёл в тексте.
- evidence[].text — ДОСЛОВНАЯ цитата (можешь обрезать длинные, поставив …).
- Возвращай ВСЕ найденные сигналы (не только лучший) — до 3 штук на спикера.
- Confidence:
   high   — есть SELF_INTRO ИЛИ ADDRESSED_BY_NAME с явной следующей репликой
            ИЛИ MENTIONED_COMPANY × несколько раз
   medium — FIRST_NAME_ONLY, ADDRESSED_TO_COMPANY, одиночный MENTIONED_COMPANY
   low    — только ROLE_MENTION или одиночный косвенный сигнал
   unknown — ничего не нашёл

═══ ПРИОРИТЕТ ═══

Если в транскрипции мало явных обращений по имени (часто на технических
собраниях так), ОБЯЗАТЕЛЬНО используй ROLE_MENTION и MENTIONED_COMPANY.
Лучше дать low-confidence предположение, чем unknown — пользователь сам
подтвердит. unknown — это только когда реплики совершенно безликие
(«да», «согласен», «нет» — нечего цитировать).

ВЕРНИ ТОЛЬКО валидный JSON. Без пояснений, без markdown-блоков.`

interface RawSpeaker {
  raw: string         // «Спикер 1» / «Speaker A» / …
  count: number       // сколько реплик
  samples: string[]   // первые N реплик (для подсказки LLM)
}

export async function analyzeSpeakers(
  transcript: string,
  ctx: MeetingContext,
  speakers: RawSpeaker[],
): Promise<LLMSpeakerMap> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в окружении')
  if (speakers.length === 0) return {}

  const text = transcript.length > TEXT_LIMIT
    ? transcript.slice(0, TEXT_LIMIT) + '\n[обрезано до 90 000 символов]'
    : transcript

  // Список спикеров с количеством реплик + ВЫБОРКА реплик каждого.
  // Это разгружает LLM: ей не нужно бегать по 90k символов, чтобы найти
  // реплики каждого — мы их сразу даём как «образец стиля» спикера.
  const speakersList = speakers
    .map((s) => {
      const samples = s.samples.slice(0, 5)
        .map((q) => `    • «${q.length > 220 ? q.slice(0, 220) + '…' : q}»`)
        .join('\n')
      return `[${s.raw}] (${s.count} реплик):\n${samples || '    • (нет образцов)'}`
    })
    .join('\n\n')

  // Контекст: участники + юр.лица. Передаём как ПОДСКАЗКУ, что в собрании
  // фигурируют такие-то имена. Но требуем от LLM возвращать только дословные
  // упоминания — резолвер сопоставит сам.
  const participantsList = ctx.participants
    .map((p) => `- ${p.fio}${p.org ? ` (${p.org})` : ''}${p.role ? `, ${p.role}` : ''}`)
    .join('\n') || '(не указаны)'

  const orgsList = ctx.legal_entities
    .map((e) => {
      const aliasesStr = e.aliases.length ? ` / ${e.aliases.slice(0, 3).join(' / ')}` : ''
      return `- ${e.name}${aliasesStr}`
    })
    .join('\n') || '(не указаны)'

  const userPrompt = `Контекст собрания:
- Дата: ${ctx.meeting_date}
- Название: ${ctx.title}

Список участников собрания (могут упоминаться в транскрипции).
Должность (после запятой) — важная подсказка для сигнала role_mention:
${participantsList}

Юр.лица собрания:
${orgsList}

Метки спикеров с примерами реплик каждого (5 первых).
Эти выборки помогают тебе быстро понять стиль / тему / профессию говорящего:
${speakersList}

Полная транскрипция (для поиска явных обращений и self-intro):
"""
${text}
"""

Верни JSON ровно такой формы — по одному ключу на каждого спикера из списка выше:
{
  "speakers": {
    "Спикер 1": {
      "fio_mention": "Иван Петрович" | "Иван" | null,
      "org_mention": "ООО Хэдс Групп" | null,
      "confidence": "high" | "medium" | "low" | "unknown",
      "evidence": [
        {"type": "self_intro" | "addressed_by_name" | "addressed_to_company" | "mentioned_company" | "first_name_only" | "role_mention" | "third_person" | "other",
         "text": "дословная цитата из транскрипции"}
      ]
    },
    "Спикер 2": { ... },
    ...
  }
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
      max_tokens: 8000,
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
    throw new Error('LLM-ответ обрезан по max_tokens. Сократите транскрипцию или поднимите лимит.')
  }

  const parsed = parseJson(content)
  // Допускаем оба формата ответа: { speakers: {...} } или просто {...}
  const rawMap = (parsed.speakers ?? parsed) as Record<string, unknown>
  const result: LLMSpeakerMap = {}

  type RawItem = {
    fio_mention?: unknown
    org_mention?: unknown
    confidence?: unknown
    evidence?: unknown
  }

  for (const sp of speakers) {
    const raw = rawMap?.[sp.raw]
    if (!raw || typeof raw !== 'object') {
      result[sp.raw] = { fio_mention: null, org_mention: null, confidence: 'unknown', evidence: [] }
      continue
    }
    const item = raw as RawItem
    const conf: LLMSpeakerSuggestion['confidence'] =
      item.confidence === 'high' || item.confidence === 'medium' ||
      item.confidence === 'low' || item.confidence === 'unknown'
        ? item.confidence
        : 'unknown'

    const evidence: SpeakerEvidence[] = Array.isArray(item.evidence)
      ? item.evidence
          .filter((e: unknown): e is { type?: unknown; text?: unknown } => Boolean(e) && typeof e === 'object')
          .map((e) => ({
            type: normalizeEvidenceType(e.type),
            text: typeof e.text === 'string' ? e.text : '',
          }))
          .filter((e) => e.text.length > 0)
      : []

    result[sp.raw] = {
      fio_mention: typeof item.fio_mention === 'string' && item.fio_mention.trim()
        ? item.fio_mention.trim() : null,
      org_mention: typeof item.org_mention === 'string' && item.org_mention.trim()
        ? item.org_mention.trim() : null,
      confidence: conf,
      evidence,
    }
  }
  return result
}

function normalizeEvidenceType(t: unknown): EvidenceType {
  const allowed: EvidenceType[] = [
    'self_intro', 'addressed_by_name', 'addressed_to_company',
    'mentioned_company', 'first_name_only', 'role_mention',
    'third_person', 'other',
  ]
  return (allowed as readonly unknown[]).includes(t) ? t as EvidenceType : 'other'
}

function parseJson(raw: string): { speakers?: Record<string, unknown>; [k: string]: unknown } {
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
    `Не удалось распарсить JSON LLM (${
      lastErr instanceof Error ? lastErr.message : 'parse error'
    }). Начало: ${trimmed.slice(0, 200)}`,
  )
}
