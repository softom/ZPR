import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// PATCH /api/objects/[id] — правка полей объекта.
// На сегодня поддерживается только llm_hint (контекст для LLM, не выводится в
// отчёты). Полная редактура объекта — через RLS в карточке /objects.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  let body: Record<string, unknown> = {}
  try {
    const raw = await request.text()
    if (raw.trim().length > 0) body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const update: Record<string, string | null> = {}
  if ('llm_hint' in body) {
    const v = body.llm_hint
    update.llm_hint = typeof v === 'string' ? v : v == null ? null : String(v)
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('objects')
    .update(update)
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ object: data })
}
