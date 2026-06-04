import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  buildControlPreamble, generateLlmPreamble, loadPreambleLines,
} from '@/lib/reports/generateControlPreamble'

export const maxDuration = 60

// PATCH /api/reports/[id]/preamble — ручная правка преамбулы
// Body: { preamble: string }
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  let body: { preamble?: unknown }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }
  const preamble = typeof body.preamble === 'string' ? body.preamble : null

  const r = await supabaseAdmin.from('reports').select('status').eq('id', id).single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (r.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя править' }, { status: 409 })
  }

  const { data, error } = await supabaseAdmin
    .from('reports')
    .update({ preamble })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ report: data })
}

// POST /api/reports/[id]/preamble — сгенерировать преамбулу
// Query: ?mode=template (default) — детерминированный шаблон
//        ?mode=llm                  — через LLM (связный текст)
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const url = new URL(request.url)
  const mode = url.searchParams.get('mode') ?? 'template'

  const r = await supabaseAdmin
    .from('reports')
    .select('period_type, period_start, status')
    .eq('id', id)
    .single()
  if (r.error || !r.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (r.data.period_type !== 'control') {
    return NextResponse.json({ error: 'Преамбула только для control-отчётов' }, { status: 400 })
  }
  if (r.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя править' }, { status: 409 })
  }

  const snapshot = new Date(r.data.period_start)
  const lines = await loadPreambleLines(id)

  let preamble: string
  try {
    preamble = mode === 'llm'
      ? await generateLlmPreamble(snapshot, lines)
      : buildControlPreamble(snapshot, lines)
  } catch (e) {
    return NextResponse.json({ error: `Преамбула: ${(e as Error).message}` }, { status: 500 })
  }

  const { data, error } = await supabaseAdmin
    .from('reports')
    .update({ preamble })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ report: data })
}
