/**
 * Проверка стратегической темы по тексту произвольного документа (Word/любой
 * текстовый материал). LLM сопоставляет и возвращает три блока:
 *   - in_topic   — что из документа уже учтено в теме (где именно)
 *   - missing    — что в документе есть, но в теме не отражено (с предложением
 *                  куда добавить)
 *   - off_topic  — что в документе НЕ относится к этой теме
 *
 * Используется в карточке темы по кнопке «Проверить по документу».
 */

import { callPolzaJson } from '@/lib/llm/polza'

export interface TopicForCheck {
  seq: number
  title: string
  category: string
  synopsis: string
  threats: string
  solutions: string | null
  deadlines: string | null
}

export interface CheckResult {
  in_topic: Array<{
    quote: string
    where: string   // куда отнесено (synopsis|threats|solutions|deadlines|...)
    comment: string
  }>
  missing: Array<{
    quote: string
    suggestion: string  // куда добавить в теме
  }>
  off_topic: Array<{
    quote: string
    reason: string
  }>
}

const CATEGORY_LABEL: Record<string, string> = {
  environment:  'Средовое проектирование',
  engineering:  'Инженерное',
  land_legal:   'Земельно-правовое',
  organization: 'Организационное',
  personnel:    'Кадровое',
  contracting:  'Договорное',
}

export async function checkTopicAgainstDocument(
  topic: TopicForCheck,
  documentText: string,
): Promise<CheckResult> {
  const systemPrompt = `Ты — помощник руководителя строительного проекта «Золотые пески России».
Тебе дана стратегическая управленческая тема и текст произвольного документа.
Задача — сопоставить и вернуть три списка:

1. in_topic — фрагменты документа, которые УЖЕ отражены в теме. Указывай, в каком поле темы (synopsis/threats/solutions/deadlines) и кратко комментарий.

2. missing — фрагменты документа, которые относятся к теме, но НЕ отражены ни в одном поле темы. Указывай предложение, в какое поле имеет смысл добавить.

3. off_topic — фрагменты документа, которые НЕ относятся к этой стратегической теме. Указывай короткую причину почему (например: «другая категория», «слишком частный факт», «о другом объекте»).

Правила:
- quote — точная или почти-точная цитата из документа (5–25 слов). Не обобщай и не пересказывай.
- Если пересечений нет ни одного — верни пустой массив. НЕ ВЫДУМЫВАЙ.
- Один фрагмент = одна позиция. Не дробь предложение на части и не объединяй несколько в одну запись.
- Если документ полностью off-topic относительно темы — все фрагменты идут в off_topic, in_topic и missing пустые.
- Деловой нейтральный тон. Без «я считаю», «возможно», «вероятно».`

  const categoryLabel = CATEGORY_LABEL[topic.category] ?? topic.category

  const userPrompt = `СТРАТЕГИЧЕСКАЯ ТЕМА:

Номер: ${String(topic.seq).padStart(3, '0')}
Категория: ${categoryLabel}
Название: ${topic.title}

Синопсис:
${topic.synopsis}

Угрозы:
${topic.threats}

Решения:
${topic.solutions || '(не заполнены)'}

Сроки:
${topic.deadlines || '(не заполнены)'}

═══════════════════════════════════════════════════
ТЕКСТ ДОКУМЕНТА ДЛЯ ПРОВЕРКИ:
═══════════════════════════════════════════════════
${documentText}
═══════════════════════════════════════════════════

ВЕРНИ СТРОГО JSON следующего вида:
{
  "in_topic": [
    { "quote": "...", "where": "synopsis|threats|solutions|deadlines", "comment": "коротко как именно отражено" }
  ],
  "missing": [
    { "quote": "...", "suggestion": "synopsis|threats|solutions|deadlines — что и куда добавить" }
  ],
  "off_topic": [
    { "quote": "...", "reason": "коротко почему вне темы" }
  ]
}

Никаких \`\`\`, никаких пояснений. Только JSON.`

  const result = await callPolzaJson<CheckResult>(
    systemPrompt,
    userPrompt,
    { temperature: 0.2, max_tokens: 4000 },
  )

  // Нормализация — массивы могут быть undefined, элементы могут быть кривые.
  return {
    in_topic:  Array.isArray(result.in_topic)  ? result.in_topic.filter(isValidInTopic)   : [],
    missing:   Array.isArray(result.missing)   ? result.missing.filter(isValidMissing)    : [],
    off_topic: Array.isArray(result.off_topic) ? result.off_topic.filter(isValidOffTopic) : [],
  }
}

function isValidInTopic(x: unknown): x is CheckResult['in_topic'][number] {
  return !!x && typeof x === 'object'
    && typeof (x as { quote?: unknown }).quote === 'string'
    && typeof (x as { where?: unknown }).where === 'string'
    && typeof (x as { comment?: unknown }).comment === 'string'
}

function isValidMissing(x: unknown): x is CheckResult['missing'][number] {
  return !!x && typeof x === 'object'
    && typeof (x as { quote?: unknown }).quote === 'string'
    && typeof (x as { suggestion?: unknown }).suggestion === 'string'
}

function isValidOffTopic(x: unknown): x is CheckResult['off_topic'][number] {
  return !!x && typeof x === 'object'
    && typeof (x as { quote?: unknown }).quote === 'string'
    && typeof (x as { reason?: unknown }).reason === 'string'
}
