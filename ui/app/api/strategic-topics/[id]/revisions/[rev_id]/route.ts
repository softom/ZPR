/**
 * /api/strategic-topics/[id]/revisions/[rev_id]
 *
 * GET    — одна ревизия (draft видит автор/админ).
 * PATCH  — переход состояний и/или правка proposed_*:
 *          - status='draft' автор может править поля (proposed_*) и сменить
 *            на 'pending_review' (отправить на review). Также может откатить
 *            draft → draft (просто обновление).
 *          - admin может: approve | reject | changes_requested.
 *            При approve — proposed_* копируется в strategic_topics, ревизия
 *            помечается approved.
 * DELETE — автор может удалить свой draft; админ — любую ревизию.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getCaller, isAdmin } from '@/lib/auth-caller'

type Revision = {
  id: string
  topic_id: string
  author_user_id: string | null
  status: string
  proposed_seq: number | null
  proposed_title: string | null
  proposed_category: string | null
  proposed_synopsis: string | null
  proposed_threats: string | null
  proposed_solutions: string | null
  proposed_deadlines: string | null
  base_snapshot: Record<string, unknown> | null
  review_comment: string | null
  reviewer_user_id: string | null
  reviewed_at: string | null
  submitted_at: string | null
  created_at: string
  updated_at: string
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; rev_id: string }> },
) {
  const { id, rev_id } = await params
  const caller = await getCaller(req)

  const { data: rev, error } = await supabaseAdmin
    .from('topic_revisions')
    .select('*')
    .eq('id', rev_id)
    .eq('topic_id', id)
    .maybeSingle<Revision>()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rev)  return NextResponse.json({ error: 'Ревизия не найдена' }, { status: 404 })

  // draft — только автор и админ
  if (rev.status === 'draft' && !isAdmin(caller) && rev.author_user_id !== caller?.id) {
    return NextResponse.json({ error: 'Ревизия не найдена' }, { status: 404 })
  }

  return NextResponse.json(rev)
}

const FIELD_KEYS = [
  'proposed_seq', 'proposed_title', 'proposed_category',
  'proposed_synopsis', 'proposed_threats', 'proposed_solutions', 'proposed_deadlines',
] as const

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; rev_id: string }> },
) {
  const { id, rev_id } = await params
  const caller = await getCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const { data: rev, error: getErr } = await supabaseAdmin
    .from('topic_revisions')
    .select('*')
    .eq('id', rev_id)
    .eq('topic_id', id)
    .maybeSingle<Revision>()
  if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 })
  if (!rev)   return NextResponse.json({ error: 'Ревизия не найдена' }, { status: 404 })

  const requestedStatus = typeof body.status === 'string' ? body.status : undefined
  const isAuthor = rev.author_user_id === caller.id
  const admin = isAdmin(caller)

  // ─── Сценарий 1: автор правит свой draft ────────────────────────────
  if (rev.status === 'draft' && isAuthor && (requestedStatus === undefined || requestedStatus === 'draft' || requestedStatus === 'pending_review')) {
    const update: Record<string, unknown> = {}
    for (const k of FIELD_KEYS) {
      if (k in body) {
        const v = body[k]
        if (k === 'proposed_seq') {
          const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN
          if (Number.isInteger(n) && n >= 1 && n <= 999) update.proposed_seq = n
          else if (v === null) update.proposed_seq = null
        } else if (typeof v === 'string') {
          const trimmed = v.trim()
          update[k] = trimmed === '' ? null : trimmed
        } else if (v === null) {
          update[k] = null
        }
      }
    }
    if (requestedStatus === 'pending_review') {
      update.status = 'pending_review'
      update.submitted_at = new Date().toISOString()
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    }
    const { data, error } = await supabaseAdmin
      .from('topic_revisions')
      .update(update)
      .eq('id', rev_id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }

  // ─── Сценарий 2: админ принимает / отклоняет / запрашивает изменения ──
  if (admin && requestedStatus && ['approved', 'rejected', 'changes_requested'].includes(requestedStatus)) {
    if (rev.status !== 'pending_review' && rev.status !== 'changes_requested') {
      return NextResponse.json({ error: `Из статуса ${rev.status} нельзя переходить в ${requestedStatus}` }, { status: 400 })
    }
    const reviewComment = typeof body.review_comment === 'string' ? body.review_comment.trim() : null
    if ((requestedStatus === 'rejected' || requestedStatus === 'changes_requested') && !reviewComment) {
      return NextResponse.json({ error: 'review_comment обязателен при rejected/changes_requested' }, { status: 400 })
    }

    // При approve — применяем proposed_* к strategic_topics
    if (requestedStatus === 'approved') {
      const topicUpdate: Record<string, unknown> = {}
      if (rev.proposed_seq        !== null) topicUpdate.seq        = rev.proposed_seq
      if (rev.proposed_title      !== null) topicUpdate.title      = rev.proposed_title
      if (rev.proposed_category   !== null) topicUpdate.category   = rev.proposed_category
      if (rev.proposed_synopsis   !== null) topicUpdate.synopsis   = rev.proposed_synopsis
      if (rev.proposed_threats    !== null) topicUpdate.threats    = rev.proposed_threats
      if (rev.proposed_solutions  !== null) topicUpdate.solutions  = rev.proposed_solutions
      if (rev.proposed_deadlines  !== null) topicUpdate.deadlines  = rev.proposed_deadlines

      if (Object.keys(topicUpdate).length > 0) {
        const { error: applyErr } = await supabaseAdmin
          .from('strategic_topics')
          .update(topicUpdate)
          .eq('id', id)
        if (applyErr) return NextResponse.json({ error: `Применение к теме: ${applyErr.message}` }, { status: 500 })
      }
    }

    const { data, error } = await supabaseAdmin
      .from('topic_revisions')
      .update({
        status:           requestedStatus,
        review_comment:   reviewComment,
        reviewer_user_id: caller.id,
        reviewed_at:      new Date().toISOString(),
      })
      .eq('id', rev_id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }

  // ─── Сценарий 3: автор делает changes_requested → draft (возвращает в работу) ──
  if (rev.status === 'changes_requested' && isAuthor && requestedStatus === 'draft') {
    const { data, error } = await supabaseAdmin
      .from('topic_revisions')
      .update({ status: 'draft', reviewed_at: null, reviewer_user_id: null })
      .eq('id', rev_id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }

  return NextResponse.json({ error: 'Действие не разрешено для вашей роли и состояния ревизии' }, { status: 403 })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; rev_id: string }> },
) {
  const { id, rev_id } = await params
  const caller = await getCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 })
  }

  const { data: rev, error: getErr } = await supabaseAdmin
    .from('topic_revisions')
    .select('id, status, author_user_id, topic_id')
    .eq('id', rev_id)
    .eq('topic_id', id)
    .maybeSingle<Pick<Revision, 'id' | 'status' | 'author_user_id' | 'topic_id'>>()
  if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 })
  if (!rev)   return NextResponse.json({ error: 'Ревизия не найдена' }, { status: 404 })

  const isAuthor = rev.author_user_id === caller.id
  if (!(isAdmin(caller) || (rev.status === 'draft' && isAuthor))) {
    return NextResponse.json({ error: 'Удалить ревизию может только автор draft-а или админ' }, { status: 403 })
  }

  const { error } = await supabaseAdmin
    .from('topic_revisions')
    .delete()
    .eq('id', rev_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
