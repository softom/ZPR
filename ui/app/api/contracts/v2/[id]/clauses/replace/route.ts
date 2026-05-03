/**
 * POST /api/contracts/v2/[id]/clauses/replace
 *
 * Атомарная замена всех пунктов договора:
 *   1. DELETE FROM contract_clauses WHERE document_id = id
 *      (каскадно удалит clause_events для этих пунктов; events не трогаются).
 *   2. INSERT новых пунктов из body.
 *
 * Используется кнопкой «🔄 Переразобрать пункты» в UI после подтверждения оператора.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildClauseRows } from '@/lib/contracts/buildClauseRows'
import type { ClauseInfo } from '@/lib/parser/extractClauses'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { clauses } = await request.json() as { clauses: ClauseInfo[] }

    if (!Array.isArray(clauses)) {
      return NextResponse.json({ error: 'clauses array required' }, { status: 400 })
    }

    // Получаем signed_date документа — нужен для якорного пункта
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('signed_date')
      .eq('id', id)
      .maybeSingle()

    // 1. Удаляем все текущие пункты договора (FK CASCADE подчистит clause_events)
    const { error: dErr } = await supabaseAdmin
      .from('contract_clauses')
      .delete()
      .eq('document_id', id)
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

    // 2. Вставляем якорь + новые пункты от LLM (включая category и date_mode)
    const rows = buildClauseRows(id, doc?.signed_date ?? null, clauses)
    if (rows.length > 0) {
      const { error: iErr } = await supabaseAdmin.from('contract_clauses').insert(rows)
      if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })
    }

    console.log(`[v2/clauses/replace] document=${id} rows=${rows.length} (anchor=${rows.some(r => r.is_anchor)})`)
    return NextResponse.json({ ok: true, count: rows.length })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
