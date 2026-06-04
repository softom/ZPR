'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { optionIconPrefix } from '@/lib/objects/iconLabel'
import { formatMeetingRef, type ContactMin } from '@/lib/entityRef'
import { EntityLinksBlock, type LinkPhase } from '@/components/EntityLinksBlock'
import { EntityLinkPicker } from '@/components/EntityLinkPicker'

type Task = {
  id: string
  code: string
  title: string
  explanation: string | null
  status: 'preliminary' | 'open' | 'in_progress' | 'done' | 'closed' | 'cancelled'
  priority: 'high' | 'medium' | 'low' | null
  assignee_org: string | null
  assignee_entity_id: string | null
  object_ids: string[]               // UUID — основная связь (см. WIKI 09_Правило_связей)
  meeting_id: string | null          // FK на meetings — собрание-источник (denormalized, sync с entity_links.raised_from)
  start_date: string | null
  due_date: string | null
  done_date: string | null
  done_note: string | null
  quotes: { speaker_org?: string; text: string }[]
  // Ранжирование задачи для попадания в отчёт (см. WIKI 19 → «Ранжирование»).
  // critical/high/normal/low/skip или null (не оценена).
  report_relevance: 'critical' | 'high' | 'normal' | 'low' | 'skip' | null
  created_at: string
  updated_at: string
}

// Иконки и подписи для уровней report_relevance (по образцу events.importance).
const REPORT_RELEVANCE: Record<NonNullable<Task['report_relevance']>, { icon: string; label: string; color: string; sort: number }> = {
  critical: { icon: '🔥', label: 'Критично',   color: 'text-red-700 bg-red-50',        sort: 0 },
  high:     { icon: '⭐', label: 'Важно',      color: 'text-amber-700 bg-amber-50',    sort: 1 },
  normal:   { icon: '•',  label: 'Обычно',    color: 'text-gray-600 bg-gray-50',      sort: 2 },
  low:      { icon: '○',  label: 'Низкое',    color: 'text-gray-400 bg-gray-50',      sort: 3 },
  skip:     { icon: '🚫', label: 'Не в отчёт', color: 'text-gray-400 bg-gray-100',    sort: 4 },
}

type MeetingRef = { id: string; code: string | null; title: string | null; meeting_date: string; object_ids: string[] | null }

type LegalEntity = { id: string; name: string }
type ObjectRef = { id: string; code: string; current_name: string; color: string | null; icon: string | null; icon_small: string | null }

type ObjectStatusRow = {
  task_id: string
  object_id: string
  status: 'open' | 'in_progress' | 'done' | 'closed' | 'cancelled'
  done_date: string | null
  resolved_via_link_id: string | null
}

// Связь задачи с внешней сущностью — фаза жизненного цикла из entity_links.
// См. WIKI 19_Сущность_Задача «Жизненный цикл связей задачи».
type TaskLink = {
  id: string
  from_id: string                                       // task.id (as text)
  to_type: 'meeting' | 'event' | 'document' | 'letter' | 'legal_entity' | 'contact'
  to_id: string
  link_type: 'raised_from' | 'related_to' | 'resolved_by' | 'assigned_to'
  notes: string | null
  created_at: string
}

// Фазы жизненного цикла задачи — конфиг для общего EntityLinksBlock.
// Каждая фаза = один link_type. См. WIKI 19 «Жизненный цикл связей задачи».
const TASK_LINK_PHASES: LinkPhase[] = [
  { linkType: 'raised_from', icon: '📌', label: 'Постановка',         color: 'border-blue-400 bg-blue-50',   addHint: 'Добавить связь фазы «Постановка»' },
  { linkType: 'related_to',  icon: '🔄', label: 'Связанные действия', color: 'border-amber-400 bg-amber-50', addHint: 'Добавить связь фазы «Связанные действия»' },
  { linkType: 'resolved_by', icon: '✅', label: 'Завершение',         color: 'border-green-400 bg-green-50', addHint: 'Добавить связь фазы «Завершение» (закроет per-object статусы)' },
]

// Отдельная фаза «Ответственные» — link_type='assigned_to', to_type
// может быть legal_entity (организация) или contact (конкретное лицо).
// Денормализация: первый assigned_to→legal_entity отзеркаливается в
// tasks.assignee_entity_id триггером (см. WIKI 19 v2.5).
const TASK_ASSIGNEE_PHASES: LinkPhase[] = [
  { linkType: 'assigned_to', icon: '👤', label: 'Ответственные', color: 'border-purple-400 bg-purple-50', addHint: 'Добавить ответственного (контакт или организация)' },
]

function taskPhaseLabel(linkType: TaskLink['link_type']): string {
  return TASK_LINK_PHASES.find((p) => p.linkType === linkType)?.label ?? linkType
}

type EventRef = { id: string; title: string; event_type: string; date_end: string | null; date_computed: string | null; object_ids: string[] | null }
// Связь «событие → задача» (entity_links references). Используется для
// детектора «висящих» задач: если есть свежий event-reference с датой > due_date,
// задача вероятно фактически выполнена.
type EventTaskRef = { from_id: string; to_id: string; created_at: string }
type DocumentRef = { id: string; title: string; doc_number: string | null; signed_date: string | null }
type LetterRef = { id: string; subject: string; date: string | null; direction: string | null }

const STATUS_OPTIONS: Task['status'][] = [
  'preliminary',
  'open',
  'in_progress',
  'done',
  'closed',
  'cancelled',
]

const STATUS_LABELS: Record<Task['status'], string> = {
  preliminary: 'Черновик',
  open: 'Открыта',
  in_progress: 'В работе',
  done: 'Выполнена',
  closed: 'Закрыта',
  cancelled: 'Отменена',
}

const STATUS_BADGE: Record<Task['status'], string> = {
  preliminary: 'bg-gray-100 text-gray-600',
  open: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  closed: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
}

const PRIORITY_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-gray-100 text-gray-600',
}

const PRIORITY_LABEL: Record<string, string> = {
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
}

function formatDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return d.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function isOverdue(t: Task): boolean {
  if (!t.due_date) return false
  if (t.status === 'done' || t.status === 'closed' || t.status === 'cancelled') return false
  return new Date(t.due_date) < new Date(new Date().toDateString())
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [objectStatus, setObjectStatus] = useState<ObjectStatusRow[]>([])
  const [entities, setEntities] = useState<LegalEntity[]>([])
  const [objects, setObjects] = useState<ObjectRef[]>([])
  const [meetings, setMeetings] = useState<MeetingRef[]>([])
  const [taskLinks, setTaskLinks] = useState<TaskLink[]>([])
  const [eventsRef, setEventsRef] = useState<EventRef[]>([])
  const [documentsRef, setDocumentsRef] = useState<DocumentRef[]>([])
  const [lettersRef, setLettersRef] = useState<LetterRef[]>([])
  const [contactsRef, setContactsRef] = useState<ContactMin[]>([])
  const [eventTaskRefs, setEventTaskRefs] = useState<EventTaskRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opened, setOpened] = useState<Task | null>(null)
  // «Отчитаться» — модалка для закрытия задачи на конкретном объекте через
  // создание event(project_note) + entity_links(resolved_by) + UPDATE
  // task_object_status.
  const [reportTarget, setReportTarget] = useState<{ task: Task; objectId: string } | null>(null)
  // «+ Добавить связь» — модалка для ручного добавления entity_link
  // указанной фазы (raised_from / related_to / resolved_by).
  const [addLinkTarget, setAddLinkTarget] = useState<{ task: Task; linkType: TaskLink['link_type'] } | null>(null)

  // Фильтры
  const [filterStatus, setFilterStatus] = useState<string>('active') // active | preliminary | done | all | <status>
  const [filterEntity, setFilterEntity] = useState<string>('')
  const [filterObject, setFilterObject] = useState<string>('')
  const [filterPriority, setFilterPriority] = useState<string>('')
  const [filterOverdue, setFilterOverdue] = useState<boolean>(false)
  // «Висящие» — задачи open/in_progress, на которых есть свежие event-references
  // с датой > due_date. Сильный сигнал «фактически закрыта, но статус не обновлён».
  const [filterStale, setFilterStale] = useState<boolean>(false)
  // Релевантность для отчёта — фильтр по уровню (или 'unrated' = без оценки)
  const [filterRelevance, setFilterRelevance] = useState<string>('')
  // Сортировка по релевантности для пред-отчёта (critical → high → normal → low → skip → unrated)
  const [sortByRelevance, setSortByRelevance] = useState<boolean>(false)
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState<'none' | 'entity' | 'object'>('none')
  // Режим отображения для groupBy='object':
  //   'by-link' — задача дублируется в каждой группе своих object_ids (по связям)
  //   'by-task' — задача показывается один раз, в группе первого object_id (по задачам)
  const [objectViewMode, setObjectViewMode] = useState<'by-link' | 'by-task'>('by-link')

  useEffect(() => {
    load()
  }, [])

  // Открытие задачи по ?open=<id> в URL — используется ссылками из других страниц
  // (например, из карточек событий /reports/[id] → клик на raised_from-задачу).
  const searchParams = useSearchParams()
  useEffect(() => {
    const openId = searchParams?.get('open')
    if (!openId || tasks.length === 0) return
    const t = tasks.find((x) => x.id === openId)
    if (t) setOpened(t)
  }, [searchParams, tasks])

  async function load() {
    setLoading(true)
    setError('')
    const [t, tos, e, o, m, links, evs, docs, lts, ct, refs] = await Promise.all([
      supabase.from('tasks').select('*').order('priority').order('due_date', { nullsFirst: false }),
      supabase.from('task_object_status').select('task_id, object_id, status, done_date, resolved_via_link_id'),
      supabase.from('legal_entities').select('id, name').order('name'),
      supabase.from('objects').select('id, code, current_name, color, icon, icon_small').order('code'),
      supabase.from('meetings').select('id, code, title, meeting_date, object_ids'),
      // Связи задач — все четыре фазы (lifecycle + assigned_to).
      // См. WIKI 19_Сущность_Задача «Жизненный цикл связей задачи» и «v2.5 — Ответственные».
      supabase.from('entity_links')
        .select('id, from_id, to_type, to_id, link_type, notes, created_at')
        .eq('from_type', 'task')
        .in('link_type', ['raised_from', 'related_to', 'resolved_by', 'assigned_to']),
      supabase.from('events').select('id, title, event_type, date_end, date_computed, object_ids'),
      supabase.from('documents').select('id, title, doc_number, signed_date'),
      supabase.from('letters').select('id, subject, date, direction'),
      supabase.from('contacts')
        .select('id, last_name, first_name, middle_name, job_title, legal_entity_id, user_id')
        .eq('is_active', true)
        .order('last_name'),
      // Связи событие → задача (references) — для эвристики «висящие» задачи:
      // если есть свежее событие, ссылающееся на задачу, она вероятно фактически
      // выполнена, но в БД status всё ещё open.
      supabase.from('entity_links')
        .select('from_id, to_id, created_at')
        .eq('from_type', 'event')
        .eq('to_type', 'task')
        .eq('link_type', 'references'),
    ])
    if (t.error) setError(t.error.message)
    const newTasks = (t.data as Task[]) || []
    setTasks(newTasks)
    // Синхронизируем opened с обновлёнными данными, чтобы статус/даты
    // в модалке отражали реальное состояние БД после любого save/upsert.
    setOpened((prev) => prev ? (newTasks.find((x) => x.id === prev.id) ?? prev) : null)
    setObjectStatus((tos.data as ObjectStatusRow[]) || [])
    setEntities((e.data as LegalEntity[]) || [])
    setObjects((o.data as ObjectRef[]) || [])
    setMeetings((m.data as MeetingRef[]) || [])
    setTaskLinks((links.data as TaskLink[]) || [])
    setEventsRef((evs.data as EventRef[]) || [])
    setDocumentsRef((docs.data as DocumentRef[]) || [])
    setLettersRef((lts.data as LetterRef[]) || [])
    setContactsRef((ct.data as ContactMin[]) || [])
    setEventTaskRefs((refs.data as EventTaskRef[]) || [])
    setLoading(false)
  }

  // Карта (task_id, object_id) → ObjectStatusRow для быстрого чтения per-object статуса
  const objStatusMap = useMemo(() => {
    const m = new Map<string, ObjectStatusRow>()
    for (const r of objectStatus) m.set(`${r.task_id}|${r.object_id}`, r)
    return m
  }, [objectStatus])

  // Карта task_id → { latestEventDate, latestEvent } по references event→task.
  // Используется детектором «висящих» (filterStale): если событие свежее due_date,
  // задача вероятно фактически выполнена.
  type StaleInfo = { latestEventDate: string; latestEvent: EventRef }
  const staleByTaskId = useMemo(() => {
    const eventById = new Map(eventsRef.map((e) => [e.id, e]))
    const result = new Map<string, StaleInfo>()
    for (const r of eventTaskRefs) {
      const ev = eventById.get(r.from_id)
      if (!ev) continue
      const d = ev.date_computed ?? ev.date_end
      if (!d) continue
      const prev = result.get(r.to_id)
      if (!prev || d > prev.latestEventDate) {
        result.set(r.to_id, { latestEventDate: d, latestEvent: ev })
      }
    }
    return result
  }, [eventTaskRefs, eventsRef])

  // Задача «висящая»: open/in_progress + есть event-reference с date > due_date.
  // Если due_date нет — fallback: ref date > today - 14 дней.
  function isStaleTask(t: Task): boolean {
    if (!['open', 'in_progress'].includes(t.status)) return false
    const info = staleByTaskId.get(t.id)
    if (!info) return false
    if (t.due_date) {
      return info.latestEventDate > t.due_date
    }
    // due нет — считаем висящей если event-ref свежее 14 дней
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 14)
    const cutoffISO = cutoff.toISOString().slice(0, 10)
    return info.latestEventDate >= cutoffISO
  }

  // Per-object статус задачи в контексте конкретного объекта.
  // Для preliminary и legacy без объекта — fallback на агрегатный tasks.status.
  function getObjectStatus(t: Task, objectId: string | null): Task['status'] {
    if (!objectId) return t.status
    const r = objStatusMap.get(`${t.id}|${objectId}`)
    return (r?.status as Task['status']) ?? t.status
  }

  // overdue в разрезе объекта
  function isOverdueOn(t: Task, objectId: string | null): boolean {
    if (!t.due_date) return false
    const st = getObjectStatus(t, objectId)
    if (st === 'done' || st === 'closed' || st === 'cancelled') return false
    return new Date(t.due_date) < new Date(new Date().toDateString())
  }

  // Правка дат прямо в задаче (срок / выполнено) для legacy-задач без объектов
  async function saveTaskDate(task: Task, field: 'start_date' | 'due_date' | 'done_date', value: string) {
    const newVal = value || null
    if ((task[field] ?? null) === newVal) return
    const { error } = await supabase.from('tasks').update({ [field]: newVal }).eq('id', task.id)
    if (error) { alert(error.message); return }
    await load()
  }

  // Правка даты выполнения по конкретному объекту в task_object_status.
  // Триггер trg_tos_recompute пересчитает агрегатное tasks.done_date.
  async function saveObjectDoneDate(taskId: string, objectId: string, value: string) {
    const newVal = value || null
    const { error } = await supabase
      .from('task_object_status')
      .update({ done_date: newVal })
      .match({ task_id: taskId, object_id: objectId })
    if (error) { alert(error.message); return }
    await load()
  }

  // «Отчитаться» — атомарное создание отчёта о выполнении задачи на объекте.
  // Создаёт:
  //   1) event(project_note) с датой/заметкой/object_ids=[objectId]
  //   2) entity_link (from=task, to=event, link_type='resolved_by') — фаза завершения
  //   3) UPDATE task_object_status: status='done', done_date, done_note,
  //      done_by_entity_id, resolved_via_link_id=link.id
  // См. WIKI 19_Сущность_Задача «Жизненный цикл связей задачи» + кнопка
  // «✓ Отчитаться» в ObjectStatusEditor.
  async function submitCompletionReport(args: {
    task: Task
    objectId: string
    date: string
    note: string
    doneByEntityId: string | null
  }): Promise<string | null> {
    const { task, objectId, date, note, doneByEntityId } = args

    // 1) event
    const obj = objects.find((o) => o.id === objectId)
    const objLabel = obj ? `${obj.code} — ${obj.current_name}` : objectId.slice(0, 8)
    const eventTitle = `Выполнено: ${task.code} (${objLabel})`
    const evRes = await supabase.from('events').insert({
      event_type: 'project_note',
      title: eventTitle,
      date_end: date,
      object_ids: [objectId],
      note: note || null,
    }).select('id').single()
    if (evRes.error || !evRes.data) {
      return evRes.error?.message ?? 'Не удалось создать событие'
    }
    const eventId = evRes.data.id as string

    // 2) entity_link (resolved_by)
    const linkRes = await supabase.from('entity_links').insert({
      from_type: 'task',
      from_id:   task.id,
      to_type:   'event',
      to_id:     eventId,
      link_type: 'resolved_by',
      notes:     note || null,
    }).select('id').single()
    if (linkRes.error || !linkRes.data) {
      return linkRes.error?.message ?? 'Не удалось создать связь resolved_by'
    }
    const linkId = linkRes.data.id as string

    // 3) update task_object_status
    const updRes = await supabase.from('task_object_status').upsert({
      task_id: task.id,
      object_id: objectId,
      status: 'done',
      done_date: date,
      done_note: note || null,
      done_by_entity_id: doneByEntityId,
      resolved_via_link_id: linkId,
    }, { onConflict: 'task_id,object_id' })
    if (updRes.error) {
      return updRes.error.message
    }

    await load()
    return null
  }

  // Ручное добавление связи задачи с внешней сущностью.
  //
  // Каскад при link_type='resolved_by': задача автоматически закрывается на
  // per-object строках где она ещё активна (open/in_progress). Объекты для
  // закрытия = intersection(task.object_ids, target.object_ids) если у цели
  // есть object_ids (meeting/event), иначе все task.object_ids (document/letter).
  // Финальные статусы (cancelled/done/closed) НЕ переписываются — соблюдаем
  // правило сохранения per-object истории, см. WIKI 19 раздел «Правило
  // агрегатного статуса».
  //
  // Триггер entity_links_sync_meeting_id автоматом обновит tasks.meeting_id
  // если link_type='raised_from' и to_type='meeting'. См. WIKI 19 v2.4.
  async function addTaskLink(args: {
    task: Task
    linkType: TaskLink['link_type']
    toType: TaskLink['to_type']
    toId: string
    notes: string | null
  }): Promise<string | null> {
    const { task, linkType, toType, toId, notes } = args
    const insRes = await supabase.from('entity_links').insert({
      from_type: 'task',
      from_id:   task.id,
      to_type:   toType,
      to_id:     toId,
      link_type: linkType,
      notes:     notes || null,
    }).select('id').single()
    if (insRes.error || !insRes.data) return insRes.error?.message ?? 'Не удалось создать связь'
    const linkId = insRes.data.id as string

    // Каскад resolved_by → закрытие per-object статусов
    if (linkType === 'resolved_by') {
      // Дата закрытия и object_ids цели — из соответствующего реестра
      const today = new Date().toISOString().slice(0, 10)
      let resolveDate = today
      let targetObjectIds: string[] | null = null
      if (toType === 'meeting') {
        const m = meetings.find((x) => x.id === toId)
        resolveDate = m?.meeting_date ?? today
        targetObjectIds = m?.object_ids ?? null
      } else if (toType === 'event') {
        const e = eventsRef.find((x) => x.id === toId)
        resolveDate = e?.date_end ?? e?.date_computed ?? today
        targetObjectIds = e?.object_ids ?? null
      } else if (toType === 'document') {
        const d = documentsRef.find((x) => x.id === toId)
        resolveDate = d?.signed_date ?? today
        // У документа object_ids в этом запросе не подтянут — каскад на все task.object_ids
        targetObjectIds = null
      } else if (toType === 'letter') {
        const l = lettersRef.find((x) => x.id === toId)
        resolveDate = l?.date ?? today
        targetObjectIds = null
      }

      // Объекты задачи, которые надо закрыть: intersection если есть object_ids у цели,
      // иначе ВСЕ объекты задачи. Финально пустой массив — нечего делать.
      const taskObjects = task.object_ids ?? []
      const targets = targetObjectIds && targetObjectIds.length > 0
        ? taskObjects.filter((oid) => targetObjectIds!.includes(oid))
        : taskObjects
      if (targets.length === 0) {
        await load()
        return null
      }

      // Меняем статус только на open/in_progress строках — не трогаем cancelled/done/closed
      // (UPDATE с WHERE — нет риска перезаписать финальные статусы).
      const updRes = await supabase
        .from('task_object_status')
        .update({
          status: 'done',
          done_date: resolveDate,
          done_note: notes || null,
          resolved_via_link_id: linkId,
        })
        .eq('task_id', task.id)
        .in('object_id', targets)
        .in('status', ['open', 'in_progress'])
      if (updRes.error) {
        // Не блокируем — связь уже создана, юзер увидит её в блоке.
        // Можно показать предупреждение, но возврат ошибки тут заставит юзера
        // думать что link не создан. Делаем await load + return null.
        console.error('cascade resolve failed:', updRes.error.message)
      }
    }

    await load()
    return null
  }

  // Удаление связи. Для raised_from→meeting триггер откатит tasks.meeting_id=NULL.
  async function deleteTaskLink(linkId: string): Promise<void> {
    const link = taskLinks.find((l) => l.id === linkId)
    const confirmMsg = link?.link_type === 'raised_from' && link.to_type === 'meeting'
      ? 'Удалить связь «Постановка → собрание»? tasks.meeting_id обнулится (через триггер sync). Продолжить?'
      : 'Удалить связь?'
    if (!confirm(confirmMsg)) return
    const { error } = await supabase.from('entity_links').delete().eq('id', linkId)
    if (error) { alert(error.message); return }
    await load()
  }

  // Per-object: меняем статус задачи на ОДНОМ объекте через task_object_status.
  // Триггер trg_tos_recompute сам пересчитает агрегат tasks.status.
  async function changeObjectStatus(
    task: Task,
    objectId: string,
    newStatus: Exclude<Task['status'], 'preliminary'>,
  ) {
    const today = new Date().toISOString().slice(0, 10)
    const row = {
      task_id: task.id,
      object_id: objectId,
      status: newStatus,
      done_date: ['done','closed'].includes(newStatus) ? today : null,
      done_note: null,
    }
    const { error } = await supabase
      .from('task_object_status')
      .upsert(row, { onConflict: 'task_id,object_id' })
    if (error) { alert(error.message); return }
    await load()
  }

  // Fast-path для общего статуса (агрегата) задачи.
  //
  // ВАЖНО: НЕ ПЕРЕПИСЫВАТЬ существующие финальные статусы (`cancelled` / `done` /
  // `closed`) на новый. Это нарушает per-object историю — например если задача
  // была отменена на объекте А (cancelled) и активна на Б (open), то агрегатный
  // переход в «done» должен закрывать только Б; cancelled на А оставить как есть.
  // Ранее переписывались ВСЕ строки → инцидент 08.05.2026 (5 задач).
  //
  // Разрешённые переходы:
  //   • → done / closed / cancelled  — затрагивают только active (open / in_progress)
  //   • → open / in_progress         — затрагивают только cancelled (re-open).
  //                                    done/closed не трогаем — это финал.
  //   • → preliminary                — не используем junction (только tasks.status)
  async function changeAggregateStatus(task: Task, newStatus: Task['status']) {
    const today = new Date().toISOString().slice(0, 10)

    // Без объектов — legacy: пишем напрямую в tasks
    if ((task.object_ids ?? []).length === 0) {
      const update: Partial<Task> = { status: newStatus }
      if (newStatus === 'done' && !task.done_date) update.done_date = today
      const { error } = await supabase.from('tasks').update(update).eq('id', task.id)
      if (error) { alert(error.message); return }
      await load()
      return
    }

    // Преliminary → не задействуем junction
    if (newStatus === 'preliminary') {
      const { error } = await supabase.from('tasks').update({ status: 'preliminary' }).eq('id', task.id)
      if (error) { alert(error.message); return }
      await load()
      return
    }

    // Загружаем актуальные per-object статусы
    const { data: currentTos, error: loadErr } = await supabase
      .from('task_object_status')
      .select('object_id, status')
      .eq('task_id', task.id)
    if (loadErr) { alert(loadErr.message); return }

    // Подходящие текущие статусы для перехода
    let allowedFrom: string[] = []
    if (['done', 'closed', 'cancelled'].includes(newStatus)) {
      allowedFrom = ['open', 'in_progress']
    } else if (['open', 'in_progress'].includes(newStatus)) {
      allowedFrom = ['cancelled']
    }

    const targetRows = (currentTos ?? []).filter((r) =>
      allowedFrom.includes(r.status as string),
    )

    if (targetRows.length === 0) {
      alert(
        `Нет объектов с подходящим статусом для перехода в «${STATUS_LABELS[newStatus]}». ` +
        `Если нужно изменить cancelled/done строки — используй редактор «Статусы по объектам» ниже.`,
      )
      return
    }

    // Подсказка пользователю если есть строки которые НЕ изменим
    const skipped = (currentTos ?? []).length - targetRows.length
    if (skipped > 0) {
      const ok = confirm(
        `Будет изменено ${targetRows.length} объект(ов). ` +
        `${skipped} объект(ов) с финальным статусом (cancelled/done/closed) не трогаем — измени их вручную в редакторе ниже, если нужно.`,
      )
      if (!ok) return
    }

    const rows = targetRows.map((r) => ({
      task_id: task.id,
      object_id: r.object_id as string,
      status: newStatus,
      done_date: ['done', 'closed'].includes(newStatus) ? today : null,
      done_note: null,
    }))
    const { error } = await supabase
      .from('task_object_status')
      .upsert(rows, { onConflict: 'task_id,object_id' })
    if (error) { alert(error.message); return }
    await load()
  }

  // Изменение привязок: triger tasks_sync_objects подтянет junction
  async function changeObjectIds(task: Task, newObjectIds: string[]) {
    const { error } = await supabase
      .from('tasks')
      .update({ object_ids: newObjectIds })
      .eq('id', task.id)
    if (error) { alert(error.message); return }
    await load()
  }

  // Фильтрация. Если задан objCtx (контекст объекта — выбранный filterObject
  // или группа при groupBy='object') — статус и просрочка берутся per-object
  // из task_object_status. Иначе — агрегат tasks.status.
  //
  // ВАЖНО: при группировке по объекту passesFilter вызывается для каждой
  // группы со своим objCtx. Это нужно чтобы задача, отменённая на объекте 102
  // (но активная на 301), при фильтре «Активные» отображалась только в группе
  // 301, а из группы 102 исчезала (а не висела с красной плашкой «Отменена»).
  function passesFilter(t: Task, objCtx: string | null): boolean {
    const effectiveStatus: Task['status'] = objCtx
      ? getObjectStatus(t, objCtx)
      : t.status

    if (filterStatus === 'active' && !['open', 'in_progress'].includes(effectiveStatus)) return false
    if (filterStatus === 'preliminary' && effectiveStatus !== 'preliminary') return false
    if (filterStatus === 'done' && !['done', 'closed'].includes(effectiveStatus)) return false
    if (filterStatus !== 'active' && filterStatus !== 'all'
        && filterStatus !== 'preliminary' && filterStatus !== 'done'
        && filterStatus !== '' && effectiveStatus !== filterStatus) return false
    if (filterEntity && t.assignee_entity_id !== filterEntity) return false
    if (filterObject && !t.object_ids.includes(filterObject)) return false
    if (filterPriority && t.priority !== filterPriority) return false
    if (filterOverdue && !isOverdueOn(t, objCtx)) return false
    if (filterStale && !isStaleTask(t)) return false
    if (filterRelevance) {
      if (filterRelevance === 'unrated') {
        if (t.report_relevance !== null) return false
      } else {
        if (t.report_relevance !== filterRelevance) return false
      }
    }
    if (search) {
      const q = search.toLowerCase()
      const hay = (t.code + ' ' + t.title + ' ' + (t.explanation || '')).toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }

  const filtered = useMemo(() => {
    return tasks.filter((t) => passesFilter(t, filterObject || null))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, objStatusMap, filterStatus, filterEntity, filterObject, filterPriority, filterOverdue, filterStale, filterRelevance, sortByRelevance, search, staleByTaskId])

  // Сортировка задач внутри группы:
  // 1. Не выполненные (open/in_progress/preliminary) — впереди
  // 2. Среди не выполненных — самые старые сверху (по created_at ASC)
  // 3. Выполненные — после, новые сверху
  // Дата постановки задачи: meeting_date через meeting_id JOIN (день когда задача
  // была поднята на собрании). Fallback на tasks.created_at для legacy задач
  // без meeting_id. См. WIKI 19 раздел «Жизненный цикл связей» — это «дата
  // фазы raised_from».
  function taskRaisedDate(t: Task): number {
    const m = t.meeting_id ? meetings.find((x) => x.id === t.meeting_id) : null
    const iso = m?.meeting_date ?? t.created_at
    return new Date(iso).getTime()
  }

  // Сортировка по релевантности отчёта (critical→high→normal→low→skip→unrated).
  // При равной релевантности — свежие задачи сверху.
  function relevanceRank(t: Task): number {
    if (t.report_relevance === null) return 99
    return REPORT_RELEVANCE[t.report_relevance].sort
  }

  function sortTasks(arr: Task[]): Task[] {
    // Если включена сортировка по релевантности — приоритет ей (для пред-отчёта).
    if (sortByRelevance) {
      return [...arr].sort((a, b) => {
        const ra = relevanceRank(a)
        const rb = relevanceRank(b)
        if (ra !== rb) return ra - rb
        return taskRaisedDate(b) - taskRaisedDate(a)
      })
    }
    // Сортировка по дате постановки DESC (свежие сверху). Статус-приоритет
    // (активные сверху, закрытые снизу) сохраняем только для группировок —
    // в режиме 'none' пользователь обычно фильтрует по статусу отдельно,
    // и доп. разделение мешает хронологии.
    if (groupBy === 'none') {
      return [...arr].sort((a, b) => taskRaisedDate(b) - taskRaisedDate(a))
    }
    return [...arr].sort((a, b) => {
      const aActive = ['open', 'in_progress', 'preliminary'].includes(a.status) ? 0 : 1
      const bActive = ['open', 'in_progress', 'preliminary'].includes(b.status) ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      // Активные — свежие сверху (новые задачи в начале); выполненные — тоже свежие сверху
      return taskRaisedDate(b) - taskRaisedDate(a)
    })
  }

  // Статистика по группе. Если group — объект (groupKey — UUID объекта),
  // считаем по per-object статусам (через task_object_status). Для других группировок
  // (entity, none) — по агрегату tasks.status.
  function groupStats(items: Task[], groupKey: string | null) {
    const isObject = groupBy === 'object' && groupKey && groupKey !== 'none'
    const objId = isObject ? groupKey : null
    const statusOf = (t: Task) => getObjectStatus(t, objId)
    return {
      total: items.length,
      done: items.filter((t) => ['done','closed'].includes(statusOf(t))).length,
      open: items.filter((t) => ['open','in_progress'].includes(statusOf(t))).length,
      preliminary: items.filter((t) => t.status === 'preliminary').length,
      overdue: items.filter((t) => isOverdueOn(t, objId)).length,
    }
  }

  // Полная статистика по группе (по ВСЕМ задачам, не фильтрованным)
  const allByGroup = useMemo(() => {
    const map = new Map<string, Task[]>()
    if (groupBy === 'entity') {
      for (const t of tasks) {
        const key = t.assignee_entity_id || 'none'
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push(t)
      }
    } else if (groupBy === 'object') {
      for (const t of tasks) {
        if (!t.object_ids || t.object_ids.length === 0) {
          if (!map.has('none')) map.set('none', [])
          map.get('none')!.push(t)
        } else {
          for (const oid of t.object_ids) {
            if (!map.has(oid)) map.set(oid, [])
            map.get(oid)!.push(t)
          }
        }
      }
    } else {
      map.set('', tasks)
    }
    return map
  }, [tasks, groupBy])

  // Группировка отфильтрованных задач (для отображения)
  const grouped = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', label: '', items: sortTasks(filtered) }]
    if (groupBy === 'entity') {
      const map = new Map<string, Task[]>()
      for (const t of filtered) {
        const key = t.assignee_entity_id || 'none'
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push(t)
      }
      return [...map.entries()].map(([key, items]) => {
        const e = entities.find((x) => x.id === key)
        return {
          key,
          label: e?.name || (key === 'none' ? 'Без организации' : key),
          items: sortTasks(items),
        }
      }).sort((a, b) => b.items.length - a.items.length)
    }
    // groupBy === 'object'
    // by-link: задача появляется в каждой группе своих object_ids (как раньше)
    // by-task: задача появляется только в одной группе — самой первой по
    //          сортировке code (стабильный выбор: «primary» объект задачи)
    //
    // ВАЖНО: фильтр применяется per-object для каждого кандидата-объекта,
    // поэтому идём не от filtered, а от tasks. Иначе задача с агрегатом 'open'
    // и per-object 'cancelled' на объекте X висела бы в группе X.
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      const objs = t.object_ids ?? []
      if (objs.length === 0) {
        if (!passesFilter(t, null)) continue
        if (!map.has('none')) map.set('none', [])
        map.get('none')!.push(t)
        continue
      }
      if (objectViewMode === 'by-task') {
        // Берём object с наименьшим code среди object_ids задачи
        const sortedByCode = objs
          .map((oid) => ({ oid, code: objects.find((x) => x.id === oid)?.code ?? oid }))
          .sort((a, b) => a.code.localeCompare(b.code))
        const primary = sortedByCode[0]?.oid ?? objs[0]
        if (!passesFilter(t, primary)) continue
        if (!map.has(primary)) map.set(primary, [])
        map.get(primary)!.push(t)
      } else {
        for (const oid of objs) {
          if (!passesFilter(t, oid)) continue
          if (!map.has(oid)) map.set(oid, [])
          map.get(oid)!.push(t)
        }
      }
    }
    return [...map.entries()].map(([key, items]) => {
      const o = objects.find((x) => x.id === key)
      const label = o?.current_name
        ? `${o.code} — ${o.current_name}`
        : (key === 'none' ? 'Без объекта' : key)
      return { key, label, items: sortTasks(items) }
    }).sort((a, b) => {
      const ao = objects.find((x) => x.id === a.key)?.code ?? a.key
      const bo = objects.find((x) => x.id === b.key)?.code ?? b.key
      return ao.localeCompare(bo)
    })
  // tasks/objStatusMap нужны потому что для groupBy='object' идём от tasks
  // и зовём passesFilter (читает per-object статусы). Filter-state — потому
  // что passesFilter замыкает их.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, tasks, objStatusMap, groupBy, objectViewMode, entities, objects,
      filterStatus, filterEntity, filterObject, filterPriority, filterOverdue, filterStale, filterRelevance, sortByRelevance, search])

  const stats = useMemo(() => ({
    total: tasks.length,
    open: tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done' || t.status === 'closed').length,
    preliminary: tasks.filter((t) => t.status === 'preliminary').length,
    overdue: tasks.filter(isOverdue).length,
  }), [tasks])

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">Задачи</h1>
          <Link
            href="/reports/stats"
            className="text-sm px-3 py-1.5 bg-white border border-gray-300 rounded hover:bg-gray-50"
          >
            📊 Статистика
          </Link>
        </div>
        <div className="text-sm text-gray-600">
          Всего: <b>{stats.total}</b> · Открытых: <b>{stats.open}</b> · Выполнено: <b>{stats.done}</b>
          {stats.preliminary > 0 && <> · Черновиков: <b className="text-gray-500">{stats.preliminary}</b></>}
          {stats.overdue > 0 && <> · <span className="text-red-600">Просрочено: <b>{stats.overdue}</b></span></>}
        </div>
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {/* Фильтры */}
      <div className="bg-white rounded shadow p-4 mb-4 grid grid-cols-2 md:grid-cols-6 gap-3">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="active">Активные (open + in_progress)</option>
          <option value="preliminary">Черновики</option>
          <option value="done">Выполненные</option>
          <option value="all">Все</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select
          value={filterEntity}
          onChange={(e) => setFilterEntity(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="">Все юр.лица</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <select
          value={filterObject}
          onChange={(e) => setFilterObject(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="">Все объекты</option>
          {objects.map((o) => (
            <option key={o.id} value={o.id} title={o.current_name}>
              {optionIconPrefix(o.icon)}{o.code}
            </option>
          ))}
        </select>
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="">Все приоритеты</option>
          <option value="high">🔴 Высокий</option>
          <option value="medium">🟡 Средний</option>
          <option value="low">🟢 Низкий</option>
        </select>
        <label className="flex items-center text-sm gap-2 px-2">
          <input
            type="checkbox"
            checked={filterOverdue}
            onChange={(e) => setFilterOverdue(e.target.checked)}
          />
          Только просроченные
        </label>
        <label
          className="flex items-center text-sm gap-2 px-2"
          title="Активные задачи, на которых есть события-references с датой позже срока. Сильный сигнал «фактически выполнена, но статус не обновлён»."
        >
          <input
            type="checkbox"
            checked={filterStale}
            onChange={(e) => setFilterStale(e.target.checked)}
          />
          🕒 Висящие (есть события)
        </label>
        <select
          value={filterRelevance}
          onChange={(e) => setFilterRelevance(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
          title="Релевантность задачи для отчёта"
        >
          <option value="">Все релевантности</option>
          <option value="critical">🔥 Критично</option>
          <option value="high">⭐ Важно</option>
          <option value="normal">• Обычно</option>
          <option value="low">○ Низкое</option>
          <option value="skip">🚫 Не в отчёт</option>
          <option value="unrated">— не оценено —</option>
        </select>
        <label
          className="flex items-center text-sm gap-2 px-2"
          title="Сортировать по релевантности для отчёта (важные сверху). Пред-отчёт: пройтись и закрыть/уточнить — итоговый LLM-отчёт станет точнее."
        >
          <input
            type="checkbox"
            checked={sortByRelevance}
            onChange={(e) => setSortByRelevance(e.target.checked)}
          />
          🎯 По релевантности
        </label>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as 'none' | 'entity' | 'object')}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="none">Без группировки</option>
          <option value="entity">Группировать: по юр.лицу</option>
          <option value="object">Группировать: по объекту</option>
        </select>
        {groupBy === 'object' && (
          <select
            value={objectViewMode}
            onChange={(e) => setObjectViewMode(e.target.value as 'by-link' | 'by-task')}
            className="px-2 py-1.5 border rounded text-sm"
            title="Как показывать задачу с несколькими объектами: в каждой группе своих объектов или один раз"
          >
            <option value="by-link">По связям (дубли в каждой группе)</option>
            <option value="by-task">По задачам (один раз)</option>
          </select>
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по коду/названию…"
          className="col-span-2 md:col-span-6 px-3 py-1.5 border rounded text-sm"
        />
      </div>

      {loading ? (
        <div>Загрузка…</div>
      ) : grouped.reduce((s, g) => s + g.items.length, 0) === 0 ? (
        // Считаем по grouped, а не по filtered: при groupBy='object' группы
        // строятся из tasks + passesFilter per-object, и могут содержать задачи
        // которых нет в filtered (агрегат не подходит, но per-object — да),
        // и наоборот — задача с агрегатом 'open' и cancelled на всех объектах
        // в группах не покажется, хотя filtered её содержит.
        <div className="bg-white rounded shadow p-6 text-center text-gray-400">
          Нет задач по выбранным фильтрам
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => {
            // Статистика — по ВСЕМ задачам группы (не по filtered)
            const allItems = allByGroup.get(g.key) || g.items
            const gs = groupStats(allItems, g.key)
            return (
            <div key={g.key}>
              {groupBy !== 'none' && (
                <div className="mb-2 px-1 flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-700">
                    {g.label}
                  </h2>
                  <div className="text-xs text-gray-500 flex flex-wrap gap-x-3">
                    <span>Поставлено: <b className="text-gray-800">{gs.total}</b></span>
                    <span>Выполнено: <b className="text-green-700">{gs.done}</b></span>
                    <span>Открыто: <b className="text-blue-700">{gs.open}</b></span>
                    {gs.preliminary > 0 && (
                      <span>Черновики: <b className="text-gray-500">{gs.preliminary}</b></span>
                    )}
                    {gs.overdue > 0 && (
                      <span className="text-red-600">Просрочено: <b>{gs.overdue}</b></span>
                    )}
                  </div>
                </div>
              )}
              <div className="bg-white rounded shadow overflow-hidden">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b text-left">
                    <tr>
                      <th className="px-3 py-2 w-32">Код</th>
                      <th className="px-3 py-2 w-24">Постановка</th>
                      <th className="px-3 py-2">Задача</th>
                      <th className="px-3 py-2 w-32">Объекты</th>
                      <th className="px-3 py-2 w-24">Приоритет</th>
                      <th className="px-3 py-2 w-24">Срок</th>
                      <th className="px-3 py-2 w-28">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((t) => {
                      // При group=object показываем per-object статус (из task_object_status).
                      // Для других группировок — агрегат tasks.status.
                      const objCtx = (groupBy === 'object' && g.key && g.key !== 'none') ? g.key : null
                      const dispStatus = getObjectStatus(t, objCtx)
                      const overdue = isOverdueOn(t, objCtx)
                      return (
                      <tr
                        key={t.id}
                        className="border-b hover:bg-gray-50 cursor-pointer"
                        onClick={() => setOpened(t)}
                      >
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{t.code}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">
                          {/* Дата постановки = meeting_date через meeting_id (см. taskRaisedDate).
                              Fallback на created_at если meeting_id NULL. */}
                          {(() => {
                            const m = t.meeting_id ? meetings.find((x) => x.id === t.meeting_id) : null
                            return formatDate(m?.meeting_date ?? t.created_at)
                          })()}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-900 line-clamp-1 flex items-center gap-1">
                            {/* Релевантность для отчёта (📊): кликом — модал задачи */}
                            {t.report_relevance && (
                              <span
                                title={`Релевантность для отчёта: ${REPORT_RELEVANCE[t.report_relevance].label}`}
                                className={`flex-shrink-0 px-1 rounded text-xs ${REPORT_RELEVANCE[t.report_relevance].color}`}
                              >
                                {REPORT_RELEVANCE[t.report_relevance].icon}
                              </span>
                            )}
                            {(() => {
                              const info = staleByTaskId.get(t.id)
                              const stale = isStaleTask(t)
                              if (!stale || !info) return null
                              const d = info.latestEventDate
                              const dHuman = new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', {
                                day: '2-digit', month: '2-digit',
                              })
                              return (
                                <span
                                  title={`Есть событие "${info.latestEvent.title}" от ${d} (после срока). Возможно задача фактически выполнена.`}
                                  className="text-amber-600 flex-shrink-0 cursor-help"
                                >
                                  💡{dHuman}
                                </span>
                              )
                            })()}
                            <span className="line-clamp-1">{t.title}</span>
                          </div>
                          {t.explanation && (
                            <div className="text-xs text-gray-500 line-clamp-1 mt-0.5">
                              {t.explanation}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {(t.object_ids ?? []).slice(0, 3).map((oid) => {
                              const o = objects.find((x) => x.id === oid)
                              const label = o?.code || oid.slice(0, 8)
                              // Чип использует icon_small (32×32) для лёгкости; fallback на icon (если эмодзи).
                              const smallImg = o?.icon_small
                              const fullIsImg = o?.icon ? (o.icon.startsWith('data:image/') || /^https?:\/\//.test(o.icon)) : false
                              return (
                                <span
                                  key={oid}
                                  title={o?.current_name ?? oid}
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-700 text-[11px] font-mono rounded whitespace-nowrap border-l-2"
                                  style={{ borderLeftColor: o?.color ?? '#cbd5e1' }}
                                >
                                  {smallImg
                                    ? <img src={smallImg} alt="" className="w-3.5 h-3.5 object-contain" />
                                    : fullIsImg
                                      ? <img src={o!.icon!} alt="" className="w-3.5 h-3.5 object-contain" />
                                      : o?.icon && <span aria-hidden>{o.icon}</span>}
                                  {label}
                                </span>
                              )
                            })}
                            {(t.object_ids ?? []).length > 3 && (
                              <span className="text-xs text-gray-400">+{(t.object_ids ?? []).length - 3}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {t.priority && (
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                                PRIORITY_BADGE[t.priority]
                              }`}
                            >
                              {PRIORITY_LABEL[t.priority]}
                            </span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-xs ${overdue ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                          {formatDate(t.due_date)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              STATUS_BADGE[dispStatus]
                            }`}
                            title={objCtx && dispStatus !== t.status ? `На этом объекте: ${STATUS_LABELS[dispStatus]} · общий: ${STATUS_LABELS[t.status]}` : undefined}
                          >
                            {STATUS_LABELS[dispStatus]}
                          </span>
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {/* Modal с деталями задачи */}
      {opened && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={() => setOpened(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b sticky top-0 bg-white z-10">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-xs font-mono text-gray-500">{opened.code}</p>
                  <h2 className="text-xl font-semibold mt-1">{opened.title}</h2>
                </div>
                <button
                  onClick={() => setOpened(null)}
                  className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {opened.explanation && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Описание</h3>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{opened.explanation}</p>
                </section>
              )}

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                    Общий статус (агрегат)
                  </h3>
                  <select
                    value={opened.status}
                    onChange={(e) => changeAggregateStatus(opened, e.target.value as Task['status'])}
                    className="w-full px-2 py-1 border rounded"
                    title="Применит выбранный статус ко всем объектам задачи"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Меняет статус на всех {(opened.object_ids ?? []).length || 0} объектах сразу.
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Приоритет</h3>
                  <p>{opened.priority ? PRIORITY_LABEL[opened.priority] : '—'}</p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                    Релевантность для отчёта
                  </h3>
                  <select
                    value={opened.report_relevance ?? ''}
                    onChange={async (e) => {
                      const val = e.target.value || null
                      const { error: upErr } = await supabase
                        .from('tasks')
                        .update({ report_relevance: val })
                        .eq('id', opened.id)
                      if (upErr) { alert(upErr.message); return }
                      // optimistic local update
                      setTasks((arr) => arr.map((x) => x.id === opened.id ? { ...x, report_relevance: val as Task['report_relevance'] } : x))
                      setOpened({ ...opened, report_relevance: val as Task['report_relevance'] })
                    }}
                    className="px-2 py-1 border rounded text-sm w-full"
                  >
                    <option value="">— не оценена —</option>
                    <option value="critical">🔥 Критично</option>
                    <option value="high">⭐ Важно</option>
                    <option value="normal">• Обычно</option>
                    <option value="low">○ Низкое</option>
                    <option value="skip">🚫 Не в отчёт</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Определяет приоритет задачи при формировании отчёта по объекту.
                    Сортировка «🎯 По релевантности» на странице задач — для прохода
                    по важным до генерации.
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Ответственный</h3>
                  <p>
                    {entities.find((e) => e.id === opened.assignee_entity_id)?.name || opened.assignee_org || '—'}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Дата начала</h3>
                  <input
                    key={`start-${opened.id}`}
                    type="date"
                    defaultValue={opened.start_date ?? ''}
                    onBlur={(e) => saveTaskDate(opened, 'start_date', e.target.value)}
                    className="w-full px-2 py-1 border rounded"
                    title="Дата начала работы над задачей (опционально)."
                  />
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Срок</h3>
                  <input
                    key={`due-${opened.id}`}
                    type="date"
                    defaultValue={opened.due_date ?? ''}
                    onBlur={(e) => saveTaskDate(opened, 'due_date', e.target.value)}
                    className={`w-full px-2 py-1 border rounded ${isOverdue(opened) ? 'text-red-600 font-semibold border-red-300' : ''}`}
                    title="Срок выполнения. Изменить — кликнуть и поправить."
                  />
                </div>
                <div className="col-span-2">
                  <ObjectStatusEditor
                    task={opened}
                    objects={objects}
                    objStatusMap={objStatusMap}
                    onChangeObjectStatus={changeObjectStatus}
                    onChangeObjectIds={changeObjectIds}
                    onChangeObjectDoneDate={saveObjectDoneDate}
                    onReport={(oid) => setReportTarget({ task: opened, objectId: oid })}
                  />
                </div>
                <div className="col-span-2">
                  <EntityLinksBlock
                    title="👤 Ответственные"
                    links={taskLinks.filter((l) => l.from_id === opened.id)}
                    phases={TASK_ASSIGNEE_PHASES}
                    registry={{
                      entities,
                      contacts: contactsRef,
                    }}
                    onAdd={(linkType) => setAddLinkTarget({ task: opened, linkType: linkType as TaskLink['link_type'] })}
                    onDelete={(linkId) => deleteTaskLink(linkId)}
                  />
                </div>
                <div className="col-span-2">
                  <EntityLinksBlock
                    title="Связи задачи"
                    links={taskLinks.filter((l) => l.from_id === opened.id)}
                    phases={TASK_LINK_PHASES}
                    registry={{
                      meetings,
                      events: eventsRef,
                      documents: documentsRef,
                      letters: lettersRef,
                    }}
                    onAdd={(linkType) => setAddLinkTarget({ task: opened, linkType: linkType as TaskLink['link_type'] })}
                    onDelete={(linkId) => deleteTaskLink(linkId)}
                  />
                </div>
              </div>

              {opened.quotes && opened.quotes.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Цитаты из обсуждения</h3>
                  <div className="space-y-2">
                    {opened.quotes.map((q, i) => (
                      <blockquote key={i} className="border-l-2 border-gray-300 pl-3 py-1 text-sm text-gray-700">
                        {q.speaker_org && <div className="text-xs font-semibold text-gray-500 mb-0.5">{q.speaker_org}</div>}
                        «{q.text}»
                      </blockquote>
                    ))}
                  </div>
                </section>
              )}

              {/* Дата выполнения — редактируемая.
                  Для legacy-задач (без объектов) пишем напрямую в tasks.done_date.
                  Для задач с объектами — это агрегат, считается триггером из task_object_status.
                  Показываем подсказку, что менять надо у конкретного объекта. */}
              {(['done', 'closed'].includes(opened.status) || opened.done_date) && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Дата выполнения</h3>
                  {(opened.object_ids ?? []).length === 0 ? (
                    <input
                      type="date"
                      defaultValue={opened.done_date ?? ''}
                      onBlur={(e) => saveTaskDate(opened, 'done_date', e.target.value)}
                      className="px-2 py-1 border rounded"
                    />
                  ) : (
                    <div>
                      <p className="text-sm text-gray-700">{formatDate(opened.done_date) || '—'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Агрегат: считается из дат по объектам ниже. Чтобы поправить — измените дату у объекта.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <section className="text-xs text-gray-500 pt-3 border-t">
                {(() => {
                  // Источник задачи — собрание-постановщик через meeting_id
                  // (denormalized указатель, синхронизированный с entity_links.raised_from).
                  // Отображение — через единый formatMeetingRef. См. lib/entityRef.ts.
                  const m = opened.meeting_id
                    ? meetings.find((x) => x.id === opened.meeting_id)
                    : null
                  if (!m) return <>Источник: <span className="text-gray-400">—</span></>
                  const ref = formatMeetingRef(m)
                  return (
                    <span title={ref.tooltip}>
                      Источник:{' '}
                      <Link href={ref.href!} className="text-blue-600 hover:underline">
                        <span className="mr-1">{ref.icon}</span>
                        <span className="font-medium">{ref.label}</span>
                      </Link>
                      {ref.sublabel && <span className="text-gray-500"> · {ref.sublabel}</span>}
                    </span>
                  )
                })()}
              </section>
            </div>
          </div>
        </div>
      )}

      {/* Модалка «Отчитаться» — над модалкой задачи (z-60) чтобы перекрывать её */}
      {reportTarget && (
        <ReportCompletionModal
          task={reportTarget.task}
          objectId={reportTarget.objectId}
          objects={objects}
          entities={entities}
          onClose={() => setReportTarget(null)}
          onSubmit={async (args) => {
            const err = await submitCompletionReport({
              task: reportTarget.task,
              objectId: reportTarget.objectId,
              date: args.date,
              note: args.note,
              doneByEntityId: args.doneByEntityId,
            })
            if (!err) setReportTarget(null)
            return err
          }}
        />
      )}

      {/* Модалка «+ Добавить связь» — универсальный EntityLinkPicker с
          task-specific подсказками (hint) для raised_from и resolved_by фаз. */}
      {addLinkTarget && (() => {
        const phase = addLinkTarget.linkType
        const isAssignee = phase === 'assigned_to'
        // assigned_to: цели — контакт или юр.лицо. Остальные фазы — события/документы/письма/собрания.
        const phaseMeta = isAssignee
          ? TASK_ASSIGNEE_PHASES.find((p) => p.linkType === phase)
          : TASK_LINK_PHASES.find((p) => p.linkType === phase)
        const allowedToTypes = isAssignee
          ? (['contact', 'legal_entity'] as const)
          : (['meeting', 'event', 'document', 'letter'] as const)
        const subtitleLabel = isAssignee ? 'Ответственные' : taskPhaseLabel(phase)
        return (
          <EntityLinkPicker
            title="Добавить связь"
            subtitle={`фаза «${phaseMeta?.icon ?? ''} ${subtitleLabel}»`}
            fromEntity={{ code: addLinkTarget.task.code, title: addLinkTarget.task.title }}
            allowedToTypes={[...allowedToTypes]}
            registry={{
              meetings,
              events: eventsRef,
              documents: documentsRef,
              letters: lettersRef,
              entities,
              contacts: contactsRef,
            }}
            submitColor={phase === 'resolved_by' ? 'emerald' : 'blue'}
            hint={
              <PhaseHint
                linkType={phase}
                // Передаём текущий toType из формы — но компонент его рендерит
                // целиком, так что используем простой подход: показываем все
                // подсказки и пусть юзер видит контекст.
              />
            }
            onClose={() => setAddLinkTarget(null)}
            onSubmit={async (args) => {
              // Multi-select: пакетно создаём связи последовательно. На первой
              // ошибке прекращаем и возвращаем сообщение (уже созданные связи
              // остаются — load() их подтянет).
              for (const toId of args.toIds) {
                const err = await addTaskLink({
                  task: addLinkTarget.task,
                  linkType: phase,
                  toType: args.toType as TaskLink['to_type'],
                  toId,
                  notes: args.notes,
                })
                if (err) return err
              }
              setAddLinkTarget(null)
              return null
            }}
          />
        )
      })()}
    </div>
  )
}

// ─── Подсказки для пользователя в зависимости от фазы ─────────────────────
function PhaseHint({ linkType }: { linkType: TaskLink['link_type'] }) {
  if (linkType === 'raised_from') {
    return (
      <div className="text-[11px] text-amber-700 bg-amber-50 rounded p-2">
        ⚠ Если выбрано <b>Собрание</b> — триггер sync обновит <code>tasks.meeting_id</code> на выбранное.
      </div>
    )
  }
  if (linkType === 'resolved_by') {
    return (
      <div className="text-[11px] text-emerald-700 bg-emerald-50 rounded p-2">
        ✓ Статус задачи на пересекающихся объектах автоматически переведётся в «Выполнено»
        (только для активных строк, финальные cancelled/done не трогаем). Для документа/письма
        (без object_ids) — закроем <b>все</b> объекты задачи.
      </div>
    )
  }
  if (linkType === 'assigned_to') {
    return (
      <div className="text-[11px] text-purple-700 bg-purple-50 rounded p-2">
        👤 Можно добавить несколько ответственных. Для <b>организации</b> (Юр.лицо) триггер sync
        обновит <code>tasks.assignee_entity_id</code> (если ещё не задано). Для <b>контакта</b> —
        связь сохраняется только в entity_links.
      </div>
    )
  }
  return null
}

// ─── Per-object редактор статусов задачи ────────────────────────────────────
// Показывает каждый объект задачи отдельной строкой с per-object select-ом.
// Кнопка «Изменить привязки» открывает чеклист для добавления/удаления объектов.
// См. WIKI 19_Сущность_Задача → Per-object статусы.

function ObjectStatusEditor({
  task,
  objects,
  objStatusMap,
  onChangeObjectStatus,
  onChangeObjectIds,
  onChangeObjectDoneDate,
  onReport,
}: {
  task: Task
  objects: ObjectRef[]
  objStatusMap: Map<string, ObjectStatusRow>
  onChangeObjectStatus: (
    task: Task,
    objectId: string,
    status: Exclude<Task['status'], 'preliminary'>,
  ) => void
  onChangeObjectIds: (task: Task, ids: string[]) => void
  onChangeObjectDoneDate: (taskId: string, objectId: string, value: string) => void
  onReport: (objectId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string[]>(task.object_ids ?? [])

  const PER_OBJECT_OPTIONS: Exclude<Task['status'], 'preliminary'>[] = [
    'open', 'in_progress', 'done', 'closed', 'cancelled',
  ]

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Статусы по объектам ({(task.object_ids ?? []).length})
        </h3>
        <button
          onClick={() => {
            setDraft(task.object_ids ?? [])
            setEditing((v) => !v)
          }}
          className="text-xs text-blue-600 hover:underline"
        >
          {editing ? 'Закрыть' : '✎ Изменить привязки'}
        </button>
      </div>

      {editing ? (
        <div className="border border-blue-200 bg-blue-50 rounded p-2 space-y-2">
          <p className="text-xs text-gray-600">
            Снимите галочку чтобы открепить объект (если по нему был статус
            done/closed/in_progress — junction-строка перейдёт в cancelled с сохранением истории).
            Поставьте — добавится новая привязка.
          </p>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {objects.map((o) => {
              const checked = draft.includes(o.id)
              return (
                <label key={o.id} className="flex items-center gap-3 text-xs cursor-pointer hover:bg-white px-1 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setDraft((d) => checked ? d.filter((x) => x !== o.id) : [...d, o.id])
                    }}
                    className="shrink-0"
                  />
                  <span className="font-mono text-gray-500 shrink-0 whitespace-nowrap">{o.code}</span>
                  <span className="truncate">{o.current_name}</span>
                </label>
              )
            })}
          </div>
          <div className="flex justify-end gap-2 pt-1 border-t">
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1 text-xs bg-white border rounded hover:bg-gray-50"
            >
              Отмена
            </button>
            <button
              onClick={() => {
                onChangeObjectIds(task, draft)
                setEditing(false)
              }}
              disabled={JSON.stringify(draft.slice().sort()) === JSON.stringify((task.object_ids ?? []).slice().sort())}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              Сохранить привязки
            </button>
          </div>
        </div>
      ) : (task.object_ids ?? []).length === 0 ? (
        <p className="text-xs text-gray-400">Нет объектов. Используйте «Изменить привязки» чтобы добавить.</p>
      ) : (
        <div className="space-y-1">
          {(task.object_ids ?? []).map((oid) => {
            const o = objects.find((x) => x.id === oid)
            const r = objStatusMap.get(`${task.id}|${oid}`)
            const status = (r?.status ?? task.status) as Task['status']
            return (
              <div key={oid} className="flex items-center gap-3 px-2 py-1 bg-gray-50 rounded text-xs">
                <span className="font-mono text-gray-500 shrink-0 whitespace-nowrap">{o?.code ?? oid.slice(0, 8)}</span>
                <span className="flex-1 min-w-0 truncate text-gray-700">{o?.current_name ?? '—'}</span>
                {task.status === 'preliminary' ? (
                  <span className="px-2 py-0.5 rounded bg-gray-200 text-gray-600">Черновик</span>
                ) : (
                  <select
                    value={status}
                    onChange={(e) =>
                      onChangeObjectStatus(task, oid, e.target.value as Exclude<Task['status'], 'preliminary'>)
                    }
                    className={`px-1.5 py-0.5 rounded border text-xs ${STATUS_BADGE[status]}`}
                  >
                    {PER_OBJECT_OPTIONS.map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                )}
                {/* Дата выполнения по объекту — редактируемая, если статус done/closed */}
                {(['done', 'closed'].includes(status) || r?.done_date) && (
                  <input
                    type="date"
                    defaultValue={r?.done_date ?? ''}
                    onBlur={(e) => onChangeObjectDoneDate(task.id, oid, e.target.value)}
                    className="px-1.5 py-0.5 border rounded text-xs text-gray-600"
                    title="Дата выполнения по этому объекту"
                  />
                )}
                {/* Кнопка «✓ Отчитаться» — структурное закрытие задачи на объекте
                    через создание event(project_note) + entity_links(resolved_by).
                    Доступна только если задача ещё активна на этом объекте. */}
                {task.status !== 'preliminary' && ['open', 'in_progress'].includes(status) && (
                  <button
                    onClick={() => onReport(oid)}
                    className="px-2 py-0.5 text-[11px] bg-emerald-600 text-white rounded hover:bg-emerald-700 shrink-0"
                    title="Создать отчёт о выполнении задачи на этом объекте (event + связь resolved_by + закрытие)"
                  >
                    ✓ Отчитаться
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Конфиг фаз — см. const TASK_LINK_PHASES в начале файла.
// Блок отображения переиспользует @/components/EntityLinksBlock.

// ─── Модалка «Отчитаться» ─────────────────────────────────────────────────
// Создаёт отчёт о выполнении задачи на конкретном объекте: новое event'е
// (project_note) + entity_link фазы resolved_by + обновление task_object_status.
// См. WIKI 19_Сущность_Задача «v2.4».

function ReportCompletionModal({
  task,
  objectId,
  objects,
  entities,
  onClose,
  onSubmit,
}: {
  task: Task
  objectId: string
  objects: ObjectRef[]
  entities: LegalEntity[]
  onClose: () => void
  onSubmit: (args: { date: string; note: string; doneByEntityId: string | null }) => Promise<string | null>
}) {
  const obj = objects.find((o) => o.id === objectId)
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [doneByEntityId, setDoneByEntityId] = useState<string>(task.assignee_entity_id ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setSubmitting(true)
    setError(null)
    const err = await onSubmit({ date, note: note.trim(), doneByEntityId: doneByEntityId || null })
    setSubmitting(false)
    if (err) setError(err)
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b">
          <div className="text-[11px] text-gray-500 uppercase tracking-wider">Отчёт о выполнении</div>
          <h2 className="text-lg font-semibold mt-0.5">{task.title}</h2>
          <div className="text-xs text-gray-500 mt-1">
            <span className="font-mono">{task.code}</span>
            {obj && <> · объект: <span className="font-mono">{obj.code}</span> — {obj.current_name}</>}
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Дата выполнения
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              От кого (юр.лицо)
            </label>
            <select
              value={doneByEntityId}
              onChange={(e) => setDoneByEntityId(e.target.value)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              <option value="">— не указано —</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-500 mt-0.5">
              По умолчанию — ответственный из задачи. Можно изменить если отчитывается другая сторона.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Примечание (что сделано, чем подтверждается)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="Краткий комментарий: что сделано, ссылка/название документа-подтверждения, и т.п."
            />
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">
              {error}
            </div>
          )}

          <div className="text-[11px] text-gray-500 bg-gray-50 rounded p-2">
            <b>Что произойдёт при сохранении:</b>
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              <li>Создастся событие «Выполнено: {task.code}» (тип <code>project_note</code>)</li>
              <li>Связь задача → событие с фазой <code>resolved_by</code></li>
              <li>Статус задачи на этом объекте → «Выполнено»</li>
            </ul>
          </div>
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm border rounded hover:bg-gray-50"
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? 'Сохраняется…' : '✓ Отчитаться'}
          </button>
        </div>
      </div>
    </div>
  )
}
