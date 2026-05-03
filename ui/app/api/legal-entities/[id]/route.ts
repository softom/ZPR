/**
 * /api/legal-entities/[id]
 *
 * GET    — одна запись.
 * PATCH  — правка реквизитов (с проверкой уникальности ИНН).
 * DELETE — soft delete: is_active = false.
 *          Запрет, если на ЮЛ ссылается активный договор.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { data, error } = await supabaseAdmin
    .from('legal_entities')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  // Дополнительно: посчитать связанные активные договоры
  const { count } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .or(`customer_entity_id.eq.${id},contractor_entity_id.eq.${id}`)
    .is('deleted_at', null)

  return NextResponse.json({ ...data, active_documents_count: count ?? 0 })
}

const ALLOWED = new Set([
  'name', 'short_name', 'kpp', 'ogrn', 'address_legal', 'address_postal',
  'signatory_name', 'signatory_position', 'signatory_basis',
  'bank_details', 'email', 'phone', 'website', 'notes',
  'entity_type', 'is_active',
  // ИНН менять отдельно (валидация уникальности)
])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await request.json() as Record<string, unknown>

    const update: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED.has(k)) update[k] = v
    }

    // ИНН — отдельно, через проверку уникальности
    if (typeof body.inn === 'string' && body.inn.trim()) {
      const newInn = body.inn.trim()
      const { data: existing } = await supabaseAdmin
        .from('legal_entities')
        .select('id')
        .eq('inn', newInn)
        .neq('id', id)
        .maybeSingle()
      if (existing) {
        return NextResponse.json(
          { error: `ИНН ${newInn} уже занят другим юр.лицом` },
          { status: 409 },
        )
      }
      update.inn = newInn
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('legal_entities')
      .update(update)
      .eq('id', id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json(data)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Проверка: есть ли активные договоры
  const { count } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .or(`customer_entity_id.eq.${id},contractor_entity_id.eq.${id}`)
    .is('deleted_at', null)

  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { error: `Невозможно архивировать: связано ${count} активных договоров. Сначала переведите договоры в архив.` },
      { status: 409 },
    )
  }

  const { error } = await supabaseAdmin
    .from('legal_entities')
    .update({ is_active: false })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
