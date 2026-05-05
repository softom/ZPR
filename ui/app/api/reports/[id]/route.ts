import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// GET /api/reports/[id] — отчёт + все секции с метаданными объектов
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const [reportRes, sectionsRes, objectsRes] = await Promise.all([
    supabaseAdmin
      .from('reports')
      .select('*')
      .eq('id', id)
      .single(),
    supabaseAdmin
      .from('object_reports')
      .select('*')
      .eq('report_id', id)
      .order('generated_at', { ascending: true }),
    supabaseAdmin
      .from('objects')
      .select('id, code, current_name, contractor, active, llm_hint')
      .order('code'),
  ])

  if (reportRes.error || !reportRes.data) {
    return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  }

  const objectsById = new Map<string, { code: string; current_name: string; contractor: string | null; active: boolean; llm_hint: string | null }>()
  for (const o of (objectsRes.data ?? [])) {
    objectsById.set(o.id, o)
  }

  // Секции с привязкой к объектам, отсортированные по object.code
  const sections = (sectionsRes.data ?? [])
    .map((s) => ({ ...s, object: objectsById.get(s.object_id) ?? null }))
    .sort((a, b) => (a.object?.code ?? '').localeCompare(b.object?.code ?? ''))

  return NextResponse.json({ report: reportRes.data, sections })
}

// PATCH /api/reports/[id] — ручная правка summary_md (или title)
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const cur = await supabaseAdmin.from('reports').select('status').eq('id', id).single()
  if (cur.error || !cur.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (cur.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя править' }, { status: 409 })
  }

  const update: Record<string, string | boolean | null> = {}
  for (const k of ['summary_md', 'title']) {
    if (k in body) {
      const v = body[k]
      update[k] = typeof v === 'string' ? v : v == null ? null : String(v)
    }
  }
  if ('include_financials' in body) {
    update.include_financials = Boolean(body.include_financials)
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('reports')
    .update(update)
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ report: data })
}

// DELETE /api/reports/[id] — удалить (только status='draft')
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const cur = await supabaseAdmin.from('reports').select('status').eq('id', id).single()
  if (cur.error || !cur.data) {
    return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  }
  if (cur.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя удалить' }, { status: 409 })
  }
  const { error } = await supabaseAdmin.from('reports').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
