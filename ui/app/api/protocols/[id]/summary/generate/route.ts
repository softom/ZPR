/**
 * POST /api/protocols/[id]/summary/generate
 *
 * Формирует «Резюме встречи» через LLM (Polza.AI / claude-sonnet-4.6)
 * по утверждённому протоколу. Источник данных тот же, что у /render:
 *  - meetings (метаданные, объекты)
 *  - meeting_topics (status='approved')              — Обсудили
 *  - tasks этого собрания + закрытые в дату собрания — Выполнено
 *  - tasks этого собрания со статусом open/in_progress — К исполнению
 *
 * Промпт построен по обновлённому шаблону резюме (см. 10_Алгоритм_собрания.md
 * шаг 6, актуализированный под новые сущности «Обсудили — Выполнили»).
 *
 * Сразу записывает результат в `meetings.summary_md` — пользователь правит
 * через PATCH /api/protocols/[id]/summary.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { loadResolutions, type ClosureRow } from '@/lib/protocol/loadResolutions'

export const maxDuration = 90

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

function ddmmyyyy(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  if (!POLZA_API_KEY) {
    return NextResponse.json({ error: 'POLZA_API_KEY не задан' }, { status: 500 })
  }

  // Загрузка данных
  const mRes = await supabaseAdmin.from('meetings').select('*').eq('id', id).single()
  if (mRes.error || !mRes.data) {
    return NextResponse.json({ error: mRes.error?.message ?? 'Собрание не найдено' }, { status: 404 })
  }
  const meeting = mRes.data as {
    meeting_date: string
    title: string
    code: string | null
    object_ids: string[]
    status: string
  }
  if (meeting.status !== 'approved' && meeting.status !== 'protocoled') {
    return NextResponse.json(
      { error: 'Резюме доступно только после утверждения протокола' },
      { status: 409 },
    )
  }

  // Раздел «ВЫПОЛНЕНО» теперь строится по новой модели жизненного цикла:
  // окно «от предыдущего собрания до текущего» × per-object закрытия с
  // источником через entity_links(resolved_by). См. lib/protocol/loadResolutions.
  const [topicsRes, tasksRes, objectsRes, resolutions] = await Promise.all([
    supabaseAdmin
      .from('meeting_topics')
      .select('seq,title,content,raised_by_org')
      .eq('meeting_id', id)
      .eq('status', 'approved')
      .order('seq'),
    supabaseAdmin
      .from('tasks')
      .select('id,code,title,explanation,status,assignee_org,due_date,object_ids,done_note')
      .eq('meeting_id', id)
      .order('code'),
    supabaseAdmin.from('objects').select('id,code,current_name'),
    loadResolutions({
      meetingId: id,
      meetingDate: meeting.meeting_date,
      objectIds: meeting.object_ids ?? [],
    }),
  ])

  const objectsById = new Map<string, string>()
  for (const o of (objectsRes.data ?? []) as Array<{ id: string; current_name: string }>) {
    objectsById.set(o.id, o.current_name)
  }
  const objectsLine =
    (meeting.object_ids?.length ?? 0) > 0
      ? meeting.object_ids.map((oid) => objectsById.get(oid) ?? oid.slice(0, 8)).join(', ')
      : '—'

  const topics = (topicsRes.data ?? []) as Array<{
    title: string
    content: string
    raised_by_org: string | null
  }>
  type TaskRow = {
    id: string
    title: string
    explanation: string | null
    status: string
    assignee_org: string | null
    due_date: string | null
    done_note: string | null
  }
  const tasks = (tasksRes.data ?? []) as TaskRow[]

  // Все закрытия в окне (с источником по entity_links).
  // Уникальные task_id (одна задача могла закрыться по нескольким объектам).
  const closures: ClosureRow[] = resolutions.closures
  const closedTaskIds = new Set(closures.map((c) => c.task_id))

  // Подгружаем мета задач, которые закрылись в окне но НЕ принадлежат
  // текущему собранию (legacy «закрытия задач прошлых собраний»).
  const externalClosedIds = [...closedTaskIds].filter(
    (taskId) => !tasks.some((t) => t.id === taskId),
  )
  let externalTasks: TaskRow[] = []
  if (externalClosedIds.length > 0) {
    const ext = await supabaseAdmin
      .from('tasks')
      .select('id,code,title,explanation,status,assignee_org,due_date,done_note')
      .in('id', externalClosedIds)
    externalTasks = ((ext.data ?? []) as TaskRow[])
  }

  // Объединяем для удобства lookup'а
  const taskById = new Map<string, TaskRow>()
  for (const t of tasks) taskById.set(t.id, t)
  for (const t of externalTasks) taskById.set(t.id, t)

  // Группируем закрытия по источнику (для prompt'а LLM)
  type DoneItem = {
    task: TaskRow
    source: ClosureRow['source']
    source_title: string | null
    source_date: string | null
    done_note: string | null
  }
  const doneItems: DoneItem[] = []
  const seenTaskPerSource = new Set<string>()  // task × source — чтобы не дублировать одну задачу 4 раза если она закрылась на 4 объектах одним источником
  for (const c of closures) {
    const t = taskById.get(c.task_id)
    if (!t) continue
    const key = `${c.task_id}|${c.source}`
    if (seenTaskPerSource.has(key)) continue
    seenTaskPerSource.add(key)
    doneItems.push({
      task: t,
      source: c.source,
      source_title: c.source_title,
      source_date: c.source_date,
      done_note: c.done_note,
    })
  }

  // Открытые задачи этого собрания — без изменений
  const open = tasks.filter(
    (t) => !closedTaskIds.has(t.id) && t.status !== 'done' && t.status !== 'closed' && t.status !== 'cancelled',
  )

  // Промпт LLM. doneItems сгруппированы по источнику закрытия:
  // on_meeting / reported / by_document / by_letter / by_other / unsourced.
  const prompt = buildPrompt({
    code: meeting.code,
    dateLabel: ddmmyyyy(meeting.meeting_date),
    title: meeting.title,
    objectsLine,
    topics,
    doneItems,
    open,
    windowStart: resolutions.window_start,
    prevMeetingDate: resolutions.prev_meeting_date,
  })

  // LLM вызов
  let summaryMd: string
  try {
    summaryMd = await callLLM(prompt)
  } catch (e) {
    return NextResponse.json({ error: `LLM: ${(e as Error).message}` }, { status: 500 })
  }

  // Сохранение в БД
  const upd = await supabaseAdmin
    .from('meetings')
    .update({ summary_md: summaryMd })
    .eq('id', id)
  if (upd.error) {
    return NextResponse.json({ error: upd.error.message }, { status: 500 })
  }

  return NextResponse.json({ summary_md: summaryMd })
}

type DoneItemForPrompt = {
  task: { title: string; explanation: string | null; assignee_org?: string | null }
  source: ClosureRow['source']
  source_title: string | null
  source_date: string | null
  done_note: string | null
}

const SOURCE_LABEL: Record<ClosureRow['source'], string> = {
  on_meeting:  'Закрыто на этом собрании',
  reported:    'Отчитано исполнителем до собрания',
  by_document: 'Подтверждено документом',
  by_letter:   'Закрыто по переписке',
  by_other:    'Закрыто (иной источник)',
  unsourced:   'Закрыто без явного источника (legacy)',
}

function buildPrompt(args: {
  code: string | null
  dateLabel: string
  title: string
  objectsLine: string
  topics: Array<{ title: string; content: string; raised_by_org: string | null }>
  doneItems: DoneItemForPrompt[]
  open: Array<{
    title: string
    explanation: string | null
    assignee_org: string | null
    due_date: string | null
  }>
  windowStart: string
  prevMeetingDate: string | null
}): string {
  const topicsBlock =
    args.topics.length > 0
      ? args.topics
          .map((t, i) => {
            const raised = t.raised_by_org ? ` (поднял: ${t.raised_by_org})` : ''
            return `${i + 1}. ${t.title}${raised}\n   ${(t.content || '').replace(/\n/g, ' ')}`
          })
          .join('\n')
      : '— нет —'

  // ВЫПОЛНЕНО — группируем по source
  const groups: Array<{ key: ClosureRow['source']; items: DoneItemForPrompt[] }> = []
  const sourceOrder: ClosureRow['source'][] = ['on_meeting', 'reported', 'by_document', 'by_letter', 'by_other', 'unsourced']
  for (const k of sourceOrder) {
    const items = args.doneItems.filter((d) => d.source === k)
    if (items.length > 0) groups.push({ key: k, items })
  }

  const doneBlock = groups.length === 0
    ? '— нет —'
    : groups.map((g) => {
        const head = `[${SOURCE_LABEL[g.key]}]`
        const body = g.items.map((d, i) => {
          const src = d.source_title ? ` — источник: ${d.source_title}${d.source_date ? ` от ${d.source_date}` : ''}` : ''
          const note = d.done_note ? ` [подтверждение: ${d.done_note}]` : ''
          return `${i + 1}. ${d.task.title}${src}${note}\n   ${(d.task.explanation || '').replace(/\n/g, ' ')}`
        }).join('\n')
        return `${head}\n${body}`
      }).join('\n\n')

  const openBlock =
    args.open.length > 0
      ? args.open
          .map((t, i) => {
            const due = t.due_date ? ` (до ${t.due_date})` : ''
            const ass = t.assignee_org ? ` [отв: ${t.assignee_org}]` : ''
            return `${i + 1}. ${t.title}${ass}${due}\n   ${(t.explanation || '').replace(/\n/g, ' ')}`
          })
          .join('\n')
      : '— нет —'

  return `Ты — помощник руководителя строительного проекта «Золотые пески России».
Сформируй РЕЗЮМЕ рабочего собрания в строгом MD-формате (см. ниже).

ИСХОДНЫЕ ДАННЫЕ:

Дата собрания: ${args.dateLabel}
Код: ${args.code ?? '—'}
Объекты: ${args.objectsLine}
Тема: ${args.title}

ОБСУДИЛИ (темы без задач):
${topicsBlock}

ВЫПОЛНЕНО — все закрытия с ${args.prevMeetingDate ? `предыдущего собрания (${args.prevMeetingDate})` : `${args.windowStart}`} до сегодня, по объектам собрания, СГРУППИРОВАННЫЕ ПО ИСТОЧНИКУ:
${doneBlock}

К ИСПОЛНЕНИЮ (открытые задачи этого собрания):
${openBlock}

ТРЕБОВАНИЯ К РЕЗЮМЕ:

1. Верни **только** Markdown без преамбулы и без обёрток код-фенсов.
2. Структура — ровно эти разделы в этом порядке:

# Резюме рабочего собрания ${args.dateLabel}

**Объекты:** ${args.objectsLine}
**Предмет:** ${args.title}

## Ключевые решения
- 2–4 пункта. Каждое — одно короткое утверждение, что именно решено/согласовано.
  Источник: «Выполнено» + любые явные решения из «Обсудили».

## Обсудили
- По одному bullet на каждую тему из «Обсудили». Краткая суть (одно предложение).
  Если темы пусты — раздел опускается полностью.

## Выполнено
- Сгруппируй закрытия по тем же категориям источника, что в исходных данных
  (заголовок группы выделяй жирным). Внутри группы — по одному bullet на пункт:
  «Что сделано — источник (если есть)».
- Группы пустыми пропускай.
- Если ВСЕХ закрытий нет — пиши «— за период между собраниями ничего не закрывалось».

## К исполнению
- По одному bullet на каждую открытую задачу: «Задача — отв (срок DD.MM.YYYY)».
  Если ответственный не задан — пропусти. Если срок не задан — без скобок.
  Если открытых нет — пиши «— открытых задач нет».

## Основной риск
- Одно предложение: где главная угроза срыва (просрочка, ключевое решение, блокер).
  Если рисков нет — «Существенных рисков не выявлено.»

3. Не повторяй формулировки задач дословно — обобщай.
4. Не упоминай «код задачи», «meeting_id» и прочие внутренние идентификаторы.
5. Деловой нейтральный тон. Без эмоций, без оценочных слов.

Верни ТОЛЬКО Markdown по шаблону выше.`
}

async function callLLM(prompt: string): Promise<string> {
  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err.slice(0, 300)}`)
  }
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? ''
  // Снимаем возможные markdown-обёртки fence
  let s = content.trim()
  s = s.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  return s.trim()
}
