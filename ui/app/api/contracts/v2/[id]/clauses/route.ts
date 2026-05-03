/**
 * /api/contracts/v2/[id]/clauses
 *
 * GET  — список пунктов договора, сортировка по order_index.
 * POST — добавить новый пункт. order_index = max + 1, если не указан.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { inferDateMode } from '@/lib/contracts/buildClauseRows'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { data, error } = await supabaseAdmin
    .from('contract_clauses')
    .select('*')
    .eq('document_id', id)
    .order('order_index', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as {
      order_index?: number
      clause_date?: string | null
      description: string
      note?: string | null
      source_page?: number | null
      source_quote?: string | null
      term_days?: number | null
      term_type?: 'working' | 'calendar' | null
      term_base?: string | null
      term_text?: string | null
      term_ref_clause_id?: string | null
      category?: 'fin' | 'work' | 'appr' | 'legal' | null
    }

    if (!body.description?.trim()) {
      return NextResponse.json({ error: 'description required' }, { status: 400 })
    }

    let order = body.order_index
    if (order == null) {
      const { data: maxRow } = await supabaseAdmin
        .from('contract_clauses')
        .select('order_index')
        .eq('document_id', id)
        .order('order_index', { ascending: false })
        .limit(1)
        .maybeSingle()
      order = (maxRow?.order_index ?? 0) + 1
    }

    const dateMode = inferDateMode({
      order_index: order ?? 1,
      clause_date: body.clause_date ?? null,
      description: body.description,
      note: body.note ?? null,
      source_page: body.source_page ?? null,
      source_quote: body.source_quote ?? '',
      term_days: body.term_days ?? null,
      term_type: body.term_type ?? null,
      term_base: (body.term_base ?? null) as never,
      term_text: body.term_text ?? null,
    })

    const { data, error } = await supabaseAdmin
      .from('contract_clauses')
      .insert({
        document_id:  id,
        order_index:  order,
        clause_date:  body.clause_date || null,
        description:  body.description.trim(),
        note:         body.note || null,
        source_page:  body.source_page || null,
        source_quote: body.source_quote || null,
        term_days:    body.term_days ?? null,
        term_type:    body.term_type ?? null,
        term_base:    body.term_base ?? null,
        term_text:    body.term_text ?? null,
        term_ref_clause_id: body.term_ref_clause_id ?? null,
        date_mode:    dateMode,
        category:     body.category ?? null,
      })
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json(data, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
