/**
 * /api/strategic-topics/[id]/publish
 *
 * POST — admin фиксирует approved-ревизию как «финальный документ».
 *        Body: { revision_id: string } — должна быть status='approved' и принадлежать этой теме.
 *        Result: strategic_topics.published_revision_id = revision_id, published_at = now(),
 *                published_by_user_id = caller.id.
 *
 * DELETE — admin отзывает текущую публикацию (published_revision_id = NULL).
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getCaller, isAdmin } from '@/lib/auth-caller'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caller = await getCaller(req)
  if (!isAdmin(caller)) {
    return NextResponse.json({ error: 'Зафиксировать финальный документ может только admin' }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const revisionId = typeof body.revision_id === 'string' ? body.revision_id : null
  if (!revisionId) {
    return NextResponse.json({ error: 'revision_id обязателен' }, { status: 400 })
  }

  const { data: rev, error: revErr } = await supabaseAdmin
    .from('topic_revisions')
    .select('id, status, topic_id')
    .eq('id', revisionId)
    .eq('topic_id', id)
    .maybeSingle<{ id: string; status: string; topic_id: string }>()
  if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 })
  if (!rev)   return NextResponse.json({ error: 'Ревизия не найдена в этой теме' }, { status: 404 })
  if (rev.status !== 'approved') {
    return NextResponse.json({ error: `Можно фиксировать только approved-ревизию. Текущий статус: ${rev.status}` }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('strategic_topics')
    .update({
      published_revision_id: revisionId,
      published_at:          new Date().toISOString(),
      published_by_user_id:  caller!.id,
    })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caller = await getCaller(req)
  if (!isAdmin(caller)) {
    return NextResponse.json({ error: 'Отозвать финальный документ может только admin' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('strategic_topics')
    .update({
      published_revision_id: null,
      published_at:          null,
      published_by_user_id:  null,
    })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
