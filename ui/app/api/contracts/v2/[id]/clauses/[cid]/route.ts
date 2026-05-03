/**
 * /api/contracts/v2/[id]/clauses/[cid]
 *
 * PATCH  — правка одного пункта.
 * DELETE — удаление одного пункта (hard, не soft — пункт не имеет архивного состояния).
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const ALLOWED = new Set([
  'order_index', 'clause_date', 'description', 'note', 'source_page', 'source_quote',
  'term_days', 'term_type', 'term_base', 'term_text',
  'term_ref_clause_id',
  'date_mode',
  'category',
])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const { id, cid } = await params
    const body = await request.json() as Record<string, unknown>

    const update: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED.has(k)) update[k] = v
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('contract_clauses')
      .update(update)
      .eq('id', cid)
      .eq('document_id', id)   // защита от случайного редактирования чужого пункта
      .select('*')
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data)  return NextResponse.json({ error: 'Пункт не найден' }, { status: 404 })

    return NextResponse.json(data)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  const { id, cid } = await params
  const { error } = await supabaseAdmin
    .from('contract_clauses')
    .delete()
    .eq('id', cid)
    .eq('document_id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
