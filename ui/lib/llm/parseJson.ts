/**
 * Парсит JSON-ответ LLM устойчиво к markdown-обёрткам и преамбуле.
 * Claude через прокси иногда оборачивает ответ в ```json ... ```, даже если
 * запрошен response_format: json_object.
 */
export function parseLlmJson<T = unknown>(raw: string): T {
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
    try {
      return JSON.parse(c) as T
    } catch (e) {
      lastErr = e
    }
  }
  const head = trimmed.slice(0, 300).replace(/\n/g, ' ')
  throw new Error(
    `Не удалось распарсить JSON LLM (${
      lastErr instanceof Error ? lastErr.message : 'parse error'
    }). Начало ответа: ${head}`,
  )
}
