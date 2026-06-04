/**
 * /api/strategic-topics/[id]/revisions
 *
 * GET  — список ревизий темы (draft видит только автор; остальные статусы — все).
 * POST — создание новой ревизии:
 *        body: {
 *          status?: 'draft' | 'pending_review',  // default 'draft'
 *          proposed_seq, proposed_title, proposed_category,
 *          proposed_synopsis, proposed_threats, proposed_solutions, proposed_deadlines
 *          (поля, которые автор хочет изменить; NULL/отсутствие = не меняется)
 *        }
 *        Сервер делает snapshot текущей темы в base_snapshot.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getCaller, isUploader, isAdmin } from '@/lib/auth-caller'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caller = await getCaller(req)

  let query = supabaseAdmin
    .from('topic_revisions')
    .select('*')
    .eq('topic_id', id)
    .order('created_at', { ascending: false })

  // Фильтрация draft-ов: их видит только автор и админ
  if (!isAdmin(caller)) {
    if (caller) {
      query = query.or(`status.neq.draft,author_user_id.eq.${caller.id}`)
    } else {
      query = query.neq('status', 'draft')
    }
  }

  const { data, error } = await query
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
    return NextResponse.json({ error: 'Только uploader/admin может создавать правки' }, { status: 403 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  // Snapshot текущей темы
  const { data: topic, error: topicErr } = await supabaseAdmin
    .from('strategic_topics')
    .select('seq, title, category, synopsis, threats, solutions, deadlines')
    .eq('id', id)
    .maybeSingle()
  if (topicErr) return NextResponse.json({ error: topicErr.message }, { status: 500 })
  if (!topic)   return NextResponse.json({ error: 'Тема не найдена' }, { status: 404 })

  // Статус: только draft или pending_review при создании
  const requestedStatus = typeof body.status === 'string' ? body.status : 'draft'
  if (requestedStatus !== 'draft' && requestedStatus !== 'pending_review') {
    return NextResponse.json({ error: 'status может быть только draft или pending_review при создании' }, { status: 400 })
  }

  const proposed = pickProposedFields(body)

  // Хотя бы одно proposed_* поле должно отличаться от текущего значения темы
  const hasAnyChange = Object.entries(proposed).some(([k, v]) => {
    if (v === null || v === undefined) return false
    const baseKey = k.replace(/^proposed_/, '') as keyof typeof topic
    return v !== topic[baseKey]
  })
  if (!hasAnyChange) {
    return NextResponse.json({ error: 'Ни одно поле не отличается от текущей темы — нечего предлагать' }, { status: 400 })
  }

  const insert = {
    topic_id:       id,
    author_user_id: caller!.id,
    status:         requestedStatus,
    base_snapshot:  topic,
    submitted_at:   requestedStatus === 'pending_review' ? new Date().toISOString() : null,
    ...proposed,
  }

  const { data, error } = await supabaseAdmin
    .from('topic_revisions')
    .insert(insert)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data, { status: 201 })
}

function pickProposedFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('proposed_seq' in body) {
    const n = typeof body.proposed_seq === 'number' ? body.proposed_seq
            : typeof body.proposed_seq === 'string' ? parseInt(body.proposed_seq, 10) : NaN
    if (Number.isInteger(n) && n >= 1 && n <= 999) out.proposed_seq = n
  }
  for (const k of ['proposed_title', 'proposed_category', 'proposed_synopsis', 'proposed_threats', 'proposed_solutions', 'proposed_deadlines']) {
    if (k in body) {
      const v = body[k]
      if (typeof v === 'string') {
        const trimmed = v.trim()
        out[k] = trimmed === '' ? null : trimmed
      } else if (v === null) {
        out[k] = null
      }
    }
  }
  return out
}
