/**
 * GET /api/protocols/[id]/render?format=md|docx
 *
 * Рендерит протокол собрания. format=md — markdown с теми же таблицами
 * что в существующих `ПРОТ-*.md`. format=docx — Word через npm `docx`
 * (см. lib/protocol/generateDocx.ts).
 *
 * Доступен после `meeting.status='approved'`.
 *
 * Source: meetings + meeting_legal_entities + meeting_participants + contacts
 *         + meeting_topics (status='approved') + tasks (статусы done/closed/open).
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { loadResolutions } from '@/lib/protocol/loadResolutions'
import { generateProtocolDocx } from '@/lib/protocol/generateDocx'
import { generateSummaryDocx } from '@/lib/protocol/generateSummaryDocx'

function ddmmyyyy(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const url = new URL(request.url)
  const format = url.searchParams.get('format') ?? 'md'

  if (!['md', 'docx', 'summary-docx'].includes(format)) {
    return NextResponse.json(
      { error: 'Поддерживаются format=md|docx|summary-docx' },
      { status: 400 },
    )
  }

  if (format === 'summary-docx') {
    const st = await supabaseAdmin
      .from('meetings')
      .select('code, meeting_date, summary_md')
      .eq('id', id)
      .single()
    if (st.error || !st.data) {
      return NextResponse.json({ error: st.error?.message ?? 'Собрание не найдено' }, { status: 404 })
    }
    if (!st.data.summary_md) {
      return NextResponse.json(
        { error: 'Резюме не сформировано. Нажмите «Сформировать резюме» в Секции 10.' },
        { status: 409 },
      )
    }
    try {
      const buf = await generateSummaryDocx(id)
      const filename = `${st.data.code ?? `ПРОТ-${st.data.meeting_date}`}-Резюме.docx`
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      })
    } catch (e) {
      return NextResponse.json(
        { error: `Ошибка генерации резюме: ${(e as Error).message}` },
        { status: 500 },
      )
    }
  }

  if (format === 'docx') {
    // Проверяем статус через лёгкий запрос
    const st = await supabaseAdmin
      .from('meetings')
      .select('status, code, meeting_date')
      .eq('id', id)
      .single()
    if (st.error || !st.data) {
      return NextResponse.json({ error: st.error?.message ?? 'Собрание не найдено' }, { status: 404 })
    }
    if (st.data.status !== 'approved' && st.data.status !== 'protocoled') {
      return NextResponse.json(
        { error: 'Протокол не утверждён. Сначала пройдите Секцию 8 «Утверждение».' },
        { status: 409 },
      )
    }
    try {
      const buf = await generateProtocolDocx(id)
      const filename = `${st.data.code ?? `ПРОТ-${st.data.meeting_date}`}.docx`
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      })
    } catch (e) {
      return NextResponse.json(
        { error: `Ошибка генерации .docx: ${(e as Error).message}` },
        { status: 500 },
      )
    }
  }

  // Сначала загружаем meeting (чтобы знать дату/объекты для второго запроса)
  const mRes = await supabaseAdmin.from('meetings').select('*').eq('id', id).single()
  if (mRes.error || !mRes.data) {
    return NextResponse.json({ error: mRes.error?.message ?? 'Собрание не найдено' }, { status: 404 })
  }
  const meeting = mRes.data as {
    meeting_date: string
    title: string
    object_ids: string[]
    status: string
    code: string | null
  }

  // Раздел «ПРИНЯЛИ КАК РЕШЁННЫЕ» — теперь по новой модели жизненного цикла:
  // окно от предыдущего собрания + per-object закрытия с источником.
  // См. lib/protocol/loadResolutions и WIKI 19_Сущность_Задача «v2.4».
  const [leRes, partsRes, topicsRes, tasksRes, objectsRes, resolutions] = await Promise.all([
    supabaseAdmin
      .from('meeting_legal_entities')
      .select('legal_entity_id, seq, legal_entities(id,name)')
      .eq('meeting_id', id)
      .order('seq', { ascending: true, nullsFirst: false }),
    supabaseAdmin
      .from('meeting_participants')
      .select(
        'contact_id, contacts(last_name,first_name,middle_name,job_title,legal_entity_id)',
      )
      .eq('meeting_id', id),
    supabaseAdmin
      .from('meeting_topics')
      .select('seq,title,content,raised_by_org,status')
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

  if (meeting.status !== 'approved' && meeting.status !== 'protocoled') {
    return NextResponse.json(
      { error: 'Протокол не утверждён. Сначала пройдите Секцию 8 «Утверждение».' },
      { status: 409 },
    )
  }

  const objectsById = new Map<string, { code: string; current_name: string }>()
  for (const o of (objectsRes.data ?? []) as Array<{
    id: string
    code: string
    current_name: string
  }>) {
    objectsById.set(o.id, { code: o.code, current_name: o.current_name })
  }
  const objectShort = (oid: string) => objectsById.get(oid)?.current_name ?? oid.slice(0, 8)

  // Юр.лица: id → name + порядок (seq)
  type LERef = { id: string; name: string }
  type OrgRow = { legal_entity_id: string; seq: number | null; legal_entities: LERef | LERef[] | null }
  const orgs: { id: string; name: string }[] = []
  for (const r of (leRes.data ?? []) as OrgRow[]) {
    const le = Array.isArray(r.legal_entities) ? r.legal_entities[0] : r.legal_entities
    if (le) orgs.push({ id: le.id, name: le.name })
  }
  const orgIndexById = new Map<string, number>()
  orgs.forEach((o, i) => orgIndexById.set(o.id, i + 1))

  // Участники сгруппированные по orgId
  type ContactRef = {
    last_name?: string | null
    first_name?: string | null
    middle_name?: string | null
    job_title?: string | null
    legal_entity_id?: string | null
  }
  type PartRow = { contact_id: string; contacts: ContactRef | ContactRef[] | null }
  const participantsByOrg = new Map<string, ContactRef[]>()
  for (const p of (partsRes.data ?? []) as PartRow[]) {
    const c = Array.isArray(p.contacts) ? p.contacts[0] : p.contacts
    if (!c?.legal_entity_id) continue
    const list = participantsByOrg.get(c.legal_entity_id) ?? []
    list.push(c)
    participantsByOrg.set(c.legal_entity_id, list)
  }

  // Темы и задачи
  const topics = (topicsRes.data ?? []) as Array<{
    seq: number
    title: string
    content: string
    raised_by_org: string | null
  }>
  type RenderedTask = {
    id: string
    code: string
    title: string
    explanation: string | null
    status: string
    assignee_org: string | null
    due_date: string | null
    object_ids: string[]
    done_note: string | null
  }
  const tasks = (tasksRes.data ?? []) as RenderedTask[]

  // Закрытия в окне «от предыдущего собрания до текущего», обогащённые источником.
  // Уникальные task_id (одна задача могла закрыться по нескольким объектам).
  const closures = resolutions.closures
  const closedTaskIds = new Set(closures.map((c) => c.task_id))
  // done_note и source для display'я: одна запись на task_id × source (без дублей по объектам)
  type DoneTaskMeta = { done_note: string | null; source: typeof closures[number]['source']; source_title: string | null; source_date: string | null }
  const metaByTaskId = new Map<string, DoneTaskMeta>()
  for (const c of closures) {
    if (!metaByTaskId.has(c.task_id)) {
      metaByTaskId.set(c.task_id, {
        done_note: c.done_note,
        source: c.source,
        source_title: c.source_title,
        source_date: c.source_date,
      })
    }
  }

  // Задачи прошлых собраний (не из tasksRes), закрытые в окне — подгружаем
  const externalClosedIds = [...closedTaskIds].filter(
    (taskId) => !tasks.some((t) => t.id === taskId),
  )
  let externalClosed: RenderedTask[] = []
  if (externalClosedIds.length > 0) {
    const ext = await supabaseAdmin
      .from('tasks')
      .select('id,code,title,explanation,status,assignee_org,due_date,object_ids,done_note')
      .in('id', externalClosedIds)
    externalClosed = ((ext.data ?? []) as RenderedTask[])
  }

  // ПРИНЯЛИ КАК РЕШЁННЫЕ — все задачи закрытые в окне (вне зависимости от источника)
  const myDoneTasks = tasks.filter(
    (t) => closedTaskIds.has(t.id) || t.status === 'done' || t.status === 'closed',
  )
  const acceptedAsDone: RenderedTask[] = [...externalClosed, ...myDoneTasks].map((t) => ({
    ...t,
    done_note: metaByTaskId.get(t.id)?.done_note ?? t.done_note,
  }))

  // «РЕШИЛИ» — задачи этого собрания, не попавшие в «ПРИНЯЛИ»
  const openTasks = tasks.filter(
    (t) => !closedTaskIds.has(t.id) && t.status !== 'done' && t.status !== 'closed' && t.status !== 'cancelled',
  )

  // ── Сборка .md ─────────────────────────────────────────────────────────

  const lines: string[] = []
  lines.push(`# Протокол рабочего собрания ${ddmmyyyy(meeting.meeting_date)} г.`, '')

  // 1. Общая информация
  lines.push('## 1. Общая информация', '')
  lines.push('| №   | Наименование         | Описание |')
  lines.push('| --- | -------------------- | -------- |')
  const objectsLine = meeting.object_ids.length > 0
    ? meeting.object_ids.map(objectShort).join(', ')
    : '—'
  lines.push(`| 1.1 | Объект               | ${objectsLine} |`)
  lines.push(`| 1.2 | Предмет рассмотрения | ${meeting.title} |`)
  lines.push('', '---', '')

  // 2. Участники
  lines.push('## 2. Участники', '')
  lines.push('| №   | Организация | Представитель |')
  lines.push('| --- | ----------- | ------------- |')
  for (const org of orgs) {
    const list = participantsByOrg.get(org.id) ?? []
    if (list.length === 0) continue
    const orgIdx = orgIndexById.get(org.id) ?? 1
    list.forEach((c, ci) => {
      const fio = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ')
      const rep = c.job_title ? `${fio} — ${c.job_title}` : fio
      lines.push(`| ${orgIdx}.${ci + 1} | ${org.name} | ${rep} |`)
    })
  }
  lines.push('', '---', '')

  // 3. ОБСУДИЛИ — темы без задач
  if (topics.length > 0) {
    lines.push('## 3. ОБСУДИЛИ', '')
    lines.push('| №   | Тема | Содержание | Поднял |')
    lines.push('| --- | ---- | ---------- | ------ |')
    topics.forEach((t, i) => {
      const raised = t.raised_by_org ?? '—'
      lines.push(
        `| 3.${i + 1} | ${t.title} | ${(t.content || '').replace(/\n/g, ' ')} | ${raised} |`,
      )
    })
    lines.push('', '---', '')
  }

  // 4. ПРИНЯЛИ КАК РЕШЁННЫЕ — закрытые задачи (прошлых + этого собрания)
  // Код задачи — внутренний, в публичный протокол не выводится.
  lines.push('## 4. ПРИНЯЛИ КАК РЕШЁННЫЕ', '')
  lines.push('| №   | Наименование | Пояснение |')
  lines.push('| --- | ------------ | --------- |')
  if (acceptedAsDone.length === 0) {
    lines.push('| —   | Нет принятых пунктов | — |')
  } else {
    acceptedAsDone.forEach((t, i) => {
      const note = t.done_note ? ` (${t.done_note})` : ''
      lines.push(
        `| 4.${i + 1} | ${t.title} | ${(t.explanation || '').replace(/\n/g, ' ')}${note} |`,
      )
    })
  }
  lines.push('', '---', '')

  // 5. РЕШИЛИ — открытые задачи этого собрания
  lines.push('## 5. РЕШИЛИ', '')
  lines.push('| №   | Наименование | Пояснение | Ответственный | Срок |')
  lines.push('| --- | ------------ | --------- | ------------- | ---- |')
  if (openTasks.length === 0) {
    lines.push('| —   | Нет открытых пунктов | — | — | — |')
  } else {
    openTasks.forEach((t, i) => {
      const due = t.due_date ? ddmmyyyy(t.due_date) : '—'
      lines.push(
        `| 5.${i + 1} | ${t.title} | ${(t.explanation || '').replace(/\n/g, ' ')} | ${t.assignee_org || '—'} | ${due} |`,
      )
    })
  }

  const md = lines.join('\n') + '\n'

  const filename = `${meeting.code ?? `ПРОТ-${meeting.meeting_date}`}.md`
  return new NextResponse(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  })
}
