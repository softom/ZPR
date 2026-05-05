/**
 * Тонкая обёртка над Polza.AI Chat Completions API для одиночных JSON-вызовов.
 * Используется эндпоинтами /api/topics/[id]/* и /api/tasks/[id]/*.
 *
 * Главный endpoint извлечения (lib/protocol/extractTasksAndTopics.ts) делает свой
 * вызов напрямую — большой промпт, специфичный shape ответа. Здесь же — короткие
 * операции: regenerate-title, rephrase-as-task / rephrase-as-topic.
 */

import { parseLlmJson } from './parseJson'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

export interface CallPolzaJsonOpts {
  temperature?: number
  max_tokens?: number
  model?: string
}

export async function callPolzaJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  opts: CallPolzaJsonOpts = {},
): Promise<T> {
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
      model: opts.model ?? LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 1500,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`LLM HTTP ${response.status}: ${errText.slice(0, 500)}`)
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM вернула пустой ответ')

  return parseLlmJson<T>(content)
}
