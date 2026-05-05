import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface ConvertPayload {
  title: string
  content?: string | null
  raised_by_org?: string | null
  object_ids?: string[]
  quotes?: { speaker_org: string; text: string }[]
  discussion_date?: string | null  // YYYY-MM-DD
}

// POST /api/tasks/[id]/convert-to-topic
// Body: ConvertPayload — поля, отредактированные пользователем в preview-модалке.
// Действие: атомарный INSERT preliminary meeting_topic + DELETE task
// (выполняется внутри SQL-функции convert_task_to_topic).
// Returns: { topic_id: string }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await ctx.params
  const body = await request.json().catch(() => ({} as ConvertPayload))
  if (!body?.title || !body.title.trim()) {
    return NextResponse.json({ error: 'title обязателен' }, { status: 400 })
  }

  const payload = {
    title: body.title.trim(),
    content: (body.content ?? '').toString(),
    raised_by_org: body.raised_by_org ?? null,
    object_ids: Array.isArray(body.object_ids) ? body.object_ids : [],
    quotes: Array.isArray(body.quotes) ? body.quotes : [],
    discussion_date: body.discussion_date ?? null,
  }

  const { data, error } = await supabaseAdmin.rpc('convert_task_to_topic', {
    p_task_id: taskId,
    p_payload: payload,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ topic_id: data })
}
