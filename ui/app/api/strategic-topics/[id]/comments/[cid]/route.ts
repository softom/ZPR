/**
 * /api/strategic-topics/[id]/comments/[cid]
 *
 * DELETE — удалить комментарий. Автор или admin.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getCaller, isAdmin } from '@/lib/auth-caller'

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  const { id, cid } = await params
  const caller = await getCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 })
  }

  const { data: comment } = await supabaseAdmin
    .from('topic_comments')
    .select('id, author_user_id')
    .eq('id', cid)
    .eq('topic_id', id)
    .maybeSingle<{ id: string; author_user_id: string | null }>()
  if (!comment) return NextResponse.json({ error: 'Комментарий не найден' }, { status: 404 })

  if (!isAdmin(caller) && comment.author_user_id !== caller.id) {
    return NextResponse.json({ error: 'Удалить может только автор или админ' }, { status: 403 })
  }

  const { error } = await supabaseAdmin
    .from('topic_comments')
    .delete()
    .eq('id', cid)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
