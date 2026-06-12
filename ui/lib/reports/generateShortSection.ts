import type { ShortContext, ApprovedVariant } from './buildShortContext'
import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// Поля «Короткой справки» переиспользуют столбцы object_reports:
//   narrative     — короткое вступление (1 абзац)
//   achievements  — графа «Утверждённые варианты»: только номера/индексы (напр. "2, 4")
//   decisions     — Markdown-список утверждённых вариантов (детализация)
// (тип отчёта 'short' взаимоисключающий с week/month/control — конфликта столбцов нет).
export const SHORT_FIELDS = ['narrative', 'achievements', 'decisions'] as const
export type ShortField = typeof SHORT_FIELDS[number]
export type GeneratedShortSections = Partial<Record<ShortField, string>>

const FIELD_PROMPTS: Record<ShortField, string> = {
  narrative:
`"narrative" — КОРОТКОЕ ВСТУПЛЕНИЕ (1 абзац, 2-4 предложения): что в целом
заказчик утвердил по объекту в дальнейшую работу (общая формулировка перед
списком). Сухо, без оценок, без кодов протоколов. Если утверждённых вариантов
нет — «По объекту утверждённых заказчиком вариантов не зафиксировано.»`,

  achievements:
`"achievements" — графа «УТВЕРЖДЁННЫЕ ВАРИАНТЫ»: ТОЛЬКО НОМЕРА/индексы вариантов,
которые заказчик утвердил «в работу» (из источников ниже). Одно число или через
запятую: например "4" или "2, 4". Номер бери из формулировки источника
(«вариант №4», «4-й вариант», «вариант 2», «массинг 4»). ПРАВИЛА:
- Только цифры и запятые. Без слов, без «№», без пояснений.
- Если в источнике номер варианта не указан — НЕ выдумывай; верни "—".
- Бери только реально утверждённые «в работу» варианты.`,

  decisions:
`"decisions" — СПИСОК УТВЕРЖДЁННЫХ ВАРИАНТОВ (Markdown, каждый пункт с "- ").
Каждый пункт — одно утверждённое решение «в работу», по схеме:
- <что утверждено / какой вариант> — кем утверждено (если указано в источнике),
  дата (DD.MM.YYYY), протокол/собрание (если есть).
ПРАВИЛА:
- Бери ТОЛЬКО реальные утверждения/согласования вариантов «в дальнейшую работу»
  из источников ниже. НЕ выдумывай и не добавляй того, чего нет в данных.
- Объединяй дубли одного решения в один пункт. Сортируй свежие сверху.
- Сухо, без оценочных слов. Не пиши внутренние коды (ПРОТ-…, [ID:…]).
Если утверждённых вариантов нет — верни строку
"- Утверждённых заказчиком вариантов по объекту не зафиксировано."`,
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'дата не указана'
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

function formatVariants(list: ApprovedVariant[]): string {
  if (list.length === 0) return '— нет —'
  return list.map((v, i) => {
    const who = v.approved_by_org ? ` · поднял/утвердил: ${v.approved_by_org}` : ''
    const src = v.source === 'topic' ? 'тема собрания' : 'событие'
    const body = (v.content ?? '').trim()
    return `${i + 1}. [${fmtDate(v.date)} · ${src}${who}] ${v.title}${body ? ` — ${body}` : ''}`
  }).join('\n')
}

export async function generateShortSections(
  ctx: ShortContext,
  fields?: ShortField[],
): Promise<GeneratedShortSections> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')
  const requested = fields && fields.length > 0 ? fields : (SHORT_FIELDS as readonly ShortField[]).slice()

  const prompt = buildPrompt(ctx, requested as ShortField[])

  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${POLZA_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
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
  const out: GeneratedShortSections = {}
  for (const f of requested as ShortField[]) {
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

function buildPrompt(ctx: ShortContext, fields: ShortField[]): string {
  const snap = ctx.snapshotDate.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  const objectLabel = `${ctx.object.code} — ${ctx.object.current_name}`
  const jsonTemplate = `{\n${fields.map((f) => `  "${f}": "..."`).join(',\n')}\n}`
  const fieldDescriptions = fields.map((f) => FIELD_PROMPTS[f]).join('\n\n')

  return `Ты — помощник руководителя строительного проекта «Золотые пески России».
Формируешь раздел КОРОТКОЙ СПРАВКИ по объекту «${objectLabel}» на дату ${snap}.
Назначение справки: перечислить, какие ВАРИАНТЫ заказчик УТВЕРДИЛ в дальнейшую
работу (накопительно — все, что утверждено до даты справки).

${PROJECT_GLOSSARY}

═══ ИСТОЧНИКИ: КАНДИДАТЫ УТВЕРЖДЁННЫХ ВАРИАНТОВ (${ctx.approved_variants.length}) ═══
[Утверждённые темы собраний + важные события с признаком утверждения/согласования.
 Дата ≤ ${snap}. Отбери из них именно УТВЕРЖДЕНИЯ ВАРИАНТОВ «в работу».]

${formatVariants(ctx.approved_variants)}

═══ ЗАДАЧА ═══

Верни строго JSON (без markdown-обёртки):

${jsonTemplate}

ОПИСАНИЯ ПОЛЕЙ:

${fieldDescriptions}

КРИТИЧНЫЕ ПРАВИЛА:
- Опирайся ТОЛЬКО на источники выше. Ничего не выдумывай.
- Не пиши внутренние коды (ПРОТ-…, СОБЫТ-…, [ID:…]).
- Сухо, по фактам, без оценочных слов.`
}
