// Проверка применимости llm_hint к reference-date отчёта.
//
// Используется builders отчёта (buildContext / buildControlContext) — если
// hint вне срока действия, в LLM-промпт он НЕ передаётся, чтобы устаревшая
// подсказка не «прилипала» к свежим данным.
//
//   week/month → reference = period_end
//   control    → reference = period_start (snapshot)

export type HintWindow = {
  llm_hint: string | null
  llm_hint_valid_from: string | null   // 'YYYY-MM-DD' | null
  llm_hint_valid_until: string | null  // 'YYYY-MM-DD' | null
}

export type HintApplicability = {
  effective: string | null     // текст hint если применим, иначе null
  reason: 'no_hint' | 'before_from' | 'after_until' | 'in_window'
}

// referenceISO — 'YYYY-MM-DD' (период отчёта)
export function isLlmHintApplicable(
  obj: HintWindow,
  referenceISO: string,
): HintApplicability {
  const hint = (obj.llm_hint ?? '').trim()
  if (hint.length === 0) {
    return { effective: null, reason: 'no_hint' }
  }
  if (obj.llm_hint_valid_from && referenceISO < obj.llm_hint_valid_from) {
    return { effective: null, reason: 'before_from' }
  }
  if (obj.llm_hint_valid_until && referenceISO > obj.llm_hint_valid_until) {
    return { effective: null, reason: 'after_until' }
  }
  return { effective: hint, reason: 'in_window' }
}
