import type { ContractContext } from './buildContractContext'
import {
  TZ_CONTRACT, performedTaskItems, DISCLAIMER,
} from './tzContractConfig'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

export type PeriodMeta = {
  act?: string
  invoice?: string
  sum?: string
  periodNote?: string
}

// Полный markdown-документ «Отчёта по договору ТЗ»:
// детерминированные шапка/рамка/оговорка/подпись + LLM-достижения по Заданию.
export async function generateContractReport(
  ctx: ContractContext,
  meta?: PeriodMeta,
): Promise<string> {
  if (!POLZA_API_KEY) throw new Error('POLZA_API_KEY не задан в env')
  const achievementsMd = await generateAchievements(ctx)
  return assembleDocument(achievementsMd, meta)
}

async function generateAchievements(ctx: ContractContext): Promise<string> {
  const prompt = buildAchievementsPrompt(ctx)
  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${POLZA_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  })
  if (!response.ok) throw new Error(`LLM ${response.status}: ${await response.text()}`)
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = parseLlmJson(content)
  const md = typeof parsed.achievements_md === 'string' ? parsed.achievements_md.trim() : ''
  if (!md) throw new Error('LLM вернул пустые достижения. Проверь, что у отчёта-источника заполнены разделы по объектам.')
  return md
}

function buildAchievementsPrompt(ctx: ContractContext): string {
  const items = performedTaskItems()
    .map((t) => `п. ${t.n}. ${t.text}`)
    .join('\n')

  const fakture = ctx.objects.map((o) => {
    const parts: string[] = []
    if (o.project_movement?.trim()) parts.push(`Движение: ${o.project_movement.trim()}`)
    if (o.achievements?.trim())     parts.push(`Достигнуто: ${o.achievements.trim()}`)
    if (o.next_period_tasks?.trim()) parts.push(`Задачи: ${o.next_period_tasks.trim()}`)
    if (o.risks?.trim())            parts.push(`Риски: ${o.risks.trim()}`)
    return `### ${o.code} — ${o.name}\n${parts.join('\n') || '— нет данных —'}`
  }).join('\n\n')

  return `Ты — помощник Исполнителя (ИП), готовишь раздел «ДОСТИЖЕНИЯ ЗА ПЕРИОД ПО ПУНКТАМ ЗАДАНИЯ»
в отчёте о проделанной работе перед Заказчиком (ООО «ТЕХЗАКАЗЧИК-ЮГ») по договору технического заказчика.

РАМКА (обязательно):
Услуга Исполнителя по Заданию — ТЕХНИЧЕСКОЕ РУКОВОДСТВО персоналом Заказчика
(отдел ТЗ-ЮГ) и ОРГАНИЗАЦИЯ/ОБЕСПЕЧЕНИЕ проектно-изыскательских работ. Поэтому
ВСЮ работу отдела ТЗ-ЮГ и подрядчиков подавай КАК РЕЗУЛЬТАТ РУКОВОДСТВА
Исполнителя: глаголы «Исполнитель организовал / обеспечил / проконтролировал /
скоординировал / сформировал / осуществил руководство…». НЕ «отдел сделал».

ЗАДАЧА:
Для КАЖДОГО пункта Задания ниже — ОДИН абзац: что Исполнитель организовал/обеспечил
→ какой конкретный результат, опираясь на фактуру за месяц (ниже). Деловой тон,
без воды, только позитив и только по фактам из фактуры. Не приписывай работ,
которых в фактуре нет. Не упоминай внутренние коды (ПРОТ-…, [ID:…]).

ПУНКТЫ ЗАДАНИЯ (заявляются — по каждому нужен абзац):
${items}

ФАКТУРА ЗА МЕСЯЦ (из отчёта ЗПР, по 8 объектам):
${fakture}

Верни строго JSON (без markdown-обёртки):
{ "achievements_md": "<markdown>" }
В achievements_md — на каждый заявляемый пункт строка вида:
"**п. N.** <текст абзаца>"
Порядок пунктов — как в списке выше. Между пунктами — пустая строка.`
}

function assembleDocument(achievementsMd: string, meta?: PeriodMeta): string {
  const d = TZ_CONTRACT.defaults
  const act = meta?.act ?? d.act
  const invoice = meta?.invoice ?? d.invoice
  const sum = meta?.sum ?? d.sum
  const periodNote = meta?.periodNote ?? d.periodNote
  const c = TZ_CONTRACT

  const L: string[] = []
  L.push(`# Отчёт о проделанной работе по Договору № ${c.contract.number} от ${c.contract.date}`, '')
  L.push(`**Отчётный период:** ${periodNote}`, '')
  L.push(`**Исполнитель:** ${c.executor.name} (ОГРНИП ${c.executor.ogrnip}, ИНН ${c.executor.inn}).`, '')
  L.push(`**Заказчик:** ${c.customer.name} (ИНН ${c.customer.inn} / КПП ${c.customer.kpp}), директор ${c.customer.director}.`, '')
  L.push(`**Основание:** ${c.basis}.`, '')
  L.push(`**Документы периода:** ${act}; ${invoice}; сумма ${sum}.`, '')
  L.push('## Предмет услуг', '')
  L.push('Услуга Исполнителя по Заданию — техническое руководство персоналом Заказчика и организация/обеспечение проектно-изыскательских работ. Далее работа отдела ТЗ-ЮГ и подрядчиков изложена как результат руководства Исполнителя.', '')
  L.push('## Достижения за период (по пунктам Задания)', '')
  L.push(achievementsMd.trim(), '')
  L.push('## Услуги, не оказывавшиеся в отчётном периоде', '')
  L.push(DISCLAIMER, '')
  L.push('---', '')
  L.push(c.signature, '')
  return L.join('\n')
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
  throw new Error(`Не удалось разобрать ответ LLM: ${(lastErr as Error)?.message ?? 'unknown'}`)
}
