import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

// GET /api/masterplan-objects
//
// Фильтры:
//   ?queue=1|2|1-2
//   ?prefix=Г|К|С|... (первая часть code до '_')
//   ?has_business=true/false  (привязан ли masterplan_objects к objects через junction)
//   ?functional_object_id=<uuid>
//   ?include_inactive=true
//
// Источник — v_masterplan_objects_full (паспорт + метрики + связи в jsonb).
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const queue = url.searchParams.get('queue')
  const prefix = url.searchParams.get('prefix')
  const hasBusiness = url.searchParams.get('has_business')
  const foId = url.searchParams.get('functional_object_id')
  const includeInactive = url.searchParams.get('include_inactive') === 'true'

  let q = supabaseAdmin.from('v_masterplan_objects_full').select('*').order('code')
  if (queue) q = q.eq('queue', queue)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Row = {
    id: string; code: string; name_ppt: string; name_contract: string | null
    queue: string | null; object_codes: string[]; plot_codes: string[]; zone_codes: string[]
    metrics: Record<string, { value_num: number | null; value_text: string | null; unit: string | null; source: string; valid_from: string }>
    active: boolean
  }
  let items = (data as Row[] | null ?? [])
  if (!includeInactive) items = items.filter(r => r.active)
  if (prefix) items = items.filter(r => r.code.startsWith(prefix + '_'))
  if (hasBusiness === 'true')  items = items.filter(r => r.object_codes.length > 0)
  if (hasBusiness === 'false') items = items.filter(r => r.object_codes.length === 0)
  if (foId) {
    // фильтр по functional_object_id через прямой запрос junction
    const { data: links } = await supabaseAdmin
      .from('masterplan_object_functional_objects')
      .select('masterplan_object_id')
      .eq('functional_object_id', foId)
    const ids = new Set((links ?? []).map(l => l.masterplan_object_id))
    items = items.filter(r => ids.has(r.id))
  }

  return NextResponse.json({ items, total: items.length })
}