import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface ConvertPayload {
  title: string
  explanation?: string | null
  assignee_org?: string | null
  priority?: 'high' | 'medium' | 'low'
  due_date?: string | null
  object_ids?: string[]
  quotes?: { speaker_org: string; text: string }[]
}

// POST /api/topics/[id]/convert-to-task
// Body: ConvertPayload — поля, отредактированные пользователем в preview-модалке.
// Действие: атомарный INSERT preliminary task + UPDATE topic.status='removed'
// (выполняется внутри SQL-функции convert_topic_to_task).
// Returns: { task_id: string }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: topicId } = await ctx.params
  const body = await request.json().catch(() => ({} as ConvertPayload))
  if (!body?.title || !body.title.trim()) {
    return NextResponse.json({ error: 'title обязателен' }, { status: 400 })
  }

  const payload = {
    title: body.title.trim(),
    explanation: (body.explanation ?? '').toString(),
    assignee_org: body.assignee_org ?? null,
    priority: body.priority ?? 'medium',
    due_date: body.due_date ?? null,
    object_ids: Array.isArray(body.object_ids) ? body.object_ids : [],
    quotes: Array.isArray(body.quotes) ? body.quotes : [],
  }

  const { data, error } = await supabaseAdmin.rpc('convert_topic_to_task', {
    p_topic_id: topicId,
    p_payload: payload,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ task_id: data })
}
