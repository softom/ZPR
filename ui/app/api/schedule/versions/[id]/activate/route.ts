/**
 * POST /api/schedule/versions/[id]/activate
 *
 * Делает указанную версию активной (is_active=true),
 * сбрасывает флаг у всех остальных.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = params.id

  // Проверяем что версия существует
  const { data: imp, error: checkErr } = await supabaseAdmin
    .from('schedule_imports')
    .select('id')
    .eq('id', id)
    .single()
  if (checkErr || !imp) {
    return NextResponse.json({ error: 'Версия не найдена' }, { status: 404 })
  }

  // Сбрасываем is_active у всех
  const { error: clearErr } = await supabaseAdmin
    .from('schedule_imports')
    .update({ is_active: false })
    .eq('is_active', true)
  if (clearErr) return NextResponse.json({ error: clearErr.message }, { status: 500 })

  // Активируем нужную
  const { data, error } = await supabaseAdmin
    .from('schedule_imports')
    .update({ is_active: true })
    .eq('id', id)
    .select('id, version_name, is_active, imported_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}
