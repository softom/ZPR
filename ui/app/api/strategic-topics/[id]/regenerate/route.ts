/**
 * POST /api/strategic-topics/[id]/regenerate
 *
 * Body: { field: 'title' | 'synopsis' | 'description' | 'threats' | 'solutions' | 'deadlines' }
 *
 * LLM перепишет указанное поле, опираясь на остальные. Дополнительно подтягивает
 * до 3 «эталонных» примеров этого же поля из других недавно обновлённых тем —
 * это служит few-shot anchor'ом для плотности и стиля.
 *
 * Сразу пишет в БД и возвращает обновлённую тему.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  REGEN_FIELDS,
  MIN_EXAMPLE_LENGTH,
  regenerateTopicField,
  type RegenField,
  type TopicSnapshot,
  type FieldExample,
} from '@/lib/strategic-topics/regenerate'

export const maxDuration = 90

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let field: RegenField | null = null
  let formSnapshot: Partial<TopicSnapshot> | null = null
  try {
    const body = await request.json() as { field?: unknown; topic?: unknown }
    if (typeof body.field === 'string' && (REGEN_FIELDS as readonly string[]).includes(body.field)) {
      field = body.field as RegenField
    }
    if (body.topic && typeof body.topic === 'object') {
      formSnapshot = body.topic as Partial<TopicSnapshot>
    }
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON в body' }, { status: 400 })
  }
  if (!field) {
    return NextResponse.json(
      { error: `field обязателен. Допустимые: ${REGEN_FIELDS.join(', ')}` },
      { status: 400 },
    )
  }

  // Загружаем DB-state как fallback (на случай если UI не прислал часть полей).
  const { data: dbTopic, error: loadErr } = await supabaseAdmin
    .from('strategic_topics')
    .select('title, category, synopsis, threats, solutions, deadlines, source_quote, notes')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 })
  if (!dbTopic)  return NextResponse.json({ error: 'Тема не найдена' },   { status: 404 })

  // Источник истины для LLM — то, что в форме у пользователя ПРЯМО СЕЙЧАС.
  // Это критично: если он типизировал текст и нажал ✨ без Save, мы должны
  // получить именно его текущий текст, а не предыдущее DB-значение.
  const topic: TopicSnapshot = {
    title:        firstString(formSnapshot?.title,        dbTopic.title),
    category:     firstString(formSnapshot?.category,     dbTopic.category),
    synopsis:     firstString(formSnapshot?.synopsis,     dbTopic.synopsis),
    threats:      firstString(formSnapshot?.threats,      dbTopic.threats),
    solutions:    firstStringOrNull(formSnapshot?.solutions,    dbTopic.solutions),
    deadlines:    firstStringOrNull(formSnapshot?.deadlines,    dbTopic.deadlines),
    source_quote: firstStringOrNull(formSnapshot?.source_quote, dbTopic.source_quote),
    notes:        firstStringOrNull(formSnapshot?.notes,        dbTopic.notes),
  }

  // Few-shot: последние обновлённые темы, у которых поле непустое и
  // достаточной длины. Исключаем текущую тему. Берём 15 → фильтруем по
  // длине → оставляем 3.
  const examples = await loadExamples(id, field)

  let value: string
  try {
    value = await regenerateTopicField(topic, field, examples)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `LLM: ${msg}` }, { status: 502 })
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('strategic_topics')
    .update({ [field]: value })
    .eq('id', id)
    .select('*')
    .single()
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({
    field,
    value,
    topic: updated,
    examples_used: examples.length,
  })
}

function firstString(...vals: Array<unknown>): string {
  for (const v of vals) {
    if (typeof v === 'string') return v
  }
  return ''
}

function firstStringOrNull(...vals: Array<unknown>): string | null {
  for (const v of vals) {
    if (typeof v === 'string') return v
    if (v === null) return null
  }
  return null
}

async function loadExamples(currentId: string, field: RegenField): Promise<FieldExample[]> {
  const { data, error } = await supabaseAdmin
    .from('strategic_topics')
    .select(`title, category, ${field}`)
    .neq('id', currentId)
    .order('updated_at', { ascending: false })
    .limit(15)

  if (error || !data) return []

  const minLen = MIN_EXAMPLE_LENGTH[field]
  const out: FieldExample[] = []
  for (const row of data as unknown as Array<Record<string, unknown>>) {
    const v = row[field]
    if (typeof v !== 'string') continue
    if (v.length < minLen) continue
    out.push({
      topic_title: String(row.title ?? ''),
      category:    String(row.category ?? ''),
      field_value: v,
    })
    if (out.length >= 3) break
  }
  return out
}
