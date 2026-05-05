/**
 * Серверный генератор .docx-протокола.
 *
 * Использует те же запросы к БД, что и /render?format=md, и собирает
 * Document с npm-пакетом `docx` без зависимости от Python/шаблонов.
 *
 * Структура соответствует [Протокол_формат.md в STORAGE_DIR\_ШАБЛОНЫ\]:
 *   1. Общая информация
 *   2. Участники
 *   3. ОБСУДИЛИ
 *   4. ПРИНЯЛИ КАК РЕШЁННЫЕ
 *   5. РЕШИЛИ
 */

import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
  BorderStyle,
} from 'docx'
import { supabaseAdmin } from '@/lib/supabase-admin'

function ddmmyyyy(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

function p(text: string, opts: { bold?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold ?? false, size: opts.size ?? 22 })],
  })
}

function cell(text: string, opts: { bold?: boolean; widthPct?: number } = {}): TableCell {
  return new TableCell({
    width: opts.widthPct ? { size: opts.widthPct, type: WidthType.PERCENTAGE } : undefined,
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: opts.bold ?? false, size: 22 })],
      }),
    ],
  })
}

function thinTable(rows: TableRow[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
    },
    rows,
  })
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({
    heading: level,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true })],
  })
}

export async function generateProtocolDocx(meetingId: string): Promise<Buffer> {
  // 1) meeting
  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings')
    .select('*')
    .eq('id', meetingId)
    .single()
  if (mErr || !meeting) throw new Error(`Собрание не найдено: ${mErr?.message ?? 'unknown'}`)

  // 2) связанные данные. См. WIKI 19_Сущность_Задача → Per-object статусы.
  const [leRes, partsRes, topicsRes, tasksRes, objectsRes, closedTosRes] = await Promise.all([
    supabaseAdmin
      .from('meeting_legal_entities')
      .select('legal_entity_id, seq, legal_entities(id,name)')
      .eq('meeting_id', meetingId)
      .order('seq', { ascending: true, nullsFirst: false }),
    supabaseAdmin
      .from('meeting_participants')
      .select('contact_id, contacts(last_name,first_name,middle_name,job_title,legal_entity_id)')
      .eq('meeting_id', meetingId),
    supabaseAdmin
      .from('meeting_topics')
      .select('seq,title,content,raised_by_org,status')
      .eq('meeting_id', meetingId)
      .eq('status', 'approved')
      .order('seq'),
    supabaseAdmin
      .from('tasks')
      .select('id,code,title,explanation,status,assignee_org,due_date,object_ids,done_note')
      .eq('meeting_id', meetingId)
      .order('code'),
    supabaseAdmin.from('objects').select('id,code,current_name'),
    // Per-object закрытия в дату собрания на объектах собрания
    (meeting.object_ids?.length ?? 0) > 0
      ? supabaseAdmin
          .from('task_object_status')
          .select('task_id, object_id, status, done_date, done_note')
          .in('object_id', meeting.object_ids as string[])
          .in('status', ['done', 'closed'])
          .eq('done_date', meeting.meeting_date as string)
      : Promise.resolve({ data: [], error: null }),
  ])

  // 3) подготовка данных
  const objectsById = new Map<string, { code: string; current_name: string }>()
  for (const o of (objectsRes.data ?? []) as Array<{
    id: string
    code: string
    current_name: string
  }>) {
    objectsById.set(o.id, { code: o.code, current_name: o.current_name })
  }
  const objShort = (oid: string) => objectsById.get(oid)?.current_name ?? oid.slice(0, 8)

  type LERef = { id: string; name: string }
  type OrgRow = { legal_entity_id: string; seq: number | null; legal_entities: LERef | LERef[] | null }
  const orgs: { id: string; name: string }[] = []
  for (const r of (leRes.data ?? []) as OrgRow[]) {
    const le = Array.isArray(r.legal_entities) ? r.legal_entities[0] : r.legal_entities
    if (le) orgs.push({ id: le.id, name: le.name })
  }
  const orgIndexById = new Map<string, number>()
  orgs.forEach((o, i) => orgIndexById.set(o.id, i + 1))

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

  const topics = (topicsRes.data ?? []) as Array<{
    seq: number
    title: string
    content: string
    raised_by_org: string | null
  }>
  type DocxTask = {
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
  const tasks = (tasksRes.data ?? []) as DocxTask[]

  // Per-object closures
  type ClosedJunction = { task_id: string; object_id: string; status: string; done_date: string; done_note: string | null }
  const closedJunction = (closedTosRes.data ?? []) as ClosedJunction[]
  const closedTaskIds = new Set(closedJunction.map((r) => r.task_id))
  const doneNoteByTaskId = new Map<string, string | null>()
  for (const r of closedJunction) {
    if (r.done_note && !doneNoteByTaskId.has(r.task_id)) {
      doneNoteByTaskId.set(r.task_id, r.done_note)
    }
  }

  // Подгрузить задачи прошлых собраний, закрытые здесь (через junction)
  const externalClosedIds = [...closedTaskIds].filter(
    (taskId) => !tasks.some((t) => t.id === taskId),
  )
  let externalClosed: DocxTask[] = []
  if (externalClosedIds.length > 0) {
    const ext = await supabaseAdmin
      .from('tasks')
      .select('id,code,title,explanation,status,assignee_org,due_date,object_ids,done_note')
      .in('id', externalClosedIds)
    externalClosed = (ext.data ?? []) as DocxTask[]
  }

  const myDoneTasks = tasks.filter(
    (t) => closedTaskIds.has(t.id) || t.status === 'done' || t.status === 'closed',
  )
  const acceptedAsDone: DocxTask[] = [...externalClosed, ...myDoneTasks].map((t) => ({
    ...t,
    done_note: doneNoteByTaskId.get(t.id) ?? t.done_note,
  }))
  const openTasks = tasks.filter(
    (t) => !closedTaskIds.has(t.id) && t.status !== 'done' && t.status !== 'closed' && t.status !== 'cancelled',
  )

  // 4) Сборка документа
  const children: (Paragraph | Table)[] = []

  // Заголовок
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: `Протокол рабочего собрания ${ddmmyyyy(meeting.meeting_date as string)} г.`,
          bold: true,
          size: 28,
        }),
      ],
    }),
  )

  // 1. Общая информация
  children.push(heading('1. Общая информация', HeadingLevel.HEADING_2))
  const objectsLine =
    (meeting.object_ids?.length ?? 0) > 0
      ? (meeting.object_ids as string[]).map(objShort).join(', ')
      : '—'
  children.push(
    thinTable([
      new TableRow({
        children: [
          cell('№', { bold: true, widthPct: 10 }),
          cell('Наименование', { bold: true, widthPct: 30 }),
          cell('Описание', { bold: true, widthPct: 60 }),
        ],
      }),
      new TableRow({
        children: [cell('1.1'), cell('Объект'), cell(objectsLine)],
      }),
      new TableRow({
        children: [cell('1.2'), cell('Предмет рассмотрения'), cell(meeting.title as string)],
      }),
    ]),
  )

  // 2. Участники
  children.push(heading('2. Участники', HeadingLevel.HEADING_2))
  const partRows: TableRow[] = [
    new TableRow({
      children: [
        cell('№', { bold: true, widthPct: 10 }),
        cell('Организация', { bold: true, widthPct: 40 }),
        cell('Представитель', { bold: true, widthPct: 50 }),
      ],
    }),
  ]
  for (const org of orgs) {
    const list = participantsByOrg.get(org.id) ?? []
    const orgIdx = orgIndexById.get(org.id) ?? 1
    list.forEach((c, ci) => {
      const fio = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ')
      const rep = c.job_title ? `${fio} — ${c.job_title}` : fio
      partRows.push(
        new TableRow({
          children: [cell(`${orgIdx}.${ci + 1}`), cell(org.name), cell(rep)],
        }),
      )
    })
  }
  children.push(thinTable(partRows))

  // 3. ОБСУДИЛИ
  if (topics.length > 0) {
    children.push(heading('3. ОБСУДИЛИ', HeadingLevel.HEADING_2))
    const rows: TableRow[] = [
      new TableRow({
        children: [
          cell('№', { bold: true, widthPct: 8 }),
          cell('Тема', { bold: true, widthPct: 30 }),
          cell('Содержание', { bold: true, widthPct: 50 }),
          cell('Поднял', { bold: true, widthPct: 12 }),
        ],
      }),
      ...topics.map(
        (t, i) =>
          new TableRow({
            children: [
              cell(`3.${i + 1}`),
              cell(t.title),
              cell((t.content || '').replace(/\n/g, ' ')),
              cell(t.raised_by_org ?? '—'),
            ],
          }),
      ),
    ]
    children.push(thinTable(rows))
  }

  // 4. ПРИНЯЛИ КАК РЕШЁННЫЕ — без колонки Код (он внутренний)
  children.push(heading('4. ПРИНЯЛИ КАК РЕШЁННЫЕ', HeadingLevel.HEADING_2))
  const acceptedRows: TableRow[] = [
    new TableRow({
      children: [
        cell('№', { bold: true, widthPct: 8 }),
        cell('Наименование', { bold: true, widthPct: 35 }),
        cell('Пояснение', { bold: true, widthPct: 57 }),
      ],
    }),
  ]
  if (acceptedAsDone.length === 0) {
    acceptedRows.push(
      new TableRow({
        children: [cell('—'), cell('Нет принятых пунктов'), cell('—')],
      }),
    )
  } else {
    acceptedAsDone.forEach((t, i) => {
      const note = t.done_note ? ` (${t.done_note})` : ''
      acceptedRows.push(
        new TableRow({
          children: [
            cell(`4.${i + 1}`),
            cell(t.title),
            cell((t.explanation || '').replace(/\n/g, ' ') + note),
          ],
        }),
      )
    })
  }
  children.push(thinTable(acceptedRows))

  // 5. РЕШИЛИ
  children.push(heading('5. РЕШИЛИ', HeadingLevel.HEADING_2))
  const resolveRows: TableRow[] = [
    new TableRow({
      children: [
        cell('№', { bold: true, widthPct: 8 }),
        cell('Наименование', { bold: true, widthPct: 30 }),
        cell('Пояснение', { bold: true, widthPct: 32 }),
        cell('Ответственный', { bold: true, widthPct: 20 }),
        cell('Срок', { bold: true, widthPct: 10 }),
      ],
    }),
  ]
  if (openTasks.length === 0) {
    resolveRows.push(
      new TableRow({
        children: [cell('—'), cell('Нет открытых пунктов'), cell('—'), cell('—'), cell('—')],
      }),
    )
  } else {
    openTasks.forEach((t, i) => {
      resolveRows.push(
        new TableRow({
          children: [
            cell(`5.${i + 1}`),
            cell(t.title),
            cell((t.explanation || '').replace(/\n/g, ' ')),
            cell(t.assignee_org || '—'),
            cell(t.due_date ? ddmmyyyy(t.due_date) : '—'),
          ],
        }),
      )
    })
  }
  children.push(thinTable(resolveRows))

  // Подвал
  children.push(p(' '))
  children.push(p(`Сформировано: ${ddmmyyyy(new Date().toISOString().slice(0, 10))}`))

  const doc = new Document({
    creator: 'ЗПР Protocol Generator',
    title: `Протокол ${ddmmyyyy(meeting.meeting_date as string)}`,
    sections: [{ children }],
  })

  return await Packer.toBuffer(doc)
}
