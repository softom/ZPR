// ─── loadResolutions ──────────────────────────────────────────────────────
// Загружает закрытия задач (task_object_status status in done/closed) в окне
// «от предыдущего собрания до текущего» на пересекающихся object_ids собрания,
// и обогащает каждое закрытие источником через entity_links(resolved_by) +
// task_object_status.resolved_via_link_id.
//
// Возвращает группы закрытий по источнику:
//   on_meeting   — закрыто решением этого собрания (entity_link.to = this meeting)
//   reported     — закрыто отчётом исполнителя (event type=project_note)
//   by_document  — закрыто документом (entity_link.to_type='document')
//   by_letter    — закрыто перепиской (entity_link.to_type='letter')
//   by_other     — иная привязка (другое собрание, другой event и т.п.)
//   unsourced    — закрытие без resolved_via_link_id (legacy / ручное)
//
// Окно: от prev_meeting.meeting_date (exclusive) до this_meeting.meeting_date
// (inclusive). prev_meeting — последнее approved/protocoled собрание с
// пересекающимися object_ids ДО даты текущего. Fallback: -30 дней.
//
// См. WIKI 19_Сущность_Задача «Жизненный цикл связей задачи».

import { supabaseAdmin } from '@/lib/supabase-admin'

export type ResolutionSource =
  | 'on_meeting' | 'reported' | 'by_document' | 'by_letter' | 'by_other' | 'unsourced'

export type ClosureRow = {
  task_id: string
  object_id: string
  done_date: string
  done_note: string | null
  resolved_via_link_id: string | null
  // Расширения по источнику
  source: ResolutionSource
  source_title: string | null      // короткая метка источника (например, "Акт КС-2 № 17")
  source_date: string | null       // дата источника (event date, document signed, и т.п.)
}

export type ResolutionsBundle = {
  window_start: string             // ISO date — нижняя граница окна (exclusive)
  window_end: string               // ISO date — верхняя граница окна (inclusive, = meeting_date)
  prev_meeting_date: string | null // дата фактического предыдущего собрания (null если fallback)
  closures: ClosureRow[]
}

/**
 * Найти дату предыдущего approved/protocoled собрания на пересекающихся
 * object_ids ДО заданной даты. Возвращает null если не найдено.
 */
async function findPreviousMeetingDate(
  thisMeetingId: string,
  thisMeetingDate: string,
  objectIds: string[],
): Promise<string | null> {
  if (objectIds.length === 0) return null
  const { data, error } = await supabaseAdmin
    .from('meetings')
    .select('id, meeting_date, object_ids, status')
    .lt('meeting_date', thisMeetingDate)
    .in('status', ['approved', 'protocoled'])
    .neq('id', thisMeetingId)
    .order('meeting_date', { ascending: false })
    .limit(50)
  if (error) return null
  for (const m of (data ?? []) as Array<{ meeting_date: string; object_ids: string[] }>) {
    if ((m.object_ids ?? []).some((oid) => objectIds.includes(oid))) {
      return m.meeting_date
    }
  }
  return null
}

/**
 * Главный загрузчик. На вход — meeting id, meeting_date, object_ids.
 * На выход — bundle с группами закрытий.
 */
export async function loadResolutions(args: {
  meetingId: string
  meetingDate: string
  objectIds: string[]
}): Promise<ResolutionsBundle> {
  const { meetingId, meetingDate, objectIds } = args
  const prevDate = await findPreviousMeetingDate(meetingId, meetingDate, objectIds)

  // Нижняя граница окна: либо предыдущее собрание (exclusive), либо -30 дней
  let windowStart: string
  if (prevDate) {
    windowStart = prevDate
  } else {
    const d = new Date(meetingDate)
    d.setDate(d.getDate() - 30)
    windowStart = d.toISOString().slice(0, 10)
  }

  if (objectIds.length === 0) {
    return { window_start: windowStart, window_end: meetingDate, prev_meeting_date: prevDate, closures: [] }
  }

  // 1) Все закрытия в окне на нужных объектах
  const tosRes = await supabaseAdmin
    .from('task_object_status')
    .select('task_id, object_id, status, done_date, done_note, resolved_via_link_id')
    .in('object_id', objectIds)
    .in('status', ['done', 'closed'])
    .gt('done_date', windowStart)
    .lte('done_date', meetingDate)
  const tos = (tosRes.data ?? []) as Array<{
    task_id: string; object_id: string; status: string; done_date: string;
    done_note: string | null; resolved_via_link_id: string | null;
  }>

  if (tos.length === 0) {
    return { window_start: windowStart, window_end: meetingDate, prev_meeting_date: prevDate, closures: [] }
  }

  // 2) Загружаем entity_links для resolved_via_link_id (где они есть)
  const linkIds = [...new Set(tos.map((r) => r.resolved_via_link_id).filter((x): x is string => Boolean(x)))]
  const linksById = new Map<string, { to_type: string; to_id: string; notes: string | null }>()
  if (linkIds.length > 0) {
    const linksRes = await supabaseAdmin
      .from('entity_links')
      .select('id, to_type, to_id, notes')
      .in('id', linkIds)
    for (const l of (linksRes.data ?? []) as Array<{ id: string; to_type: string; to_id: string; notes: string | null }>) {
      linksById.set(l.id, { to_type: l.to_type, to_id: l.to_id, notes: l.notes })
    }
  }

  // 3) Подтягиваем мета-инфо целей связи
  const eventIds: string[] = []
  const meetingIds: string[] = []
  const docIds: string[] = []
  const letterIds: string[] = []
  for (const l of linksById.values()) {
    if (l.to_type === 'event')    eventIds.push(l.to_id)
    if (l.to_type === 'meeting')  meetingIds.push(l.to_id)
    if (l.to_type === 'document') docIds.push(l.to_id)
    if (l.to_type === 'letter')   letterIds.push(l.to_id)
  }

  const [evRes, mtRes, dcRes, ltRes] = await Promise.all([
    eventIds.length ? supabaseAdmin.from('events').select('id, title, event_type, date_end, date_computed').in('id', eventIds) : Promise.resolve({ data: [] as Array<{ id: string; title: string; event_type: string; date_end: string | null; date_computed: string | null }> }),
    meetingIds.length ? supabaseAdmin.from('meetings').select('id, code, meeting_date').in('id', meetingIds) : Promise.resolve({ data: [] as Array<{ id: string; code: string | null; meeting_date: string }> }),
    docIds.length ? supabaseAdmin.from('documents').select('id, title, doc_number, signed_date').in('id', docIds) : Promise.resolve({ data: [] as Array<{ id: string; title: string; doc_number: string | null; signed_date: string | null }> }),
    letterIds.length ? supabaseAdmin.from('letters').select('id, subject, date').in('id', letterIds) : Promise.resolve({ data: [] as Array<{ id: string; subject: string; date: string | null }> }),
  ])
  const eventsById   = new Map((evRes.data ?? []).map((e) => [e.id, e]))
  const meetingsById = new Map((mtRes.data ?? []).map((m) => [m.id, m]))
  const docsById     = new Map((dcRes.data ?? []).map((d) => [d.id, d]))
  const lettersById  = new Map((ltRes.data ?? []).map((l) => [l.id, l]))

  // 4) Собираем enriched closures
  const closures: ClosureRow[] = tos.map((r) => {
    let source: ResolutionSource = 'unsourced'
    let source_title: string | null = null
    let source_date: string | null = null

    if (r.resolved_via_link_id) {
      const link = linksById.get(r.resolved_via_link_id)
      if (link) {
        if (link.to_type === 'meeting') {
          const m = meetingsById.get(link.to_id)
          source = (link.to_id === meetingId) ? 'on_meeting' : 'by_other'
          source_title = m?.code ?? `Собрание ${link.to_id.slice(0, 8)}`
          source_date = m?.meeting_date ?? null
        } else if (link.to_type === 'event') {
          const e = eventsById.get(link.to_id)
          if (e?.event_type === 'project_note') source = 'reported'
          else source = 'by_other'
          source_title = e?.title ?? `Событие ${link.to_id.slice(0, 8)}`
          source_date = e?.date_end ?? e?.date_computed ?? null
        } else if (link.to_type === 'document') {
          const d = docsById.get(link.to_id)
          source = 'by_document'
          source_title = d?.doc_number ? `${d.title} № ${d.doc_number}` : (d?.title ?? `Документ ${link.to_id.slice(0, 8)}`)
          source_date = d?.signed_date ?? null
        } else if (link.to_type === 'letter') {
          const l = lettersById.get(link.to_id)
          source = 'by_letter'
          source_title = l?.subject ?? `Письмо ${link.to_id.slice(0, 8)}`
          source_date = l?.date ?? null
        } else {
          source = 'by_other'
        }
      }
    }

    return {
      task_id: r.task_id,
      object_id: r.object_id,
      done_date: r.done_date,
      done_note: r.done_note,
      resolved_via_link_id: r.resolved_via_link_id,
      source,
      source_title,
      source_date,
    }
  })

  return {
    window_start: windowStart,
    window_end: meetingDate,
    prev_meeting_date: prevDate,
    closures,
  }
}
