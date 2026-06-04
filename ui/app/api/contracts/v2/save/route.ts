/**
 * POST /api/contracts/v2/save
 *
 * Принимает: ContractAnalysis (после верификации оператором) + object_codes + extractedText.
 * Создаёт атомарно:
 *   1. legal_entities — find_or_create по ИНН для customer и contractor
 *   2. documents — с FK на ЮЛ + parties_snapshot (для аудита) + folder_path
 *   3. document_objects — N:N связь с объектами
 *   4. contract_clauses — пункты договора
 *   5. document_chunks (fire-and-forget) — векторный индекс
 *
 * НЕ создаёт записи в events / event_date_editions / entity_links.
 * Связь с событиями — на Этапе 3 (модуль C).
 *
 * Файл договора заливается отдельным запросом /api/contracts/v2/[id]/upload.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findOrCreateLegalEntity } from '@/lib/legalEntities/findOrCreate'
import { indexDocumentChunks } from '@/lib/vector/indexDocument'
import { buildClauseRows } from '@/lib/contracts/buildClauseRows'
import type { ContractAnalysis } from '@/lib/parser/extractClauses'
import type { ContractStageInfo } from '@/lib/parser/extractContractStages'

interface SavePayload {
  analysis: ContractAnalysis
  object_codes: string[]   // выбранные оператором (могут отличаться от LLM-предложения)
  extractedText?: string   // полный текст для индексации
  contract_stages?: ContractStageInfo[]  // этапы договора (проход 1, если выделены)
}

const sanitize = (s: string) => s
  .replace(/[\\/:*?"<>|«»—]/g, '')
  .replace(/\s+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_|_$/g, '')

export async function POST(request: NextRequest) {
  try {
    const { analysis, object_codes, extractedText, contract_stages = [] } = await request.json() as SavePayload

    if (!analysis) {
      return NextResponse.json({ error: 'analysis required' }, { status: 400 })
    }
    if (!analysis.customer?.inn?.trim()) {
      return NextResponse.json({ error: 'customer.inn required' }, { status: 400 })
    }
    if (!analysis.contractor?.inn?.trim()) {
      return NextResponse.json({ error: 'contractor.inn required' }, { status: 400 })
    }

    // 0. Проверка дубля по номеру договора
    const docNumber = analysis.number?.trim() || null
    if (docNumber) {
      const { data: existing } = await supabaseAdmin
        .from('documents')
        .select('id, title')
        .eq('doc_number', docNumber)
        .is('deleted_at', null)
        .maybeSingle()
      if (existing) {
        return NextResponse.json(
          { error: 'duplicate', existing_id: existing.id, existing_title: existing.title },
          { status: 409 },
        )
      }
    }

    // 1. Find/create legal_entities для сторон
    const customer = await findOrCreateLegalEntity(supabaseAdmin, {
      inn: analysis.customer.inn,
      name: analysis.customer.name,
      kpp: analysis.customer.kpp,
      address_legal: analysis.customer.address,
      signatory_name: analysis.customer.signatory_name,
      signatory_position: analysis.customer.signatory_position,
    })

    const contractor = await findOrCreateLegalEntity(supabaseAdmin, {
      inn: analysis.contractor.inn,
      name: analysis.contractor.name,
      kpp: analysis.contractor.kpp,
      address_legal: analysis.contractor.address,
      signatory_name: analysis.contractor.signatory_name,
      signatory_position: analysis.contractor.signatory_position,
    })

    // 2. Documents
    const dateSlug  = (analysis.signed_date ?? 'без_даты').replaceAll('-', '_')
    const titleSlug = sanitize(analysis.title || 'договор')
    const versionSlug = sanitize(analysis.version || 'v1')
    const folderPath = `ДОГОВОРА\\${dateSlug}_${titleSlug}_${versionSlug}`

    // parties_snapshot — снимок реквизитов на момент подписания
    const partiesSnapshot = {
      customer:   { ...analysis.customer },
      contractor: { ...analysis.contractor },
    }

    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .insert({
        type:                 'ДОГОВОРА',
        title:                analysis.title,
        doc_number:           docNumber,
        version:              analysis.version || 'v1',
        folder_path:          folderPath,
        signed_date:          analysis.signed_date || null,
        customer_entity_id:   customer.id,
        contractor_entity_id: contractor.id,
        parties_snapshot:     partiesSnapshot,
        project_stage:        analysis.project_stage || null,
        // Сохраняем полный текст для повторного анализа («🔄 Переразобрать»)
        extracted_text:       extractedText?.trim() || null,
      })
      .select('id, folder_path')
      .single()

    if (docErr) {
      console.error('[v2/save] documents:', docErr.message)
      return NextResponse.json({ error: docErr.message }, { status: 500 })
    }

    // 3. document_objects (N:N)
    if (object_codes?.length) {
      const objectRows = object_codes.map(code => ({
        document_id: doc.id,
        object_code: code,
      }))
      const { error: doErr } = await supabaseAdmin
        .from('document_objects')
        .insert(objectRows)
      if (doErr) {
        console.error('[v2/save] document_objects:', doErr.message)
        return NextResponse.json({ error: doErr.message }, { status: 500 })
      }
    }

    // 4. contract_stages — этапы договора (проход 1 LLM, если есть)
    const stageIdMap = new Map<number, string>()  // stage_number → stage.id
    let defaultStageId: string | null = null
    if (contract_stages.length > 0) {
      const stageRows = contract_stages.map((s, idx) => {
        const sid = randomUUID()
        stageIdMap.set(s.stage_number, sid)
        if (idx === 0) defaultStageId = sid
        return {
          id:           sid,
          document_id:  doc.id,
          stage_number: s.stage_number,
          stage_name:   s.stage_name,
          description:  s.description,
          sort_order:   s.sort_order ?? idx + 1,
          source_page:  s.source_page,
          source_quote: s.source_quote,
          is_default:   idx === 0,
        }
      })
      const { error: csErr } = await supabaseAdmin.from('contract_stages').insert(stageRows)
      if (csErr) {
        console.error('[v2/save] contract_stages:', csErr.message)
        return NextResponse.json({ error: `stages insert: ${csErr.message}` }, { status: 500 })
      }
    }

    // 4.5. contract_clauses — якорь + пункты от LLM (с резолвом stage_id и event_type_id)
    // Замечание: с 2026-05-15 первичная загрузка /analyze не извлекает clauses
    // (метаданные only) — clauses появляются на странице договора через
    // «🎯 Выделить события договора» (см. /reparse skip_stages). Эта секция
    // оставлена для совместимости и для случаев, когда clauses передадут в /save.
    const clauses = analysis.clauses ?? []
    const clauseRows = buildClauseRows(doc.id, analysis.signed_date, clauses)

    // Резолв event_type_code → event_type_id (для якоря и LLM-clauses).
    // Также подтягиваем коды из term_ref_event_type_code — для авто-резолва ссылок.
    const allCodes = Array.from(new Set([
      ...clauses.map(c => c.event_type_code).filter((x): x is string => !!x),
      ...clauses.map(c => c.term_ref_event_type_code).filter((x): x is string => !!x),
    ]))
    const typeIdByCode = new Map<string, string>()
    if (allCodes.length > 0 || clauseRows.some(r => r.is_anchor)) {
      const codesToFetch = [...allCodes, 'legal_contract_sign']
      const { data: types } = await supabaseAdmin
        .from('contract_event_types')
        .select('id, code')
        .in('code', codesToFetch)
      for (const t of (types ?? []) as { id: string; code: string }[]) {
        typeIdByCode.set(t.code, t.id)
      }
    }

    let llmIdx = 0
    for (const r of clauseRows) {
      if (r.is_anchor) {
        r.event_type_id = typeIdByCode.get('legal_contract_sign') ?? null
        continue
      }
      const sourceClause = clauses[llmIdx]
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

    // ─── Второй проход: резолв term_ref_clause_id по структурной ссылке ───
    // См. /clauses/replace для аналогичной логики и комментариев.
    {
      let llmIdx2 = 0
      for (const r of clauseRows) {
        if (r.is_anchor) continue
        const sourceClause = clauses[llmIdx2]
        llmIdx2 += 1
        if (!sourceClause) continue
        if (r.term_ref_clause_id) continue

        const refCode = sourceClause.term_ref_event_type_code ?? null
        if (!refCode) continue
        const refTypeId = typeIdByCode.get(refCode) ?? null
        if (!refTypeId) continue

        const refStageNum = sourceClause.term_ref_stage_number ?? null
        const refStageId = refStageNum != null ? (stageIdMap.get(refStageNum) ?? null) : null

        const candidates = clauseRows.filter(o =>
          o.id !== r.id &&
          o.event_type_id === refTypeId &&
          (refStageId === null || o.stage_id === refStageId)
        )
        if (candidates.length === 1) {
          r.term_ref_clause_id = candidates[0].id
          r.term_base = 'clause'
        }
      }
    }

    if (clauseRows.length) {
      const { error: ccErr } = await supabaseAdmin
        .from('contract_clauses')
        .insert(clauseRows)
      if (ccErr) {
        console.error('[v2/save] contract_clauses:', ccErr.message)
        return NextResponse.json({ error: ccErr.message }, { status: 500 })
      }
    }

    // 4.6 Установить current_stage_id = первому этапу
    if (defaultStageId) {
      await supabaseAdmin
        .from('documents')
        .update({ current_stage_id: defaultStageId })
        .eq('id', doc.id)
    }

    // 4.1 Авто-пополнение objects.aliases («Публичные имена») именами из текста договора.
    //     LLM возвращает analysis.object_aliases = { code: [имя1, имя2, ...] }.
    //     Добавляем только новые (без current_name и существующих aliases, регистронезависимо).
    const aliasesAdded: Record<string, string[]> = {}
    const objectAliases = analysis.object_aliases ?? {}
    const codesToCheck = (object_codes ?? []).filter(c => objectAliases[c]?.length)
    for (const code of codesToCheck) {
      const incoming = (objectAliases[code] ?? [])
        .map(s => (s ?? '').trim())
        .filter(Boolean)
      if (!incoming.length) continue

      const { data: obj } = await supabaseAdmin
        .from('objects')
        .select('current_name, aliases')
        .eq('code', code)
        .maybeSingle()
      if (!obj) continue

      const known = new Set<string>()
      if (obj.current_name) known.add(obj.current_name.toLowerCase().trim())
      const existingAliases = (obj.aliases ?? []) as string[]
      for (const a of existingAliases) known.add(String(a).toLowerCase().trim())

      const fresh: string[] = []
      for (const n of incoming) {
        const key = n.toLowerCase()
        if (!known.has(key)) {
          fresh.push(n)
          known.add(key)
        }
      }
      if (fresh.length === 0) continue

      const newAliases = [...existingAliases, ...fresh]
      const { error: upErr } = await supabaseAdmin
        .from('objects')
        .update({ aliases: newAliases })
        .eq('code', code)
      if (upErr) {
        console.error(`[v2/save] aliases ${code}:`, upErr.message)
        continue
      }
      aliasesAdded[code] = fresh
    }

    // 5. Fire-and-forget индексация
    if (extractedText?.trim()) {
      void indexDocumentChunks(supabaseAdmin, doc.id, extractedText)
    }

    const addedCount = Object.values(aliasesAdded).reduce((s, a) => s + a.length, 0)
    console.log(`[v2/save] document=${doc.id} clauses=${clauses.length} objects=${object_codes?.length ?? 0} aliases_added=${addedCount}`)

    return NextResponse.json({
      document_id:    doc.id,
      folder_path:    doc.folder_path,
      customer:       { ...customer },
      contractor:     { ...contractor },
      clauses:        clauses.length,
      aliases_added:  aliasesAdded,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[v2/save] exception:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
