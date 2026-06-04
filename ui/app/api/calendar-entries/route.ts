import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// GET /api/calendar-entries
//   ?object_id=UUID  → только вехи этого объекта
//   ?document_id=UUID → только вехи, привязанные к договору (через entity_links)
//   без параметров   → все
//
// Возвращает: { entries: CalendarEntry[] }
// См. WIKI 15_Календарь_объекта.
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const objectId   = url.searchParams.get('object_id')
  const documentId = url.searchParams.get('document_id')

  let q = supabaseAdmin
    .from('calendar_entries')
    .select('id,entry_type,title,object_ids,date_mode,date_start,date_end,date_ref_entry_id,date_ref_from,date_ref_offset,date_ref_offset_type,date_computed,duration_note,exec_days,exec_type,is_manual,stage_name,stage_number,created_at')
    .order('date_computed', { ascending: true, nullsFirst: false })

  if (objectId) {
    q = q.contains('object_ids', [objectId])
  }
  if (documentId) {
    // Через entity_links: from_type='calendar_entry' → to_type='document'
    const { data: links, error: lerr } = await supabaseAdmin
      .from('entity_links')
      .select('from_id')
      .eq('from_type', 'calendar_entry')
      .eq('to_type', 'document')
      .eq('to_id', documentId)
    if (lerr) return NextResponse.json({ error: lerr.message }, { status: 500 })
    const ids = (links ?? []).map((l) => l.from_id as string)
    if (ids.length === 0) return NextResponse.json({ entries: [] })
    q = q.in('id', ids)
  }

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entries: data ?? [] })
}

// POST /api/calendar-entries — создание новой календарной вехи.
// Body: { entry_type, title, object_ids?, date_mode?, date_start?, date_end?, ... }
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  if (!body.entry_type || !body.title) {
    return NextResponse.json({ error: 'entry_type и title обязательны' }, { status: 400 })
  }
  const { data, error } = await supabaseAdmin
    .from('calendar_entries')
    .insert({
      entry_type:           body.entry_type,
      title:                body.title,
      object_ids:           body.object_ids ?? [],
      date_mode:            body.date_mode ?? 'absolute',
      date_start:           body.date_start ?? null,
      date_end:             body.date_end ?? null,
      date_ref_entry_id:    body.date_ref_entry_id ?? null,
      date_ref_from:        body.date_ref_from ?? 'end',
      date_ref_offset:      body.date_ref_offset ?? 0,
      date_ref_offset_type: body.date_ref_offset_type ?? 'calendar',
      duration_note:        body.duration_note ?? null,
      exec_days:            body.exec_days ?? null,
      exec_type:            body.exec_type ?? 'calendar',
      is_manual:            body.is_manual ?? false,
      stage_name:           body.stage_name ?? null,
      stage_number:         body.stage_number ?? null,
    })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ entry: data })
}
