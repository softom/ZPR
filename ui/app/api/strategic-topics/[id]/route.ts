/**
 * /api/strategic-topics/[id]
 *
 * GET    — одна тема + связанный документ-источник.
 * PATCH  — правка полей.
 * DELETE — удаление (admin only через RLS).
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data, error } = await supabaseAdmin
    .from('strategic_topics')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  // Подтянем имя источника-документа, если есть
  let source_document: { id: string; title: string | null } | null = null
  if (data.source_document_id) {
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, title')
      .eq('id', data.source_document_id)
      .maybeSingle()
    if (doc) source_document = doc
  }

  // Имя владельца
  let owner: { id: string; name: string | null; short_name: string | null } | null = null
  if (data.owner_entity_id) {
    const { data: le } = await supabaseAdmin
      .from('legal_entities')
      .select('id, name, short_name')
      .eq('id', data.owner_entity_id)
      .maybeSingle()
    if (le) owner = le
  }

  return NextResponse.json({ ...data, source_document, owner })
}

const ALLOWED = new Set([
  'seq', 'code', 'title', 'category',
  'synopsis', 'threats', 'solutions', 'deadlines',
  'status',
  'owner_entity_id', 'source_document_id', 'source_quote',
  'notes',
])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as Record<string, unknown>

    const update: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (!ALLOWED.has(k)) continue
      if (k === 'seq') {
        // seq — int 1..999. Невалидное значение просто пропускаем,
        // не ломая остальной PATCH.
        const num = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN
        if (Number.isInteger(num) && num >= 1 && num <= 999) update.seq = num
        continue
      }
      if (typeof v === 'string') {
        const trimmed = v.trim()
        update[k] = trimmed === '' ? null : trimmed
      } else {
        update[k] = v
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('strategic_topics')
      .update(update)
      .eq('id', id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json(data)
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
  const { error } = await supabaseAdmin
    .from('strategic_topics')
    .delete()
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
