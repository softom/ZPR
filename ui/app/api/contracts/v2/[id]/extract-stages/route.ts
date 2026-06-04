/**
 * POST /api/contracts/v2/[id]/extract-stages
 *
 * Выделяет этапы для существующего договора БЕЗ перепарсивания clauses.
 *
 * Источник текста (по приоритету):
 *   1. `documents.extracted_text` — кэш в БД.
 *   2. PDF из хранилища (`STORAGE_DIR + folder_path`).
 *
 * Поведение:
 *   - DELETE существующих contract_stages для этого договора.
 *   - INSERT новых stages с pre-gen UUID.
 *   - UPDATE documents.current_stage_id = первый этап (is_default=true).
 *   - contract_clauses.stage_id у существующих пунктов **обнуляется**
 *     каскадно через FK (ON DELETE SET NULL при DELETE contract_stages).
 *     Привязку пунктов к новым этапам оператор делает вручную через UI редактора
 *     (это сохраняет правки пунктов оператора).
 *
 * Возврат: `{ ok: true, stages_count, default_stage_id, stages: [...] }`.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { extractContractStages } from '@/lib/parser/extractContractStages'
import { findContractFile } from '@/lib/contracts/findContractFile'
import { extractTextFromPdfBuffer } from '@/lib/pdf/extractServer'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const { data: doc, error: dErr } = await supabaseAdmin
      .from('documents')
      .select('id, extracted_text, deleted_at, folder_path, current_stage_id, title')
      .eq('id', id)
      .maybeSingle()
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
    if (!doc) return NextResponse.json({ error: 'Договор не найден' }, { status: 404 })
    if (doc.deleted_at) return NextResponse.json({ error: 'Договор архивирован' }, { status: 410 })

    // 1. Текст
    let text = doc.extracted_text?.trim() ?? ''
    if (!text) {
      if (!doc.folder_path) {
        return NextResponse.json(
          { error: 'У договора нет folder_path — файл недоступен.' },
          { status: 400 },
        )
      }
      const filePath = await findContractFile(doc.folder_path)
      if (!filePath) {
        return NextResponse.json(
          { error: `PDF не найден в хранилище: ${doc.folder_path}` },
          { status: 404 },
        )
      }
      const buffer = await readFile(filePath)
      const extracted = await extractTextFromPdfBuffer(buffer)
      text = extracted.fullText
      // Кэшируем
      void supabaseAdmin
        .from('documents')
        .update({ extracted_text: text })
        .eq('id', id)
    }

    // 2. LLM — извлекаем этапы
    const contractStages = await extractContractStages(text, doc.title ?? undefined)
    console.log(`[v2/extract-stages] doc=${id} stages извлечено: ${contractStages.length}`)

    // 3. Сбрасываем current_stage_id, удаляем старые этапы
    if (doc.current_stage_id) {
      await supabaseAdmin.from('documents').update({ current_stage_id: null }).eq('id', id)
    }
    const { error: delErr } = await supabaseAdmin
      .from('contract_stages')
      .delete()
      .eq('document_id', id)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

    // 4. INSERT новых stages
    let defaultStageId: string | null = null
    const stageRows = contractStages.map((s, idx) => {
      const sid = randomUUID()
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

    if (stageRows.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('contract_stages').insert(stageRows)
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    }

    // 5. Установить current_stage_id
    if (defaultStageId) {
      await supabaseAdmin
        .from('documents')
        .update({ current_stage_id: defaultStageId })
        .eq('id', id)
    }

    return NextResponse.json({
      ok: true,
      stages_count: stageRows.length,
      default_stage_id: defaultStageId,
      stages: stageRows.map(r => ({
        id: r.id,
        stage_number: r.stage_number,
        stage_name: r.stage_name,
        description: r.description,
      })),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[v2/extract-stages]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
