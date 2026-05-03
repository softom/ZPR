/**
 * Расчёт абсолютных дат для пунктов договора.
 *
 * Используется в UI редактора пунктов (/contracts/[id], /contracts/new)
 * для отображения «расчётной даты» серым italic в полях, где режим = 'term'.
 *
 * Поддерживает:
 *   - Прямую дату (date_mode='date' или есть clause_date) — без вычислений.
 *   - Формулу term_days/term_type/term_base относительно базовой даты.
 *   - Цепочки term_base='prev' — итеративное разрешение по order_index.
 *
 * Пока НЕ поддерживает (требует модуль C с реальными событиями):
 *   - 'advance', 'start', 'end', 'submission', 'review', 'act'.
 *   - 'custom' — означает «иное» в тексте, расчёт невозможен без оператора.
 *
 * Календарь:
 *   - 'calendar' — просто +N дней.
 *   - 'working' — +N дней с пропуском суббот и воскресений.
 *     Праздничный календарь РФ НЕ учитывается (см. WIKI 17 «Не входит»).
 */

import type { TermBase } from '@/lib/parser/extractClauses'

export interface ClauseInput {
  id: string
  order_index: number
  clause_date: string | null
  term_days: number | null
  term_type: 'working' | 'calendar' | null
  term_base: TermBase | null
  term_ref_clause_id: string | null
  date_mode: 'date' | 'term' | null
  is_anchor?: boolean
}

export type ClauseDateStatus = 'absolute' | 'computed' | 'unresolvable' | 'empty'

export interface ClauseDateResult {
  date: string | null
  status: ClauseDateStatus
  reason?: string  // tooltip когда unresolvable / empty
}

export interface ClauseDateContext {
  // signedDate больше не нужен — все ссылки на «дату подписания договора»
  // идут через якорный пункт (is_anchor=true) с term_base='clause'.
  // Оставлено как опциональное поле для обратной совместимости callers.
  signedDate?: string | null
}

// ─── Базовая арифметика ────────────────────────────────────────────────────

function parseISODate(s: string): Date {
  // Полдень — чтобы не страдать от DST на границах.
  return new Date(s + 'T12:00:00')
}

function toISO(d: Date): string {
  return d.toISOString().split('T')[0]
}

function addCalendarDays(from: string, n: number): string {
  const d = parseISODate(from)
  d.setDate(d.getDate() + n)
  return toISO(d)
}

function addWorkingDays(from: string, n: number): string {
  const d = parseISODate(from)
  let added = 0
  // n=0 → возвращаем дату как есть. n>0 — идём вперёд, пропуская сб/вс.
  while (added < n) {
    d.setDate(d.getDate() + 1)
    const day = d.getDay() // 0=Sunday, 6=Saturday
    if (day !== 0 && day !== 6) added += 1
  }
  return toISO(d)
}

// ─── Метки для tooltip'ов ──────────────────────────────────────────────────

const BASE_LABEL: Record<TermBase, string> = {
  clause: 'дата конкретного пункта',
}

// ─── Расчёт одного пункта ───────────────────────────────────────────────────

function effectiveMode(c: ClauseInput): 'date' | 'term' | null {
  if (c.date_mode) return c.date_mode
  if (c.term_days != null && c.term_base) return 'term'
  if (c.clause_date) return 'date'
  return null
}

function computeOne(
  c: ClauseInput,
  ctx: ClauseDateContext,
  resolved: Map<string, ClauseDateResult>,
  byId: Map<string, ClauseInput>,
): ClauseDateResult {
  const mode = effectiveMode(c)

  // Якорь / явная дата
  if (mode === 'date') {
    if (c.clause_date) {
      return { date: c.clause_date, status: 'absolute' }
    }
    return { date: null, status: 'empty', reason: 'Дата не введена' }
  }

  // Формула
  if (mode === 'term') {
    if (c.term_days == null || !c.term_base || !c.term_type) {
      return { date: null, status: 'empty', reason: 'Формула срока не заполнена полностью' }
    }

    let base: string | null = null
    let baseReason = ''

    if (c.term_base === 'clause') {
      if (!c.term_ref_clause_id) {
        baseReason = 'Не выбран целевой пункт-источник (база)'
      } else if (c.term_ref_clause_id === c.id) {
        baseReason = 'Циклическая ссылка: пункт ссылается сам на себя'
      } else {
        const target = byId.get(c.term_ref_clause_id)
        if (!target) {
          baseReason = 'Целевой пункт удалён из договора'
        } else {
          const targetResult = resolved.get(target.id)
          if (targetResult?.date) {
            base = targetResult.date
          } else {
            baseReason = 'Дата целевого пункта ещё не вычислена'
          }
        }
      }
    }

    if (!base) {
      return { date: null, status: 'unresolvable', reason: baseReason }
    }

    const date = c.term_type === 'working'
      ? addWorkingDays(base, c.term_days)
      : addCalendarDays(base, c.term_days)

    return { date, status: 'computed' }
  }

  // mode === null
  return { date: null, status: 'empty', reason: 'Не введены ни дата, ни срок' }
}

// ─── Главная функция ───────────────────────────────────────────────────────

export function computeAllClauseDates(
  clauses: ClauseInput[],
  ctx: ClauseDateContext,
): Map<string, ClauseDateResult> {
  // Сортируем по order_index — нужно для term_base='prev'
  const sorted = [...clauses].sort((a, b) => a.order_index - b.order_index)

  // Map: id → clause (для term_base='clause' с term_ref_clause_id)
  const byId = new Map<string, ClauseInput>()
  for (const c of sorted) byId.set(c.id, c)

  const resolved = new Map<string, ClauseDateResult>()

  // Итеративно: пока есть изменения — резолвим.
  // Защита от циклов — лимит итераций.
  let changed = true
  let iterations = 0
  const maxIterations = sorted.length + 5

  while (changed && iterations < maxIterations) {
    changed = false
    iterations += 1
    for (const c of sorted) {
      const existing = resolved.get(c.id)
      if (existing && existing.date) continue // уже разрешен

      const result = computeOne(c, ctx, resolved, byId)

      // Записываем результат если:
      //  - его ещё не было, ИЛИ
      //  - был unresolvable/empty, а теперь стало лучше (есть date или другой статус)
      if (!existing || (existing.date == null && result.date != null) || existing.status !== result.status) {
        resolved.set(c.id, result)
        if (result.date != null) changed = true
      }
    }
  }

  // Гарантируем что у каждого пункта есть запись
  for (const c of sorted) {
    if (!resolved.has(c.id)) {
      resolved.set(c.id, { date: null, status: 'empty', reason: 'Не вычислено' })
    }
  }

  return resolved
}
