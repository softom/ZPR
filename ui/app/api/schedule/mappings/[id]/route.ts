/**
 * PATCH /api/schedule/mappings/[id] — изменить маппинг
 * DELETE /api/schedule/mappings/[id] — удалить
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (body.raw_text !== undefined) patch.raw_text = (body.raw_text as string).trim()
  if (body.notes !== undefined) patch.notes = body.notes
  if (body.object_id !== undefined || body.is_project_wide !== undefined) {
    const objectId = (body.object_id as string | null | undefined) ?? null
    const isProjectWide = Boolean(body.is_project_wide)
    if (!objectId && !isProjectWide) {
      return NextResponse.json(
        { error: 'Нужно object_id или is_project_wide=true' },
        { status: 400 },
      )
    }
    patch.object_id = isProjectWide ? null : objectId
    patch.is_project_wide = isProjectWide
  }

  const { data, error } = await supabaseAdmin
    .from('schedule_object_mapping')
    .update(patch)
    .eq('id', id)
    .select('id, raw_text, object_id, is_project_wide, notes, created_at, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ mapping: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { error } = await supabaseAdmin
    .from('schedule_object_mapping')
    .delete()
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
