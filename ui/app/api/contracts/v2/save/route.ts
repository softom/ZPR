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
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findOrCreateLegalEntity } from '@/lib/legalEntities/findOrCreate'
import { indexDocumentChunks } from '@/lib/vector/indexDocument'
import { buildClauseRows } from '@/lib/contracts/buildClauseRows'
import type { ContractAnalysis } from '@/lib/parser/extractClauses'

interface SavePayload {
  analysis: ContractAnalysis
  object_codes: string[]   // выбранные оператором (могут отличаться от LLM-предложения)
  extractedText?: string   // полный текст для индексации
}

const sanitize = (s: string) => s
  .replace(/[\\/:*?"<>|«»—]/g, '')
  .replace(/\s+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_|_$/g, '')

export async function POST(request: NextRequest) {
  try {
    const { analysis, object_codes, extractedText } = await request.json() as SavePayload

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

    // 4. contract_clauses — якорный пункт «Дата заключения договора» + пункты от LLM
    const clauses = analysis.clauses ?? []
    const clauseRows = buildClauseRows(doc.id, analysis.signed_date, clauses)
    if (clauseRows.length) {
      const { error: ccErr } = await supabaseAdmin
        .from('contract_clauses')
        .insert(clauseRows)
      if (ccErr) {
        console.error('[v2/save] contract_clauses:', ccErr.message)
        return NextResponse.json({ error: ccErr.message }, { status: 500 })
      }
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
