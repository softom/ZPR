/**
 * GET  /api/contracts/v2/[id]/stages
 *   Список этапов договора с признаком «текущий».
 *   Использует view `contract_stages_with_progress` (clauses_count, is_current).
 *
 * POST /api/contracts/v2/[id]/stages
 *   Body: { stage_name: string, description?: string, after_stage_id?: string }
 *   Создаёт ручной этап (без LLM-источника — source_page/source_quote = NULL).
 *   Логика номеров: stage_number = max(stage_number)+1. Sort_order — в конец списка.
 *   Если after_stage_id указан — sort_order вставляется сразу после указанного,
 *   с пере-нумерацией последующих (на стороне сервера, чтобы избежать гонок).
 *   Если у договора ещё нет этапов — новый становится is_default=true и
 *   documents.current_stage_id выставляется на него.
 *
 *   Возврат: ContractStage row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data, error } = await supabaseAdmin
    .from('contract_stages_with_progress')
    .select('*')
    .eq('document_id', id)
    .order('sort_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ stages: data ?? [] })
}

interface CreateStageBody {
  stage_name?: string
  description?: string | null
  after_stage_id?: string | null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as CreateStageBody

    const stageName = (body.stage_name ?? '').trim()
    if (!stageName) {
      return NextResponse.json({ error: 'stage_name required' }, { status: 400 })
    }

    // Проверяем документ
    const { data: doc, error: dErr } = await supabaseAdmin
      .from('documents')
      .select('id, current_stage_id')
      .eq('id', id)
      .maybeSingle()
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
    if (!doc) return NextResponse.json({ error: 'Документ не найден' }, { status: 404 })

    // Берём текущие этапы — нужны max(stage_number) и пере-нумерация sort_order
    const { data: existing, error: lErr } = await supabaseAdmin
      .from('contract_stages')
      .select('id, stage_number, sort_order')
      .eq('document_id', id)
      .order('sort_order', { ascending: true })
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })

    const stages = existing ?? []
    const maxStageNumber = stages.reduce((m, s) => Math.max(m, s.stage_number), 0)
    const nextStageNumber = maxStageNumber + 1

    // Определяем sort_order и при необходимости — сдвиг последующих
    let newSortOrder: number
    if (body.after_stage_id) {
      const anchorIdx = stages.findIndex(s => s.id === body.after_stage_id)
      if (anchorIdx < 0) {
        return NextResponse.json({ error: 'after_stage_id не принадлежит документу' }, { status: 400 })
      }
      newSortOrder = stages[anchorIdx].sort_order + 1
      // Сдвигаем sort_order у всех stages с sort_order >= newSortOrder
      const toShift = stages.filter(s => s.sort_order >= newSortOrder)
      for (const s of toShift) {
        await supabaseAdmin
          .from('contract_stages')
          .update({ sort_order: s.sort_order + 1 })
          .eq('id', s.id)
      }
    } else {
      // В конец
      newSortOrder = (stages.length
        ? Math.max(...stages.map(s => s.sort_order))
        : 0) + 1
    }

    const isFirst = stages.length === 0
    const newId = randomUUID()

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('contract_stages')
      .insert({
        id:           newId,
        document_id:  id,
        stage_number: nextStageNumber,
        stage_name:   stageName,
        description:  body.description ?? null,
        sort_order:   newSortOrder,
        source_page:  null,
        source_quote: null,  // NULL = ручной этап, не из LLM
        is_default:   isFirst,
      })
      .select('*')
      .single()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

    // Если это первый этап — выставим current_stage_id
    if (isFirst && !doc.current_stage_id) {
      await supabaseAdmin
        .from('documents')
        .update({ current_stage_id: newId })
        .eq('id', id)
    }

    return NextResponse.json({ ok: true, stage: inserted })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
