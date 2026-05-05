import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { callPolzaJson } from '@/lib/llm/polza'

// POST /api/tasks/[id]/regenerate-title
// Body: { explanation: string, assignee_org?: string | null }
// Returns: { title: string }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const body = await request.json().catch(() => ({} as { explanation?: string; assignee_org?: string | null }))
  const explanation = (body?.explanation ?? '').toString().trim()
  if (!explanation) {
    return NextResponse.json({ error: 'explanation обязательно' }, { status: 400 })
  }

  const { data: task, error: taskErr } = await supabaseAdmin
    .from('tasks')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (taskErr) return NextResponse.json({ error: taskErr.message }, { status: 500 })
  if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })

  const assignee = (body?.assignee_org ?? '').toString().trim() || null

  const systemPrompt = `Ты — ассистент руководителя проекта «Золотые Пески России».
Сформулируй короткий заголовок-действие для задачи (поручения).
Заголовок начинается с глагола в неопределённой форме («Подготовить», «Направить», «Согласовать», «Доработать», «Проверить»).
До 70 символов. Без точки в конце. Без markdown.
Верни строго JSON: {"title": "..."}.`

  const userPrompt = `Описание задачи:
"""
${explanation}
"""

Ответственный: ${assignee ?? '(не указан)'}.

Верни {"title": "..."}.`

  try {
    const out = await callPolzaJson<{ title?: string }>(systemPrompt, userPrompt, {
      temperature: 0.2,
      max_tokens: 200,
    })
    const title = (out.title ?? '').trim().slice(0, 200)
    if (!title) {
      return NextResponse.json({ error: 'LLM вернула пустой title' }, { status: 502 })
    }
    return NextResponse.json({ title })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
