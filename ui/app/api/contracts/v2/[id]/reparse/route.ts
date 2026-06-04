/**
 * POST /api/contracts/v2/[id]/reparse
 *
 * Body: { skip_stages?: boolean }
 *
 * Повторный разбор договора через LLM. Источник текста (по приоритету):
 *   1. `documents.extracted_text` — кэш из БД (если был сохранён при загрузке).
 *   2. Файл договора из хранилища (`STORAGE_DIR + documents.folder_path` → первый PDF).
 *      После извлечения — текст кэшируется в `documents.extracted_text` для будущих вызовов.
 *
 * Режимы:
 *   - default (skip_stages=false): два прохода LLM — этапы (extractContractStages),
 *     потом пункты (extractContractClauses со stage_number). Возвращает { stages, clauses }.
 *   - skip_stages=true: использует существующие contract_stages из БД, выполняет
 *     только LLM-проход 2 (пункты). Возвращает { stages: <из БД>, clauses }.
 *     Этот режим вызывает кнопка «🎯 Выделить события договора».
 *
 * Возвращает только данные — без записи в БД.
 * Запись происходит отдельным POST /api/contracts/v2/[id]/clauses/replace.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  extractContractClauses,
  type ObjectInfo,
  type ProjectStage,
  type ContractEventTypeInfo,
} from '@/lib/parser/extractClauses'
import { extractContractStages, type ContractStageInfo } from '@/lib/parser/extractContractStages'
import { findContractFile } from '@/lib/contracts/findContractFile'
import { extractTextFromPdfBuffer } from '@/lib/pdf/extractServer'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    // Тело опциональное (старые клиенты вызывают без body)
    let skipStages = false
    try {
      const body = await request.json() as { skip_stages?: boolean } | null
      skipStages = body?.skip_stages === true
    } catch {
      // empty body — обычный режим
    }

    const { data: doc, error: dErr } = await supabaseAdmin
      .from('documents')
      .select('id, extracted_text, deleted_at, folder_path, signed_date')
      .eq('id', id)
      .maybeSingle()
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
    if (!doc)  return NextResponse.json({ error: 'Договор не найден' }, { status: 404 })
    if (doc.deleted_at) {
      return NextResponse.json({ error: 'Договор архивирован' }, { status: 410 })
    }

    // Шаг 1: пытаемся получить текст из БД-кэша
    let text = doc.extracted_text?.trim() ?? ''

    // Шаг 2: если в БД пусто — извлекаем из файла в хранилище и кэшируем
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

      try {
        const buffer = await readFile(filePath)
        const extracted = await extractTextFromPdfBuffer(buffer)
        text = extracted.fullText
        console.log(`[v2/reparse] doc=${id} extracted from file: ${filePath} (${extracted.numPages} страниц)`)

        // Кэшируем для следующих reparse — fire-and-forget
        void supabaseAdmin
          .from('documents')
          .update({ extracted_text: text })
          .eq('id', id)
          .then(({ error }) => {
            if (error) console.error('[v2/reparse] cache update error:', error.message)
          })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return NextResponse.json(
          { error: `Не удалось извлечь текст из PDF: ${msg}` },
          { status: 500 },
        )
      }
    }

    // Шаг 3: справочники для контекста LLM
    const [{ data: objects }, { data: stages }, { data: eventTypes }] = await Promise.all([
      supabaseAdmin
        .from('objects')
        .select('code,current_name,contractor,aliases')
        .eq('active', true),
      supabaseAdmin
        .from('project_stages')
        .select('code,label,sort_order')
        .order('sort_order'),
      supabaseAdmin
        .from('contract_event_types')
        .select('code,category,label,is_intermediate,is_anchor')
        .eq('is_active', true)
        .order('sort_order'),
    ])

    // Шаг 4a: LLM-проход 1 — этапы (или используем существующие из БД)
    let contractStages: ContractStageInfo[]
    if (skipStages) {
      const { data: dbStages, error: csErr } = await supabaseAdmin
        .from('contract_stages')
        .select('stage_number, stage_name, description, sort_order, source_page, source_quote')
        .eq('document_id', id)
        .order('sort_order', { ascending: true })
      if (csErr) return NextResponse.json({ error: csErr.message }, { status: 500 })
      contractStages = (dbStages ?? []) as ContractStageInfo[]
      console.log(`[v2/reparse] doc=${id} skip_stages=true, используем ${contractStages.length} этапов из БД`)
    } else {
      contractStages = await extractContractStages(text)
      console.log(`[v2/reparse] doc=${id} stages извлечено: ${contractStages.length}`)
    }

    // Шаг 4b: LLM-проход 2 — clauses с привязкой к stage_number
    const analysis = await extractContractClauses(
      text,
      (objects ?? []) as ObjectInfo[],
      (stages ?? []) as ProjectStage[],
      contractStages,
      (eventTypes ?? []) as ContractEventTypeInfo[],
    )

    // Шаг 5: если в БД нет signed_date, а LLM нашёл — обновим documents.signed_date.
    // Это нужно для якорного пункта при последующем /clauses/replace.
    if (!doc.signed_date && analysis.signed_date) {
      const { error: upErr } = await supabaseAdmin
        .from('documents')
        .update({ signed_date: analysis.signed_date })
        .eq('id', id)
      if (upErr) console.error('[v2/reparse] update signed_date:', upErr.message)
    }

    return NextResponse.json({
      stages: contractStages,
      clauses: analysis.clauses ?? [],
      signed_date: analysis.signed_date ?? doc.signed_date,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[v2/reparse]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
