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

  // Текстовые поля: 6 для week/month, 3 для control
  const update: Record<string, string | null> = {}
  const STRING_FIELDS = [
    // week/month:
    'project_movement', 'achievements', 'achievements_list',
    'next_period_tasks', 'next_period_tasks_list', 'risks',
    // week v3:
    'weekly_done_brief', 'weekly_topics_brief', 'weekly_upcoming_brief',
    // control:
    'narrative', 'contract_summary', 'decisions',
  ]
  for (const k of STRING_FIELDS) {
    if (k in body) {
      const v = body[k]
      update[k] = (typeof v === 'string') ? v : (v == null ? null : String(v))
    }
  }
  // priority_group (control) — enum 'priority' | 'secondary' | null
  if ('priority_group' in body) {
    const v = body.priority_group
    if (v === 'priority' || v === 'secondary' || v === null) {
      update.priority_group = v
    } else if (v === '' || v === undefined) {
      update.priority_group = null
    } else {
      return NextResponse.json({ error: 'priority_group должен быть priority | secondary | null' }, { status: 400 })
    }
  }
  // tep_deadline (control) — date или null
  if ('tep_deadline' in body) {
    const v = body.tep_deadline
    if (v === null || v === '') {
      update.tep_deadline = null
    } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      update.tep_deadline = v
    } else {
      return NextResponse.json({ error: 'tep_deadline должен быть YYYY-MM-DD или null' }, { status: 400 })
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
