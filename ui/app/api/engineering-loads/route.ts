import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/engineering-loads?object_id=<uuid>
 *
 * Расчётные инженерные нагрузки (Том 2.2 ППТ) для бизнес-объекта ЗПР.
 * Объект связан с functional_objects через M:N junction functional_object_objects,
 * а нагрузки привязаны к functional_object_id.
 *
 * Возвращает { loads: [...] } отсортированные по network.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const objectId = url.searchParams.get('object_id')

  if (!objectId) {
    return NextResponse.json({ error: 'object_id required' }, { status: 400 })
  }

  // Находим functional_objects, связанные с этим бизнес-объектом через M:N junction
  const { data: foLinks, error: foErr } = await supabaseAdmin
    .from('functional_object_objects')
    .select('functional_object_id')
    .eq('object_id', objectId)

  if (foErr) {
    return NextResponse.json({ error: foErr.message }, { status: 500 })
  }

  const foIds = (foLinks ?? []).map((r: { functional_object_id: string }) => r.functional_object_id)

  if (foIds.length === 0) {
    return NextResponse.json({ loads: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('engineering_loads')
    .select('*')
    .in('functional_object_id', foIds)
    .order('network')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ loads: data ?? [] })
}
