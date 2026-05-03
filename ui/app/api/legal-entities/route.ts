/**
 * /api/legal-entities — справочник юридических лиц.
 *
 * GET  — список с фильтрами (q, entity_type, is_active).
 * POST — создание новой записи (используется в админ-форме и в save договора).
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findOrCreateLegalEntity, type LegalEntityInput } from '@/lib/legalEntities/findOrCreate'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q          = searchParams.get('q')?.trim()
  const entityType = searchParams.get('entity_type')
  const isActive   = searchParams.get('is_active')

  let query = supabaseAdmin
    .from('legal_entities')
    .select('*')
    .order('name', { ascending: true })

  if (entityType) query = query.eq('entity_type', entityType)
  if (isActive === 'true')  query = query.eq('is_active', true)
  if (isActive === 'false') query = query.eq('is_active', false)

  if (q) {
    // Поиск по name, short_name, inn
    query = query.or(`name.ilike.%${q}%,short_name.ilike.%${q}%,inn.ilike.%${q}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ items: data ?? [] })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as LegalEntityInput

    if (!body.inn?.trim()) {
      return NextResponse.json({ error: 'inn required' }, { status: 400 })
    }
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name required' }, { status: 400 })
    }

    const result = await findOrCreateLegalEntity(supabaseAdmin, body)
    return NextResponse.json(result, { status: result.created ? 201 : 200 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
