/**
 * Строит массив строк для INSERT в contract_clauses из результата LLM-разбора.
 *
 * Всегда добавляет первым «якорный» пункт «Дата заключения договора» (если signed_date
 * непустой). Якорь нужен:
 *   - визуально оператору как ориентир для term_base='contract' пунктов;
 *   - модулю C для формирования базового СОБЫТИЯ «Договор подписан»,
 *     от которого считаются все остальные term_base='contract' события.
 *
 * Порядок:
 *   #1 — якорь (is_anchor=true)
 *   #2..N — пункты от LLM (с order_index += 1, если был задан LLM-ом)
 *
 * Дедупликация: если LLM случайно вернул пункт «Дата заключения договора»
 * (с такой же датой, без term_*) — он отбрасывается, чтобы не было двух якорей.
 */

import { randomUUID } from 'crypto'
import type { ClauseInfo } from '@/lib/parser/extractClauses'

const ANCHOR_DESCRIPTION = 'Дата заключения договора'

export interface ClauseRow {
  /**
   * Опционально — pre-generated UUID. Используется для якорного пункта,
   * чтобы дочерние пункты в этом же INSERT-batch могли ссылаться на него
   * через term_ref_clause_id. Если null — БД генерирует через gen_random_uuid().
   */
  id?:          string
  document_id:  string
  order_index:  number
  clause_date:  string | null
  description:  string
  note:         string | null
  source_page:  number | null
  source_quote: string | null
  term_days:    number | null
  term_type:    string | null
  term_base:    string | null
  term_text:    string | null
  term_ref_clause_id: string | null
  is_anchor:    boolean
  date_mode:    'date' | 'term' | null
  category:     'fin' | 'work' | 'appr' | 'legal' | null
}

/**
 * Определяет режим пункта по содержимому. Используется при INSERT (save / replace / POST clauses).
 * - term_* заполнено  → 'term' (формула приоритетнее)
 * - только дата       → 'date'
 * - ничего            → null
 */
export function inferDateMode(c: ClauseInfo): 'date' | 'term' | null {
  if (c.term_days != null && c.term_base) return 'term'
  if (c.clause_date) return 'date'
  return null
}

/**
 * LLM-пункт является дубликатом якоря «Дата заключения договора»?
 * Срабатывает когда:
 *   - clause_date совпадает с signed_date (или signed_date null);
 *   - в description есть «договор» + (подписание | заключение).
 * Примеры: «Подписание Договора № 200326-203-1-ДУ», «Заключение договора», «Дата заключения договора».
 */
function looksLikeAnchor(c: ClauseInfo, signedDate: string): boolean {
  if (c.term_days != null || c.term_base) return false
  if (c.clause_date && c.clause_date !== signedDate) return false
  const desc = (c.description ?? '').toLowerCase()
  return desc.includes('договор') && (desc.includes('заключ') || desc.includes('подпис'))
}

/**
 * term_text пункта ссылается на дату подписания/заключения договора?
 * Если да — пункт авто-привязывается к якорному пункту (term_ref_clause_id=anchor.id).
 * Маркеры: «с даты подписания Договора», «с момента заключения договора», «со дня заключения».
 */
function refersToContractSigning(termText: string | null | undefined): boolean {
  if (!termText) return false
  const t = termText.toLowerCase()
  const hasSigning = t.includes('подписан') || t.includes('заключ') || t.includes('заключение')
  const hasContract = t.includes('договор') || t.includes('настоящ') || t.includes('контракт')
  return hasSigning && hasContract
}

export function buildClauseRows(
  documentId: string,
  signedDate: string | null | undefined,
  clauses: ClauseInfo[],
): ClauseRow[] {
  const rows: ClauseRow[] = []

  // Pre-generate UUID для якоря — нужен чтобы дочерние пункты могли
  // в этом же INSERT-batch указать term_ref_clause_id=anchorId.
  const anchorId = signedDate ? randomUUID() : null

  if (signedDate && anchorId) {
    rows.push({
      id:           anchorId,
      document_id:  documentId,
      order_index:  1,
      clause_date:  signedDate,
      description:  ANCHOR_DESCRIPTION,
      note:         null,
      source_page:  1,
      source_quote: null,
      term_days:    null,
      term_type:    null,
      term_base:    null,
      term_text:    null,
      term_ref_clause_id: null,
      is_anchor:    true,
      date_mode:    'date', // якорь всегда фиксирован как 'date'
      category:     'legal', // дата заключения договора — юридический пункт
    })
  }

  const offset = rows.length // 1 если есть якорь, 0 если нет
  for (let idx = 0; idx < clauses.length; idx++) {
    const c = clauses[idx]
    // Не дублируем якорь, если LLM сам вернул похожий пункт «Подписание Договора»
    if (signedDate && looksLikeAnchor(c, signedDate)) continue

    // Авто-привязка к якорю: если term_text упоминает подписание/заключение договора
    // и LLM не задал term_ref_clause_id явно — ссылаемся на якорь.
    let termRef = c.term_ref_clause_id ?? null
    let termBase = c.term_base ?? null
    if (anchorId && !termRef && refersToContractSigning(c.term_text)) {
      termRef = anchorId
      termBase = 'clause'
    }

    rows.push({
      document_id:  documentId,
      order_index:  (c.order_index ?? idx + 1) + offset,
      clause_date:  c.clause_date || null,
      description:  c.description,
      note:         c.note || null,
      source_page:  c.source_page || null,
      source_quote: c.source_quote || null,
      term_days:    c.term_days ?? null,
      term_type:    c.term_type ?? null,
      term_base:    termBase,
      term_text:    c.term_text ?? null,
      term_ref_clause_id: termRef,
      is_anchor:    false,
      date_mode:    c.date_mode ?? inferDateMode({ ...c, term_base: termBase }),
      category:     c.category ?? null,
    })
  }

  return rows
}
