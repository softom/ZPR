import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// POST /api/plots/[id]/attach
// Body: { object_id: uuid }
// Привязывает участок к бизнес-объекту ЗПР (прямая привязка через plots.object_id).
// Не трогает functional_object_id — связь через зону ППТ остаётся как есть.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: plotId } = await params
  const body = await request.json() as { object_id: string }

  if (!body.object_id?.trim()) {
    return NextResponse.json({ error: 'object_id обязателен' }, { status: 400 })
  }

  // Проверяем что объект существует
  const { data: obj } = await supabaseAdmin
    .from('objects')
    .select('id, code, active')
    .eq('id', body.object_id)
    .maybeSingle()
  if (!obj) {
    return NextResponse.json({ error: 'Объект не найден' }, { status: 404 })
  }
  if (!obj.active) {
    return NextResponse.json({ error: 'Объект деактивирован' }, { status: 400 })
  }

  // Проверяем что plot существует
  const { data: plot } = await supabaseAdmin
    .from('plots')
    .select('id, code, object_id')
    .eq('id', plotId)
    .maybeSingle()
  if (!plot) {
    return NextResponse.json({ error: 'Участок не найден' }, { status: 404 })
  }

  // UPDATE привязки
  const { error: upErr } = await supabaseAdmin
    .from('plots')
    .update({ object_id: body.object_id, updated_at: new Date().toISOString() })
    .eq('id', plotId)
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    plot_code: plot.code,
    object_code: obj.code,
    previous_object_id: plot.object_id,
  })
}
