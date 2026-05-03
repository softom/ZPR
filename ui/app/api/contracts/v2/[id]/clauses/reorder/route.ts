/**
 * POST /api/contracts/v2/[id]/clauses/reorder
 *
 * Массовая перенумерация пунктов после drag&drop в UI.
 * Принимает массив { id, order_index } — обновляет order_index каждой записи.
 *
 * Используется в редакторе пунктов договора (модуль B).
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface ReorderItem { id: string; order_index: number }

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { items } = await request.json() as { items: ReorderItem[] }

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }

    // Защита от UNIQUE(document_id, order_index): сначала сдвигаем всё в отрицательную зону,
    // потом раскладываем по новым позициям.
    const tmpUpdates = items.map((it, i) => ({ id: it.id, order_index: -(i + 1) }))

    for (const u of tmpUpdates) {
      const { error } = await supabaseAdmin
        .from('contract_clauses')
        .update({ order_index: u.order_index })
        .eq('id', u.id)
        .eq('document_id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    for (const it of items) {
      const { error } = await supabaseAdmin
        .from('contract_clauses')
        .update({ order_index: it.order_index })
        .eq('id', it.id)
        .eq('document_id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, count: items.length })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
