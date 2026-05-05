import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { callPolzaJson } from '@/lib/llm/polza'

interface RephraseResult {
  title: string
  content: string
  raised_by_org: string | null
  object_ids: string[]
  quotes: { speaker_org: string; text: string }[]
}

// POST /api/tasks/[id]/rephrase-as-topic
// Body: {} (всё читается из БД по id задачи)
// Returns: предложенные поля темы (НЕ персистится — это preview).
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const { data: task, error: taskErr } = await supabaseAdmin
    .from('tasks')
    .select('id, meeting_id, title, explanation, assignee_org, object_ids, quotes')
    .eq('id', id)
    .maybeSingle()
  if (taskErr) return NextResponse.json({ error: taskErr.message }, { status: 500 })
  if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })

  let entities: { id: string; name: string }[] = []
  let objects: { id: string; code: string; current_name: string }[] = []
  let meetingDate: string | null = null
  if (task.meeting_id) {
    const { data: meeting } = await supabaseAdmin
      .from('meetings')
      .select('meeting_date, object_ids')
      .eq('id', task.meeting_id)
      .maybeSingle()
    meetingDate = meeting?.meeting_date ?? null

    const { data: meLE } = await supabaseAdmin
      .from('meeting_legal_entities')
      .select('legal_entity_id')
      .eq('meeting_id', task.meeting_id)
    const entityIds = (meLE ?? []).map((r: { legal_entity_id: string }) => r.legal_entity_id)
    if (entityIds.length > 0) {
      const { data } = await supabaseAdmin
        .from('legal_entities')
        .select('id, name')
        .in('id', entityIds)
      entities = (data as { id: string; name: string }[] | null) ?? []
    }
    if (meeting?.object_ids && meeting.object_ids.length > 0) {
      const { data } = await supabaseAdmin
        .from('objects')
        .select('id, code, current_name')
        .in('id', meeting.object_ids)
      objects = (data as { id: string; code: string; current_name: string }[] | null) ?? []
    }
  }

  const orgsList = entities.map((e) => `- ${e.name}`).join('\n') || '(не указаны)'
  const objectsList = objects.map((o) => `- ${o.code}: ${o.current_name}`).join('\n') || '(не указаны)'

  const systemPrompt = `Ты — ассистент руководителя проекта «Золотые Пески России».
Преобразуй задачу-поручение в пункт обсуждения «Обсудили» (констатацию).
Title — короткий заголовок без глагола в повелительном наклонении.
Content — 1–3 предложения, констатация без слов «надо», «необходимо», «требуется», «нужно», «следует».
raised_by_org — обычно совпадает с assignee_org (организация, поднявшая вопрос); если в контексте намёк на другое юр.лицо — укажи его.
object_ids — копируй из задачи; quotes — тоже копируй.
Верни ТОЛЬКО валидный JSON.`

  const userPrompt = `Контекст собрания:
- Дата: ${meetingDate ?? '(?)'}

Юр.лица собрания (для raised_by_org):
${orgsList}

Объекты собрания:
${objectsList}

Исходная задача:
- title:        ${task.title}
- explanation:  ${task.explanation ?? '(пусто)'}
- assignee_org: ${task.assignee_org ?? '(не указан)'}
- object_ids:   ${JSON.stringify(task.object_ids ?? [])}
- quotes:       ${JSON.stringify(task.quotes ?? [])}

Верни строго следующий JSON:
{
  "title": "короткий заголовок, без глагола",
  "content": "1-3 предложения, констатация",
  "raised_by_org": "имя юр.лица или null",
  "object_ids": ["uuid", ...],
  "quotes": [{"speaker_org": "...", "text": "..."}]
}`

  try {
    const out = await callPolzaJson<Partial<RephraseResult>>(systemPrompt, userPrompt, {
      temperature: 0.2,
      max_tokens: 1200,
    })
    const result: RephraseResult = {
      title: (out.title ?? task.title).toString().trim().slice(0, 200),
      content: (out.content ?? task.explanation ?? task.title).toString().trim(),
      raised_by_org: out.raised_by_org ? out.raised_by_org.toString() : (task.assignee_org ?? null),
      object_ids: Array.isArray(out.object_ids)
        ? out.object_ids.filter((x) => typeof x === 'string')
        : (task.object_ids ?? []),
      quotes: Array.isArray(out.quotes) ? out.quotes : (task.quotes ?? []),
    }
    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
