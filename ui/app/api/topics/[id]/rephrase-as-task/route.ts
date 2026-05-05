import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { callPolzaJson } from '@/lib/llm/polza'

interface RephraseResult {
  title: string
  explanation: string
  assignee_org: string | null
  priority: 'high' | 'medium' | 'low'
  due_date: string | null  // YYYY-MM-DD or null
  object_ids: string[]      // UUID
  quotes: { speaker_org: string; text: string }[]
}

// POST /api/topics/[id]/rephrase-as-task
// Body: {} (всё читается из БД по id темы)
// Returns: предложенные поля задачи (НЕ персистится — это preview).
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  // 1. Тема
  const { data: topic, error: topicErr } = await supabaseAdmin
    .from('meeting_topics')
    .select('id, meeting_id, title, content, raised_by_org, object_ids, quotes')
    .eq('id', id)
    .maybeSingle()
  if (topicErr) return NextResponse.json({ error: topicErr.message }, { status: 500 })
  if (!topic) return NextResponse.json({ error: 'Тема не найдена' }, { status: 404 })

  // 2. Контекст собрания: юр.лица + объекты
  const { data: meeting } = await supabaseAdmin
    .from('meetings')
    .select('meeting_date, title, object_ids')
    .eq('id', topic.meeting_id)
    .maybeSingle()

  const { data: meLE } = await supabaseAdmin
    .from('meeting_legal_entities')
    .select('legal_entity_id')
    .eq('meeting_id', topic.meeting_id)
  const entityIds = (meLE ?? []).map((r: { legal_entity_id: string }) => r.legal_entity_id)
  let entities: { id: string; name: string }[] = []
  if (entityIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('legal_entities')
      .select('id, name')
      .in('id', entityIds)
    entities = (data as { id: string; name: string }[] | null) ?? []
  }

  let objects: { id: string; code: string; current_name: string }[] = []
  if (meeting?.object_ids && meeting.object_ids.length > 0) {
    const { data } = await supabaseAdmin
      .from('objects')
      .select('id, code, current_name')
      .in('id', meeting.object_ids)
    objects = (data as { id: string; code: string; current_name: string }[] | null) ?? []
  }

  const orgsList = entities.map((e) => `- ${e.name}`).join('\n') || '(не указаны)'
  const objectsList = objects.map((o) => `- ${o.code}: ${o.current_name}`).join('\n') || '(не указаны)'
  const objectIdsList = objects.map((o) => o.id).join(', ') || '(пусто)'

  const systemPrompt = `Ты — ассистент руководителя проекта «Золотые Пески России».
Преобразуй пункт обсуждения «Обсудили» (констатацию) в задачу-поручение.
Сформулируй чёткий title с глагола («Подготовить», «Направить», «Согласовать», «Доработать», «Проверить») до 70 символов.
explanation — 1–2 предложения, раскрывающих суть.
assignee_org — точное имя одного из юр.лиц собрания, если можно вывести из контекста; иначе null.
priority — high|medium|low (по умолчанию medium, если ничего не указывает на срочность).
due_date — YYYY-MM-DD или null.
object_ids — массив UUID объектов; копируй из объектов темы или предложи подмножество, если из контекста ясно.
quotes — копируй цитаты темы как есть.
Верни ТОЛЬКО валидный JSON.`

  const userPrompt = `Контекст собрания:
- Дата: ${meeting?.meeting_date ?? '(?)'}
- Название: ${meeting?.title ?? '(?)'}

Юр.лица собрания (используй точные имена для assignee_org или null):
${orgsList}

Объекты собрания (используй UUID из этого списка для object_ids: ${objectIdsList}):
${objectsList}

Исходная тема:
- title:    ${topic.title}
- content:  ${topic.content}
- raised_by_org: ${topic.raised_by_org ?? '(не указано)'}
- object_ids: ${JSON.stringify(topic.object_ids ?? [])}
- quotes:    ${JSON.stringify(topic.quotes ?? [])}

Верни строго следующий JSON:
{
  "title": "до 70 символов, начать с глагола",
  "explanation": "1-2 предложения",
  "assignee_org": "точное имя юр.лица или null",
  "priority": "high|medium|low",
  "due_date": "YYYY-MM-DD или null",
  "object_ids": ["uuid", ...],
  "quotes": [{"speaker_org": "...", "text": "..."}]
}`

  try {
    const out = await callPolzaJson<Partial<RephraseResult>>(systemPrompt, userPrompt, {
      temperature: 0.2,
      max_tokens: 1200,
    })
    const result: RephraseResult = {
      title: (out.title ?? topic.title).toString().trim().slice(0, 200),
      explanation: (out.explanation ?? topic.content).toString().trim(),
      assignee_org: out.assignee_org ? out.assignee_org.toString() : null,
      priority: (['high', 'medium', 'low'] as const).includes(out.priority as 'high' | 'medium' | 'low')
        ? (out.priority as 'high' | 'medium' | 'low')
        : 'medium',
      due_date: out.due_date && /^\d{4}-\d{2}-\d{2}$/.test(out.due_date) ? out.due_date : null,
      object_ids: Array.isArray(out.object_ids) ? out.object_ids.filter((x) => typeof x === 'string') : (topic.object_ids ?? []),
      quotes: Array.isArray(out.quotes) ? out.quotes : (topic.quotes ?? []),
    }
    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
