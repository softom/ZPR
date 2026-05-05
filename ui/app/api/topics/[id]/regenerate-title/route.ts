import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { callPolzaJson } from '@/lib/llm/polza'

// POST /api/topics/[id]/regenerate-title
// Body: { content: string, raised_by_org?: string | null }
// Returns: { title: string }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const body = await request.json().catch(() => ({} as { content?: string; raised_by_org?: string | null }))
  const content = (body?.content ?? '').toString().trim()
  if (!content) {
    return NextResponse.json({ error: 'content обязателен' }, { status: 400 })
  }

  // Проверяем существование темы (id-based access control делегируется Supabase RLS;
  // здесь мы лишь убеждаемся, что не палим LLM на несуществующий ресурс)
  const { data: topic, error: topicErr } = await supabaseAdmin
    .from('meeting_topics')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (topicErr) return NextResponse.json({ error: topicErr.message }, { status: 500 })
  if (!topic) return NextResponse.json({ error: 'Тема не найдена' }, { status: 404 })

  const raisedBy = (body?.raised_by_org ?? '').toString().trim() || null

  const systemPrompt = `Ты — ассистент руководителя проекта «Золотые Пески России».
Сформулируй короткий заголовок для пункта обсуждения «Обсудили».
Заголовок — констатация темы без поручения, без глагола в повелительном наклонении.
До 70 символов. Без точки в конце. Без markdown.
Верни строго JSON: {"title": "..."}.`

  const userPrompt = `Текст обсуждения:
"""
${content}
"""

Поднявшая организация: ${raisedBy ?? '(не указано)'}.

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
