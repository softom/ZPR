/**
 * PATCH /api/protocols/[id]/summary
 *
 * Сохраняет правки пользователя в `meetings.summary_md`.
 * Body: { summary_md: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { summary_md?: string }

  if (typeof body.summary_md !== 'string') {
    return NextResponse.json({ error: 'Поле summary_md (string) обязательно' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('meetings')
    .update({ summary_md: body.summary_md })
    .eq('id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
