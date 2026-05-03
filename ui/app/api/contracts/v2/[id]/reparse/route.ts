/**
 * POST /api/contracts/v2/[id]/reparse
 *
 * Повторный разбор пунктов договора через LLM. Источник текста (по приоритету):
 *   1. `documents.extracted_text` — кэш из БД (если был сохранён при загрузке).
 *   2. Файл договора из хранилища (`STORAGE_DIR + documents.folder_path` → первый PDF).
 *      После извлечения — текст кэшируется в `documents.extracted_text` для будущих вызовов.
 *
 * Возвращает только список clauses — без записи в БД.
 * Запись происходит отдельным POST /api/contracts/v2/[id]/clauses/replace,
 * чтобы оператор мог принять решение перед заменой существующих пунктов.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  extractContractClauses,
  type ObjectInfo,
  type ProjectStage,
} from '@/lib/parser/extractClauses'
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
    const [{ data: objects }, { data: stages }] = await Promise.all([
      supabaseAdmin
        .from('objects')
        .select('code,current_name,contractor,aliases')
        .eq('active', true),
      supabaseAdmin
        .from('project_stages')
        .select('code,label,sort_order')
        .order('sort_order'),
    ])

    // Шаг 4: LLM
    const analysis = await extractContractClauses(
      text,
      (objects ?? []) as ObjectInfo[],
      (stages ?? []) as ProjectStage[],
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
      clauses: analysis.clauses ?? [],
      signed_date: analysis.signed_date ?? doc.signed_date,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[v2/reparse]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
