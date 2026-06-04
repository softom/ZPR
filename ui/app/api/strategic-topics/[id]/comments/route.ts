/**
 * /api/strategic-topics/[id]/comments
 *
 * GET  — список комментариев темы (включая привязанные к ревизиям/полям).
 * POST — создать комментарий. Body: { body, revision_id?, field_name? }.
 *        Только uploader+.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getCaller, isUploader } from '@/lib/auth-caller'

const FIELD_NAMES = new Set([
  'title','synopsis','threats','solutions','deadlines','category','seq',
])

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data, error } = await supabaseAdmin
    .from('topic_comments')
    .select('*')
    .eq('topic_id', id)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caller = await getCaller(req)
  if (!isUploader(caller)) {
    return NextResponse.json({ error: 'Только uploader/admin может комментировать' }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) {
    return NextResponse.json({ error: 'body обязателен' }, { status: 400 })
  }
  const fieldName = typeof body.field_name === 'string' && FIELD_NAMES.has(body.field_name) ? body.field_name : null
  const revisionId = typeof body.revision_id === 'string' ? body.revision_id : null

  // Если указана ревизия — проверить, что она существует и относится к этой теме
  if (revisionId) {
    const { data: rev } = await supabaseAdmin
      .from('topic_revisions')
      .select('id')
      .eq('id', revisionId)
      .eq('topic_id', id)
      .maybeSingle()
    if (!rev) return NextResponse.json({ error: 'revision_id не найден в этой теме' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('topic_comments')
    .insert({
      topic_id:       id,
      revision_id:    revisionId,
      field_name:     fieldName,
      author_user_id: caller!.id,
      author_name:    caller!.email,
      body:           text,
    })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
