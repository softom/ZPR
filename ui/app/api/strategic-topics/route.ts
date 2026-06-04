/**
 * /api/strategic-topics — стратегические управленческие темы.
 *
 * GET  — список с фильтрами (category, status, q).
 * POST — создание новой темы.
 *
 * См. WIKI 24_Стратегические_темы.md
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const category = searchParams.get('category')
  const status   = searchParams.get('status')
  const q        = searchParams.get('q')?.trim()

  let query = supabaseAdmin
    .from('strategic_topics')
    .select('*')
    .order('seq', { ascending: true })

  if (category) query = query.eq('category', category)
  if (status)   query = query.eq('status', status)

  if (q) {
    query = query.or(`title.ilike.%${q}%,synopsis.ilike.%${q}%,code.ilike.%${q}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ items: data ?? [] })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>

    if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
      return NextResponse.json({ error: 'title required' }, { status: 400 })
    }
    if (!body.category) {
      return NextResponse.json({ error: 'category required' }, { status: 400 })
    }
    if (!body.synopsis) {
      return NextResponse.json({ error: 'synopsis required' }, { status: 400 })
    }
    if (!body.threats) {
      return NextResponse.json({ error: 'threats required' }, { status: 400 })
    }

    const payload = {
      code:               nullable(body.code),
      title:              String(body.title).trim(),
      category:           String(body.category),
      synopsis:           String(body.synopsis).trim(),
      threats:            String(body.threats).trim(),
      solutions:          nullable(body.solutions),
      deadlines:          nullable(body.deadlines),
      status:             body.status ? String(body.status) : 'open',
      owner_entity_id:    body.owner_entity_id ?? null,
      source_document_id: body.source_document_id ?? null,
      source_quote:       nullable(body.source_quote),
      notes:              nullable(body.notes),
    }

    const { data, error } = await supabaseAdmin
      .from('strategic_topics')
      .insert(payload)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json(data, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

function nullable(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed ? trimmed : null
}
