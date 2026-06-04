/**
 * GET  /api/schedule/mappings  — список маппингов raw_text → object_id
 * POST /api/schedule/mappings  — создать маппинг
 *
 * POST body:
 *   { raw_text, object_id?, is_project_wide?, notes? }
 *   Должно быть либо object_id, либо is_project_wide=true.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('schedule_object_mapping')
    .select('id, raw_text, object_id, is_project_wide, notes, created_at, updated_at')
    .order('raw_text')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ mappings: data ?? [] })
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawText = (body.raw_text as string | undefined)?.trim()
  if (!rawText) return NextResponse.json({ error: 'raw_text обязателен' }, { status: 400 })

  const objectId = (body.object_id as string | null | undefined) ?? null
  const isProjectWide = Boolean(body.is_project_wide)

  if (!objectId && !isProjectWide) {
    return NextResponse.json(
      { error: 'Нужно указать object_id ИЛИ is_project_wide=true' },
      { status: 400 },
    )
  }
  if (objectId && isProjectWide) {
    return NextResponse.json(
      { error: 'Нельзя одновременно указывать object_id и is_project_wide' },
      { status: 400 },
    )
  }

  const { data, error } = await supabaseAdmin
    .from('schedule_object_mapping')
    .insert({
      raw_text: rawText,
      object_id: isProjectWide ? null : objectId,
      is_project_wide: isProjectWide,
      notes: (body.notes as string | null | undefined) ?? null,
    })
    .select('id, raw_text, object_id, is_project_wide, notes, created_at, updated_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Маппинг с таким raw_text уже существует (case-insensitive)' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ mapping: data }, { status: 201 })
}
