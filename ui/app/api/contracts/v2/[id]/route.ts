/**
 * /api/contracts/v2/[id]
 *
 * GET    — карточка договора + стороны + объекты + пункты.
 * PATCH  — правка метаданных + смена сторон + смена объектов (через document_objects).
 * DELETE — soft delete договора с погашением событий.
 *          См. 17_Сущность_Договор_и_ЮрЛицо.md → «Удаление договора».
 *          Шаги:
 *            1. Найти все events через entity_links (from_type=event, to_type=document, to_id=docId).
 *            2. Удалить entity_links для этих событий (включая привязки к объектам/юр.лицам).
 *            3. Удалить сами events (каскад: event_date_editions, event_predecessors).
 *            4. Soft delete: documents.deleted_at = now().
 *            5. Очистить document_chunks (освободить pgvector).
 *          Остаются: contract_clauses, document_objects, файл в хранилище.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data: doc, error: dErr } = await supabaseAdmin
    .from('documents')
    .select(`
      id, title, version, type, folder_path, signed_date,
      customer_entity_id, contractor_entity_id, parties_snapshot,
      project_stage,
      indexed_at, deleted_at, created_at, letter_id,
      customer:legal_entities!documents_customer_entity_id_fkey(*),
      contractor:legal_entities!documents_contractor_entity_id_fkey(*),
      stage:project_stages!documents_project_stage_fkey(code,label,sort_order)
    `)
    .eq('id', id)
    .maybeSingle()

  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
  if (!doc)  return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  const { data: objects } = await supabaseAdmin
    .from('document_objects')
    .select('object_code, objects(code, current_name, contractor)')
    .eq('document_id', id)

  const { data: clauses } = await supabaseAdmin
    .from('contract_clauses')
    .select('*')
    .eq('document_id', id)
    .order('order_index', { ascending: true })

  return NextResponse.json({
    ...doc,
    objects:  objects ?? [],
    clauses:  clauses ?? [],
  })
}

const ALLOWED_DOC_FIELDS = new Set([
  'title', 'version', 'folder_path',
  'customer_entity_id', 'contractor_entity_id',
  'project_stage',
  'signed_date',
])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as Record<string, unknown> & {
      object_codes?: string[]
    }

    const update: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_DOC_FIELDS.has(k)) update[k] = v
    }

    if (Object.keys(update).length > 0) {
      const { error } = await supabaseAdmin
        .from('documents')
        .update(update)
        .eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Смена связей с объектами — пересоздаём строки document_objects
    if (Array.isArray(body.object_codes)) {
      await supabaseAdmin.from('document_objects').delete().eq('document_id', id)
      if (body.object_codes.length > 0) {
        const rows = body.object_codes.map(code => ({ document_id: id, object_code: code }))
        const { error } = await supabaseAdmin.from('document_objects').insert(rows)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // 1. Найти события, привязанные к договору через entity_links
  const { data: eventLinks } = await supabaseAdmin
    .from('entity_links')
    .select('from_id')
    .eq('from_type', 'event')
    .eq('to_type', 'document')
    .eq('to_id', id)

  const eventIds = (eventLinks ?? []).map((l) => l.from_id as string)

  // 2. Погасить события: удалить entity_links и сами events
  if (eventIds.length > 0) {
    await supabaseAdmin
      .from('entity_links')
      .delete()
      .in('from_id', eventIds)
      .eq('from_type', 'event')

    await supabaseAdmin
      .from('events')
      .delete()
      .in('id', eventIds)
  }

  // 3. Soft delete договора + очистка векторного индекса
  const { error } = await supabaseAdmin
    .from('documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await supabaseAdmin.from('document_chunks').delete().eq('document_id', id)

  return NextResponse.json({ ok: true, eventsDeleted: eventIds.length })
}
