/**
 * POST /api/contracts/v2/[id]/stages/transition
 *
 * Body:
 * ```
 * { to_stage_id: string, note?: string }
 * ```
 *
 * Создаёт событие `contract_stage_change` (project_note → пока через manual подтип).
 * Триггер `events_apply_stage_change` (AFTER INSERT ON events) автоматически
 * обновляет `documents.current_stage_id = to_stage_id`.
 *
 * Возврат: `{ ok: true, event_id, new_current_stage_id }`.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as { to_stage_id?: string; note?: string }
    const toStageId = body.to_stage_id

    if (!toStageId) {
      return NextResponse.json({ error: 'to_stage_id required' }, { status: 400 })
    }

    // Проверяем что документ существует
    const { data: doc, error: dErr } = await supabaseAdmin
      .from('documents')
      .select('id, title, current_stage_id')
      .eq('id', id)
      .maybeSingle()
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
    if (!doc) return NextResponse.json({ error: 'Документ не найден' }, { status: 404 })

    // Проверяем что целевой этап принадлежит этому документу
    const { data: targetStage, error: tsErr } = await supabaseAdmin
      .from('contract_stages')
      .select('id, document_id, stage_number, stage_name')
      .eq('id', toStageId)
      .maybeSingle()
    if (tsErr) return NextResponse.json({ error: tsErr.message }, { status: 500 })
    if (!targetStage) return NextResponse.json({ error: 'Целевой этап не найден' }, { status: 404 })
    if (targetStage.document_id !== id) {
      return NextResponse.json({ error: 'Этап принадлежит другому документу' }, { status: 400 })
    }

    // Имя текущего этапа для заголовка события
    let fromStageId: string | null = null
    let fromStageName: string | null = null
    if (doc.current_stage_id) {
      fromStageId = doc.current_stage_id
      const { data: from } = await supabaseAdmin
        .from('contract_stages')
        .select('stage_name')
        .eq('id', doc.current_stage_id)
        .maybeSingle()
      fromStageName = from?.stage_name ?? null
    }

    const title = fromStageName
      ? `Переход этапа: «${fromStageName}» → «${targetStage.stage_name}»`
      : `Установка текущего этапа: «${targetStage.stage_name}»`

    // Создаём событие — триггер обновит documents.current_stage_id
    const today = new Date().toISOString().slice(0, 10)
    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events')
      .insert({
        event_type: 'contract_stage_change',
        title,
        date_start: today,
        date_end: today,
        note: body.note ?? null,
        subject_document_id: id,
        from_stage_id: fromStageId,
        to_stage_id: toStageId,
        contract_stage_id: toStageId,  // С 2026-05-18: общая привязка к этапу = целевой
      })
      .select('id')
      .single()
    if (evErr) return NextResponse.json({ error: `event insert: ${evErr.message}` }, { status: 500 })

    // Подтверждаем что триггер сработал
    const { data: docAfter } = await supabaseAdmin
      .from('documents')
      .select('current_stage_id')
      .eq('id', id)
      .maybeSingle()

    console.log(`[v2/stages/transition] doc=${id} ${fromStageId ?? 'none'} → ${toStageId} event=${ev.id}`)

    return NextResponse.json({
      ok: true,
      event_id: ev.id,
      new_current_stage_id: docAfter?.current_stage_id ?? null,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
