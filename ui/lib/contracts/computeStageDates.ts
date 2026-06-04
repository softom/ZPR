/**
 * Расчёт диапазона дат этапа договора (start / end) из связанных clauses.
 *
 * Не хранится в БД — выводится на лету. Источник истины — даты пунктов
 * (`contract_clauses.clause_date` + резолв формул через `computeAllClauseDates`)
 * и привязка к этапу (`contract_clauses.stage_id`).
 *
 * Логика:
 *   1. **Явная разметка** — если у этапа есть пункт с `event_type_code = 'work_start'`,
 *      его дата = `stage.date_start`. Аналогично `'work_result_delivery'` →
 *      `stage.date_end`. Если таких пунктов несколько — берём min/max соответственно.
 *   2. **Fallback** — если явных маркеров нет, берём `min(date)` и `max(date)`
 *      среди ВСЕХ пунктов этапа.
 *
 * Возврат — диапазон + источник (`'explicit' | 'auto'`) для подсветки в UI.
 */

import { computeAllClauseDates, type ClauseInput } from './computeClauseDates'

/** Пункт с минимумом полей, нужных для вычисления диапазона. */
export interface ClauseForStageDates extends ClauseInput {
  stage_id: string | null
  event_type_id: string | null
}

/** Запись справочника типов: id → code. */
export interface EventTypeForStageDates {
  id: string
  code: string
}

export type DateRangeSource = 'explicit' | 'auto'

export interface StageDateRange {
  start: string | null            // YYYY-MM-DD
  end:   string | null            // YYYY-MM-DD
  startSource: DateRangeSource    // 'explicit' если из event_type='work_start'
  endSource:   DateRangeSource    // 'explicit' если из event_type='work_result_delivery'
  clausesCount: number            // сколько пунктов в этапе с резолвенной датой
}

/**
 * Коды типов, маркирующие начало/конец этапа.
 * Если нужно расширить (например, добавить ctrl_act_signing как fallback для end) —
 * поправь массивы ниже.
 */
const START_CODES = new Set(['work_start'])
const END_CODES   = new Set(['work_result_delivery'])

/**
 * Вычислить даты start/end для каждого этапа из списка clauses.
 *
 * @param clauses   все пункты договора (включая привязанные и не привязанные к этапам)
 * @param eventTypes справочник типов (id → code), нужен чтобы понять какие пункты «начало/конец»
 * @param signedDate дата подписания договора — для якоря, передаётся в computeAllClauseDates
 * @returns Map<stage_id, StageDateRange>. Этапы без клауз — отсутствуют.
 */
export function computeStageDateRanges(
  clauses: ClauseForStageDates[],
  eventTypes: EventTypeForStageDates[],
  signedDate: string | null = null,
): Map<string, StageDateRange> {
  // 1) Резолвим даты всех пунктов (включая формульные term_*-режимы)
  const dateByClauseId = computeAllClauseDates(clauses, { signedDate })

  // 2) Карта event_type_id → code для классификации
  const codeById = new Map<string, string>()
  for (const t of eventTypes) codeById.set(t.id, t.code)

  // 3) Группируем по stage_id (null — пропускаем, у этапов нет null-id)
  const byStage = new Map<string, ClauseForStageDates[]>()
  for (const c of clauses) {
    if (!c.stage_id) continue
    const arr = byStage.get(c.stage_id) ?? []
    arr.push(c)
    byStage.set(c.stage_id, arr)
  }

  const result = new Map<string, StageDateRange>()

  for (const [stageId, group] of byStage.entries()) {
    // Все resolved-даты пунктов этапа
    type Resolved = { clause: ClauseForStageDates; date: string; code: string | null }
    const resolved: Resolved[] = []
    for (const c of group) {
      const d = dateByClauseId.get(c.id)
      if (!d?.date) continue
      const code = c.event_type_id ? codeById.get(c.event_type_id) ?? null : null
      resolved.push({ clause: c, date: d.date, code })
    }
    if (resolved.length === 0) {
      result.set(stageId, {
        start: null, end: null,
        startSource: 'auto', endSource: 'auto',
        clausesCount: 0,
      })
      continue
    }

    // ─── Явный start: минимальная дата среди пунктов с work_start ───
    const startCandidates = resolved
      .filter(r => r.code && START_CODES.has(r.code))
      .map(r => r.date)
    const startExplicit = startCandidates.length > 0
      ? startCandidates.reduce((a, b) => a < b ? a : b)
      : null

    // ─── Явный end: максимальная дата среди пунктов с work_result_delivery ───
    const endCandidates = resolved
      .filter(r => r.code && END_CODES.has(r.code))
      .map(r => r.date)
    const endExplicit = endCandidates.length > 0
      ? endCandidates.reduce((a, b) => a > b ? a : b)
      : null

    // Fallback на min/max всех клауз
    const allDates = resolved.map(r => r.date)
    const minAll = allDates.reduce((a, b) => a < b ? a : b)
    const maxAll = allDates.reduce((a, b) => a > b ? a : b)

    result.set(stageId, {
      start: startExplicit ?? minAll,
      end:   endExplicit   ?? maxAll,
      startSource: startExplicit ? 'explicit' : 'auto',
      endSource:   endExplicit   ? 'explicit' : 'auto',
      clausesCount: resolved.length,
    })
  }

  return result
}
