/**
 * POST /api/strategic-topics/[id]/check-document
 *
 * Body: {
 *   document_text: string,
 *   topic?: { seq, title, category, synopsis, threats, solutions, deadlines }
 *           — состояние формы, если оператор не сохранил последние правки.
 * }
 *
 * LLM сопоставляет тему и текст документа, возвращает три списка:
 *   - in_topic   — что уже учтено в теме
 *   - missing    — что есть в документе, но не учтено
 *   - off_topic  — что не относится к теме
 *
 * Не пишет в БД. Чисто read-only анализ.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  checkTopicAgainstDocument,
  type TopicForCheck,
} from '@/lib/strategic-topics/checkDocument'

export const maxDuration = 90

const MAX_DOC_CHARS = 60_000

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let documentText = ''
  let formSnapshot: Partial<TopicForCheck> | null = null
  try {
    const body = await request.json() as { document_text?: unknown; topic?: unknown }
    if (typeof body.document_text === 'string') documentText = body.document_text.trim()
    if (body.topic && typeof body.topic === 'object') {
      formSnapshot = body.topic as Partial<TopicForCheck>
    }
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON в body' }, { status: 400 })
  }

  if (!documentText) {
    return NextResponse.json({ error: 'document_text обязателен' }, { status: 400 })
  }
  if (documentText.length > MAX_DOC_CHARS) {
    return NextResponse.json(
      { error: `Текст документа слишком длинный (${documentText.length} символов). Лимит: ${MAX_DOC_CHARS}. Сократите или разбейте на части.` },
      { status: 413 },
    )
  }

  // DB-state как fallback на поля, которые UI не прислал (например, при
  // первом открытии модалки до правок).
  const { data: dbTopic, error: loadErr } = await supabaseAdmin
    .from('strategic_topics')
    .select('seq, title, category, synopsis, threats, solutions, deadlines')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 })
  if (!dbTopic)  return NextResponse.json({ error: 'Тема не найдена' },   { status: 404 })

  const topic: TopicForCheck = {
    seq:       Number(formSnapshot?.seq ?? dbTopic.seq),
    title:     String(formSnapshot?.title ?? dbTopic.title),
    category:  String(formSnapshot?.category ?? dbTopic.category),
    synopsis:  String(formSnapshot?.synopsis ?? dbTopic.synopsis),
    threats:   String(formSnapshot?.threats ?? dbTopic.threats),
    solutions: typeof formSnapshot?.solutions === 'string' ? formSnapshot.solutions : (dbTopic.solutions ?? null),
    deadlines: typeof formSnapshot?.deadlines === 'string' ? formSnapshot.deadlines : (dbTopic.deadlines ?? null),
  }

  try {
    const result = await checkTopicAgainstDocument(topic, documentText)
    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `LLM: ${msg}` }, { status: 502 })
  }
}
