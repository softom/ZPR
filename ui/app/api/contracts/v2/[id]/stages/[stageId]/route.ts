/**
 * PATCH  /api/contracts/v2/[id]/stages/[stageId]
 *   Body: { stage_name?, description?, sort_order? }
 *   Точечно правит поля этапа. Не трогает stage_number (его меняет только
 *   пере-выделение через /extract-stages).
 *
 * DELETE /api/contracts/v2/[id]/stages/[stageId]
 *   Удаляет этап. Если этап текущий (documents.current_stage_id) — сначала
 *   переключаем на следующий по sort_order или NULL.
 *   contract_clauses.stage_id у привязанных пунктов обнулится автоматически
 *   через FK ON DELETE SET NULL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface PatchBody {
  stage_name?: string
  description?: string | null
  sort_order?: number
}

async function ensureBelongs(stageId: string, documentId: string) {
  const { data, error } = await supabaseAdmin
    .from('contract_stages')
    .select('id, document_id, sort_order')
    .eq('id', stageId)
    .maybeSingle()
  if (error) return { error: error.message, status: 500 as const }
  if (!data) return { error: 'Этап не найден', status: 404 as const }
  if (data.document_id !== documentId) {
    return { error: 'Этап принадлежит другому документу', status: 400 as const }
  }
  return { stage: data }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; stageId: string }> },
) {
  try {
    const { id, stageId } = await params
    const body = await request.json() as PatchBody

    const check = await ensureBelongs(stageId, id)
    if ('error' in check) return NextResponse.json({ error: check.error }, { status: check.status })

    const patch: Record<string, unknown> = {}
    if (typeof body.stage_name === 'string') {
      const v = body.stage_name.trim()
      if (!v) return NextResponse.json({ error: 'stage_name не может быть пустым' }, { status: 400 })
      patch.stage_name = v
    }
    if (body.description !== undefined) {
      patch.description = body.description === null ? null : String(body.description)
    }
    if (typeof body.sort_order === 'number') {
      patch.sort_order = body.sort_order
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('contract_stages')
      .update(patch)
      .eq('id', stageId)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, stage: data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; stageId: string }> },
) {
  try {
    const { id, stageId } = await params

    const check = await ensureBelongs(stageId, id)
    if ('error' in check) return NextResponse.json({ error: check.error }, { status: check.status })

    // Если удаляемый этап — текущий, переключаемся на следующий по sort_order
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('current_stage_id')
      .eq('id', id)
      .maybeSingle()

    if (doc?.current_stage_id === stageId) {
      const { data: candidates } = await supabaseAdmin
        .from('contract_stages')
        .select('id, sort_order')
        .eq('document_id', id)
        .neq('id', stageId)
        .order('sort_order', { ascending: true })

      const next = (candidates ?? [])
        .find(s => s.sort_order > check.stage.sort_order)
        ?? (candidates ?? [])[0]
        ?? null

      await supabaseAdmin
        .from('documents')
        .update({ current_stage_id: next?.id ?? null })
        .eq('id', id)
    }

    const { error: delErr } = await supabaseAdmin
      .from('contract_stages')
      .delete()
      .eq('id', stageId)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
