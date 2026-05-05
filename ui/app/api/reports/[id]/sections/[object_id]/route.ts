import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// PATCH /api/reports/[id]/sections/[object_id]
// Body: { project_movement?, achievements?, next_period_tasks?, risks? }
// Сохраняет ручную правку 4 разделов одной секции отчёта.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; object_id: string }> },
) {
  const { id, object_id } = await ctx.params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  // Финализированный отчёт нельзя править
  const r = await supabaseAdmin.from('reports').select('status').eq('id', id).single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (r.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя править' }, { status: 409 })
  }

  // 6 контентных полей секции (см. lib/reports/generateSection.ts → REPORT_FIELDS)
  const update: Record<string, string | null> = {}
  for (const k of [
    'project_movement',
    'achievements',
    'achievements_list',
    'next_period_tasks',
    'next_period_tasks_list',
    'risks',
  ]) {
    if (k in body) {
      const v = body[k]
      update[k] = (typeof v === 'string') ? v : (v == null ? null : String(v))
    }
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('object_reports')
    .update(update)
    .eq('report_id', id)
    .eq('object_id', object_id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ section: data })
}
