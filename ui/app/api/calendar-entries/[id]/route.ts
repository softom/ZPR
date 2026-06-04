import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// GET /api/calendar-entries/[id] — одна веха + history + per-object статусы
export async function GET(
  _: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  const { data: entry, error: e1 } = await supabaseAdmin
    .from('calendar_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })
  if (!entry) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  const [statuses, editions] = await Promise.all([
    supabaseAdmin.from('calendar_object_status').select('*').eq('calendar_id', id),
    supabaseAdmin.from('calendar_date_editions').select('*').eq('calendar_id', id).order('priority').order('created_at', { ascending: false }),
  ])

  return NextResponse.json({
    entry,
    object_statuses: statuses.data ?? [],
    date_editions:   editions.data ?? [],
  })
}

// PATCH /api/calendar-entries/[id] — правка полей.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  const body = await request.json().catch(() => ({}))

  const allow = new Set([
    'entry_type','title','object_ids',
    'date_mode','date_start','date_end',
    'date_ref_entry_id','date_ref_from','date_ref_offset','date_ref_offset_type',
    'duration_note','exec_days','exec_type','is_manual',
    'stage_name','stage_number',
  ])
  const update: Record<string, unknown> = {}
  for (const k of Object.keys(body)) {
    if (allow.has(k)) update[k] = body[k]
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('calendar_entries')
    .update(update)
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entry: data })
}

// DELETE /api/calendar-entries/[id] — каскадно удалит сателлиты.
export async function DELETE(
  _: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  // entity_links — без FK, чистим вручную
  await supabaseAdmin.from('entity_links').delete().match({ from_type: 'calendar_entry', from_id: id })
  await supabaseAdmin.from('entity_links').delete().match({ to_type:   'calendar_entry', to_id:   id })
  const { error } = await supabaseAdmin.from('calendar_entries').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
