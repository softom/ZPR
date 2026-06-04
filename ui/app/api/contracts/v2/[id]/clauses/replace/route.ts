/**
 * POST /api/contracts/v2/[id]/clauses/replace
 *
 * Атомарная замена пунктов договора (и опционально — этапов).
 *
 * Body:
 * ```
 * {
 *   stages?: ContractStageInfo[],
 *   clauses: ClauseInfo[],
 *   preserve_stages?: boolean    // если true — этапы не трогаем (используем существующие из БД)
 * }
 * ```
 *
 * Режимы:
 *   - default (preserve_stages=false): полная замена этапов и пунктов.
 *     Шаги: NULL current_stage_id → DELETE clauses → DELETE stages → INSERT stages
 *           → INSERT clauses → UPDATE current_stage_id.
 *   - preserve_stages=true: только пункты. Этапы и current_stage_id не трогаются.
 *     Шаги: DELETE clauses → INSERT clauses (stage_id берётся из существующих stages по stage_number).
 *     Используется для кнопки «🎯 Выделить события договора».
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildClauseRows } from '@/lib/contracts/buildClauseRows'
import type { ClauseInfo } from '@/lib/parser/extractClauses'
import type { ContractStageInfo } from '@/lib/parser/extractContractStages'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as {
      stages?: ContractStageInfo[]
      clauses: ClauseInfo[]
      preserve_stages?: boolean
    }

    const stagesInput = body.stages ?? []
    const clausesInput = body.clauses ?? []
    const preserveStages = body.preserve_stages === true

    if (!Array.isArray(clausesInput)) {
      return NextResponse.json({ error: 'clauses array required' }, { status: 400 })
    }

    // Получаем signed_date документа — нужен для якорного пункта
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('signed_date, current_stage_id')
      .eq('id', id)
      .maybeSingle()

    const stageIdMap = new Map<number, string>()  // stage_number → stage.id
    let defaultStageId: string | null = null

    if (preserveStages) {
      // ─── Режим «оставить этапы» ───────────────────────────
      // 1. Берём существующие этапы из БД для построения map.
      const { data: existing, error: lErr } = await supabaseAdmin
        .from('contract_stages')
        .select('id, stage_number')
        .eq('document_id', id)
      if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
      for (const s of existing ?? []) {
        stageIdMap.set(s.stage_number, s.id)
      }

      // 2. Удаляем clauses (полная замена пунктов).
      const { error: dcErr } = await supabaseAdmin
        .from('contract_clauses')
        .delete()
        .eq('document_id', id)
      if (dcErr) return NextResponse.json({ error: dcErr.message }, { status: 500 })
    } else {
      // ─── Режим «полная замена» (старый default) ───────────
      // 1. Сбрасываем current_stage_id (FK мешает DELETE стадий)
      if (doc?.current_stage_id) {
        await supabaseAdmin
          .from('documents')
          .update({ current_stage_id: null })
          .eq('id', id)
      }

      // 2. Удаляем clauses
      const { error: dcErr } = await supabaseAdmin
        .from('contract_clauses')
        .delete()
        .eq('document_id', id)
      if (dcErr) return NextResponse.json({ error: dcErr.message }, { status: 500 })

      // 3. Удаляем contract_stages (calendar_entries.contract_stage_id → SET NULL автоматически)
      const { error: dsErr } = await supabaseAdmin
        .from('contract_stages')
        .delete()
        .eq('document_id', id)
      if (dsErr) return NextResponse.json({ error: dsErr.message }, { status: 500 })

      // 4. INSERT новых stages с pre-generated UUID
      if (stagesInput.length > 0) {
        const stageRows = stagesInput.map((s, idx) => {
          const sid = randomUUID()
          stageIdMap.set(s.stage_number, sid)
          if (idx === 0) defaultStageId = sid
          return {
            id:           sid,
            document_id:  id,
            stage_number: s.stage_number,
            stage_name:   s.stage_name,
            description:  s.description,
            sort_order:   s.sort_order ?? idx + 1,
            source_page:  s.source_page,
            source_quote: s.source_quote,
            is_default:   idx === 0,
          }
        })
        const { error: isErr } = await supabaseAdmin.from('contract_stages').insert(stageRows)
        if (isErr) return NextResponse.json({ error: `stages insert: ${isErr.message}` }, { status: 500 })
      }
    }

    // 5. INSERT clauses: buildClauseRows + резолв stage_number → stage_id
    const rows = buildClauseRows(id, doc?.signed_date ?? null, clausesInput).map(r => {
      // Найдём исходный clause по совпадению core-полей — нет, проще сделать
      // resolve через stage_number, который мы кладём в clause ⇒ rebuild rows
      // умеет это через clauses[].stage_number, см. сниппет ниже
      return r
    })

    // buildClauseRows не знает про stage_number — наложим map вручную.
    // Якорный row (is_anchor=true) идёт первым; LLM clauses — далее по индексу.
    // Сопоставление: только не-якорные строки в порядке клиентского ввода.
    // Параллельно резолвим event_type_code → event_type_id через справочник.
    // Также собираем коды из term_ref_event_type_code — для резолва ссылок (с 2026-05-18).
    const allCodes = Array.from(new Set([
      ...clausesInput.map(c => c.event_type_code).filter((x): x is string => !!x),
      ...clausesInput.map(c => c.term_ref_event_type_code).filter((x): x is string => !!x),
    ]))
    const typeIdByCode = new Map<string, string>()
    if (allCodes.length > 0) {
      const { data: types } = await supabaseAdmin
        .from('contract_event_types')
        .select('id, code')
        .in('code', allCodes)
      for (const t of (types ?? []) as { id: string; code: string }[]) {
        typeIdByCode.set(t.code, t.id)
      }
    }
    // Якорный пункт всегда — legal_contract_sign
    let anchorTypeId: string | null = null
    {
      const { data: anchorType } = await supabaseAdmin
        .from('contract_event_types')
        .select('id')
        .eq('code', 'legal_contract_sign')
        .maybeSingle()
      anchorTypeId = (anchorType as { id: string } | null)?.id ?? null
    }

    let llmIdx = 0
    for (const r of rows) {
      if (r.is_anchor) {
        r.event_type_id = anchorTypeId
        continue
      }
      const sourceClause = clausesInput[llmIdx]
      llmIdx += 1
      if (!sourceClause) continue
      const sn = sourceClause.stage_number ?? null
      if (sn != null) {
        const sid = stageIdMap.get(sn) ?? null
        if (sid) r.stage_id = sid
      }
      const tc = sourceClause.event_type_code ?? null
      if (tc) {
        const tid = typeIdByCode.get(tc) ?? null
        if (tid) r.event_type_id = tid
      }
    }

    // ─── Второй проход: резолв term_ref_clause_id (с 2026-05-18) ───
    // LLM может указать структурную ссылку через term_ref_event_type_code +
    // term_ref_stage_number. Найдём в этом же документе пункт с тем же типом+этапом —
    // если ровно 1 кандидат, проставим term_ref_clause_id.
    // refersToContractSigning в buildClauseRows уже сработала для якоря — её результат
    // (если term_ref_clause_id уже выставлен) тут не трогаем.
    let resolvedRefs = 0
    {
      let llmIdx2 = 0
      for (const r of rows) {
        if (r.is_anchor) continue
        const sourceClause = clausesInput[llmIdx2]
        llmIdx2 += 1
        if (!sourceClause) continue
        if (r.term_ref_clause_id) continue  // уже привязан (например, к якорю эвристикой)

        const refCode = sourceClause.term_ref_event_type_code ?? null
        if (!refCode) continue
        const refTypeId = typeIdByCode.get(refCode) ?? null
        if (!refTypeId) continue

        const refStageNum = sourceClause.term_ref_stage_number ?? null
        const refStageId = refStageNum != null ? (stageIdMap.get(refStageNum) ?? null) : null

        // Кандидаты: тот же документ (= rows), тот же event_type_id, тот же stage_id
        // (если refStageId задан). Якорь — единственный пункт где stage_id=null И
        // event_type_id=legal_contract_sign, поэтому ссылки на подписание договора
        // тоже резолвятся через этот же механизм.
        const candidates = rows.filter(o =>
          o.id !== r.id &&
          o.event_type_id === refTypeId &&
          (refStageId === null || o.stage_id === refStageId)
        )
        if (candidates.length === 1) {
          r.term_ref_clause_id = candidates[0].id
          r.term_base = 'clause'
          resolvedRefs += 1
        }
        // 0 или несколько — оставляем null, оператор довязывает в UI.
      }
    }

    if (rows.length > 0) {
      const { error: iErr } = await supabaseAdmin.from('contract_clauses').insert(rows)
      if (iErr) return NextResponse.json({ error: `clauses insert: ${iErr.message}` }, { status: 500 })
    }

    // 6. UPDATE documents.current_stage_id = первый этап (только в режиме полной замены)
    if (!preserveStages && defaultStageId) {
      await supabaseAdmin
        .from('documents')
        .update({ current_stage_id: defaultStageId })
        .eq('id', id)
    }

    console.log(
      `[v2/clauses/replace] doc=${id} ${preserveStages ? '(preserve_stages)' : `stages=${stagesInput.length}`} ` +
      `clauses=${rows.length} anchor=${rows.some(r => r.is_anchor)} ` +
      `default_stage=${defaultStageId ? 'set' : preserveStages ? 'kept' : 'none'} ` +
      `auto_refs=${resolvedRefs}`,
    )

    return NextResponse.json({
      ok: true,
      stages: stagesInput.length,
      count: rows.length,
      default_stage_id: defaultStageId,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
