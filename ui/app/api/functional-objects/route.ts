import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

// GET /api/functional-objects
//
// Опциональные query-параметры:
//   ?object_id=<uuid>     — только зоны, СВЯЗАННЫЕ с конкретным бизнес-объектом
//                          (через junction functional_object_objects)
//   ?unassigned=true      — только зоны без единой привязки
//   ?include_inactive=true — включить деактивированные (по умолчанию active=true)
//
// Возвращает { items: [{ id, zone_code, name, kind, queue, object_ids, source_pmt_object_name }] }
// где object_ids — массив uuid связанных бизнес-объектов (M:N).
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const objectId = url.searchParams.get('object_id')
  const unassigned = url.searchParams.get('unassigned') === 'true'
  const includeInactive = url.searchParams.get('include_inactive') === 'true'

  // Подтягиваем все zone + список связанных объектов одним запросом.
  let q = supabaseAdmin
    .from('functional_objects')
    .select('id, zone_code, name, kind, queue, source_pmt_object_name, active, functional_object_objects ( object_id )')
    .order('zone_code')

  if (!includeInactive) q = q.eq('active', true)

  const { data, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  type Row = {
    id: string
    zone_code: string
    name: string
    kind: string
    queue: string | null
    source_pmt_object_name: string | null
    active: boolean
    functional_object_objects: { object_id: string }[] | null
  }

  let items = (data as Row[] | null ?? []).map(r => ({
    id: r.id,
    zone_code: r.zone_code,
    name: r.name,
    kind: r.kind,
    queue: r.queue,
    source_pmt_object_name: r.source_pmt_object_name,
    active: r.active,
    object_ids: (r.functional_object_objects ?? []).map(x => x.object_id),
  }))

  if (objectId)  items = items.filter(it => it.object_ids.includes(objectId))
  if (unassigned) items = items.filter(it => it.object_ids.length === 0)

  return NextResponse.json({ items })
}
