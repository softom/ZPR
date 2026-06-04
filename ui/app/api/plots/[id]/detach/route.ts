import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// POST /api/plots/[id]/detach
// Body: пустое
// Очищает прямую привязку plots.object_id. Привязка через functional_object
// остаётся как есть — отвязать через зону можно только через UI functional_objects.

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: plotId } = await params

  const { data: plot } = await supabaseAdmin
    .from('plots')
    .select('id, code, object_id')
    .eq('id', plotId)
    .maybeSingle()
  if (!plot) {
    return NextResponse.json({ error: 'Участок не найден' }, { status: 404 })
  }
  if (!plot.object_id) {
    return NextResponse.json({ error: 'У участка нет прямой привязки' }, { status: 400 })
  }

  const { error: upErr } = await supabaseAdmin
    .from('plots')
    .update({ object_id: null, updated_at: new Date().toISOString() })
    .eq('id', plotId)
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    plot_code: plot.code,
    previous_object_id: plot.object_id,
  })
}
