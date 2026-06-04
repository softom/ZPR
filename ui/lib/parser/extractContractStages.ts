/**
 * Парсер ЭТАПОВ договора (проход 1 двухпроходного пайплайна).
 *
 * Извлекает крупные блоки работ — этапы договора. Промежуточные пункты
 * (авансы, акты, расчёты) НЕ создаются здесь — они появятся на проходе 2
 * через `extractContractClauses` с привязкой к stage_number.
 *
 * Маркеры этапов: «Этап №1», «Раздел II», «Стадия 1», а также названия типа
 * АГК (Архитектурно-градостроительная концепция), ОПР (Объёмно-планировочные
 * решения), МОП (Места общего пользования), ТЭП (Технико-экономические
 * показатели), «Проектная документация», «Рабочая документация».
 *
 * Результат → таблица `contract_stages`.
 */

import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// Синхронизировано с extractClauses.ts (2026-05-19). См. комментарий там:
// поднято с 90K до 180K, чтобы Приложения с календарными планами попадали в LLM.
const TEXT_LIMIT = 180_000

export interface ContractStageInfo {
  stage_number: number       // 1, 2, 3 (последовательно)
  stage_name:   string       // «Архитектурно-градостроительная концепция», «ОПР» и т.п.
  description:  string | null // 1-2 предложения о содержании этапа
  sort_order:   number       // порядок в договоре (1-based, обычно = stage_number)
  source_page:  number | null
  source_quote: string       // оригинальная цитата из текста договора
}

export async function extractContractStages(
  text: string,
  contextHint?: string,
): Promise<ContractStageInfo[]> {
  const prompt = buildStagesPrompt(text, contextHint)
  const raw = await callLlmJson(prompt)
  const parsed = raw as { stages?: ContractStageInfo[] }
  return parsed.stages ?? []
}

function buildStagesPrompt(text: string, contextHint?: string): string {
  const truncated = text.length > TEXT_LIMIT
    ? text.slice(0, TEXT_LIMIT) + '\n[...текст обрезан...]'
    : text

  const hint = contextHint ? `\nПОДСКАЗКА КОНТЕКСТА: ${contextHint}\n` : ''

  return `Ты помощник по обработке строительных договоров на проектные работы.
Извлеки ЭТАПЫ договора как крупные блоки работ.${hint}

${PROJECT_GLOSSARY}

═══ ЧТО СЧИТАТЬ ЭТАПОМ ═══

Этап — это самостоятельный блок работ со своим результатом и сдачей.
Признаки этапа в тексте:
  • Явная нумерация «Этап 1», «Этап №1», «Раздел II», «Стадия А», «Часть 1».
  • Заголовок в Календарном плане / Приложении / Графике работ.
  • Привязан к собственному результату работ и собственному сроку.

ТИПОВЫЕ НАЗВАНИЯ ЭТАПОВ В ПРОЕКТИРОВАНИИ:
  - «Архитектурно-градостроительная концепция» / «АГК»
  - «Объёмно-планировочные решения» / «ОПР»
  - «Места общего пользования» / «МОП»
  - «Технико-экономические показатели» / «ТЭП»
  - «Эскизный проект» / «Фор-эскиз»
  - «Проектная документация» / «Стадия П»
  - «Рабочая документация» / «РД»
  - «Авторский надзор»
  - «Экспертиза» / «Прохождение экспертизы»
  - «Массинг» / «ОПР» (на старте бывают как самостоятельные этапы)

═══ ЧТО НЕ СЧИТАТЬ ЭТАПОМ ═══

🛑 НЕ создавай этап для:
  • Авансов и окончательных расчётов («Аванс 30% по Этапу 1») — это финансовые пункты.
  • Сдачи документации / подписания актов / получения замечаний — это согласовательные пункты.
  • Подписание самого договора, ДС, расторжение — это юридические пункты.
  • Пунктов типа «Заказчик обязуется…», «Исполнитель предоставляет…» — это условия, не этапы.

Все эти промежуточные пункты будут извлечены ОТДЕЛЬНО на проходе 2 (как clauses).

═══ ПОЛЯ КАЖДОГО ЭТАПА ═══

  - "stage_number": последовательный номер 1, 2, 3 (даже если в тексте «Этап №2.1»).
  - "stage_name": название (без слова «Этап» и номера — только суть). Примеры:
      «Архитектурно-градостроительная концепция (АГК)»,
      «Объёмно-планировочные решения (ОПР)»,
      «Рабочая документация».
  - "description": 1-2 предложения о составе работ этапа. null если не уверен.
  - "sort_order": тот же что stage_number (1, 2, 3…). Используется для UI-сортировки.
  - "source_page": номер страницы по маркеру [PAGE N]. null если не уверен.
  - "source_quote": дословная цитата из договора, на основании которой этап выделен.

═══ ФОРМАТ ОТВЕТА (ТОЛЬКО JSON) ═══

{
  "stages": [
    {
      "stage_number": 1,
      "stage_name": "Архитектурно-градостроительная концепция (АГК)",
      "description": "Разработка вариантов массинга, выбор основного варианта, согласование с заказчиком.",
      "sort_order": 1,
      "source_page": 3,
      "source_quote": "Этап 1. Разработка АГК (массинг) — срок 90 рабочих дней с даты подписания договора"
    }
  ]
}

Если этапов вовсе нет (договор простой, один блок работ) — верни { "stages": [] }.
Если этап один — верни массив из одного объекта.

ТЕКСТ ДОКУМЕНТА (с маркерами [PAGE N]):
${truncated}
`
}

// ─── LLM helper (дублирует логику из extractClauses.ts для модульности) ─────

async function callLlmJson(prompt: string): Promise<unknown> {
  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM stages error ${response.status}: ${err}`)
  }

  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'

  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\{[\s\S]*\})/)
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content

  try {
    return JSON.parse(jsonStr)
  } catch {
    throw new Error(`Не удалось разобрать JSON-ответ LLM (stages). Содержимое: ${content.slice(0, 200)}...`)
  }
}
