/**
 * PATCH /api/schedule/versions/[id]  — обновить version_name и/или notes
 * DELETE /api/schedule/versions/[id] — удалить версию (cascade → calendar_entries)
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: { version_name?: string; notes?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if ('version_name' in body) patch.version_name = body.version_name ?? null
  if ('notes' in body) patch.notes = body.notes ?? null

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('schedule_imports')
    .update(patch)
    .eq('id', id)
    .select('id, version_name, notes')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Запрещаем удалять активную версию
  const { data: imp } = await supabaseAdmin
    .from('schedule_imports')
    .select('is_active')
    .eq('id', id)
    .single()
  if (imp?.is_active) {
    return NextResponse.json(
      { error: 'Нельзя удалить активную версию. Сначала активируйте другую.' },
      { status: 409 },
    )
  }

  const { error } = await supabaseAdmin
    .from('schedule_imports')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
