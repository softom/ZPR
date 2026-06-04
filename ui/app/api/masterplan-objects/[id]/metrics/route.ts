import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// GET — все метрики объекта с историей и метаданными.
// Параметр ?include_history=true (по умолчанию false — только valid_to IS NULL).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const includeHistory = new URL(req.url).searchParams.get('include_history') === 'true'

  let q = supabaseAdmin
    .from('masterplan_object_metrics')
    .select(`
      id, metric_code, source, source_document_id,
      value_num, value_text, unit, valid_from, valid_to, note,
      created_at, updated_at,
      documents:source_document_id ( title, version )
    `)
    .eq('masterplan_object_id', id)
    .order('metric_code')
    .order('source')
    .order('valid_from', { ascending: false })
  if (!includeHistory) q = q.is('valid_to', null)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Подмешиваем label/category из справочника одним запросом
  const codes = Array.from(new Set((data ?? []).map((r: { metric_code: string }) => r.metric_code)))
  const { data: codeRows } = await supabaseAdmin
    .from('masterplan_metric_codes').select('code, label, category, default_unit, sort_order').in('code', codes)
  const codeMap = new Map((codeRows ?? []).map(r => [r.code, r]))

  const items = (data ?? []).map((m: Record<string, unknown>) => ({
    ...m,
    metric_label: codeMap.get(m.metric_code as string)?.label,
    metric_category: codeMap.get(m.metric_code as string)?.category,
    sort_order: codeMap.get(m.metric_code as string)?.sort_order ?? 999,
  })).sort((a, b) => (a.sort_order as number) - (b.sort_order as number))

  return NextResponse.json({ items, total: items.length })
}

// POST — добавить новую запись метрики (триггер автоматически закроет старую того же документа/source).
// Body: { metric_code, source, value_num? | value_text?, unit?, source_document_id?, note?, valid_from? }
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(await req.text() || '{}') }
  catch { return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 }) }

  const metric_code = body.metric_code
  const source = body.source
  if (typeof metric_code !== 'string' || typeof source !== 'string') {
    return NextResponse.json({ error: 'metric_code и source обязательны' }, { status: 400 })
  }
  if (body.value_num == null && body.value_text == null) {
    return NextResponse.json({ error: 'Нужно указать value_num или value_text' }, { status: 400 })
  }

  const rec: Record<string, unknown> = {
    masterplan_object_id: id,
    metric_code, source,
    valid_from: (body.valid_from as string) ?? new Date().toISOString().slice(0, 10),
  }
  for (const k of ['value_num', 'value_text', 'unit', 'source_document_id', 'note']) {
    if (k in body) rec[k] = body[k]
  }

  const { data, error } = await supabaseAdmin
    .from('masterplan_object_metrics').insert(rec).select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ metric: data, changed: true })
}