'use client'

import { useEffect, useState, useMemo, use } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

// MDEditor использует браузерные API — отключаем SSR
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })

type Meeting = {
  id: string
  code: string | null
  meeting_date: string
  title: string
  object_ids: string[]
  folder_path: string | null
  transcription_path: string | null
  transcription_resolved_path: string | null
  speaker_map: Record<string, { contact_id?: string | null; label?: string; org?: string }>
  summary_md: string | null
  status: string
  /** Первая успешная публикация протокола в Telegram (meeting_publications). NULL = не публиковали. */
  published_at: string | null
  created_at: string
  updated_at: string
}

type SpeakerInfo = {
  raw: string
  count: number
  samples: string[]
}

type ObjectInfo = {
  id: string
  code: string
  current_name: string
  contractor: string | null
}

type LegalEntity = {
  id: string
  name: string
  aliases: string[]
}

type Contact = {
  id: string
  legal_entity_id: string | null
  last_name: string
  first_name: string
  middle_name: string | null
  job_title: string | null
  is_active: boolean
}

type Quote = { speaker_org: string; text: string }

type Revision = {
  at: string
  by_entity_id: string | null
  by_org_name: string | null
  source: string | null
  note: string | null
  before: Record<string, string | number | null>
  after: Record<string, string | number | null>
}

type Attachment = {
  id: string
  kind: 'video' | 'material' | 'other'
  file_path: string
  filename: string
  size_bytes: number
  content_type: string | null
  indexed_at: string | null
  note: string | null
  created_at: string
}

type Task = {
  id: string
  code: string
  title: string
  explanation: string | null
  status: string
  priority: 'high' | 'medium' | 'low'
  assignee_org: string | null
  due_date: string | null
  done_date?: string | null
  done_note?: string | null
  object_ids: string[]
  quotes: Quote[]
  meeting_id?: string | null         // нужен для фильтрации «прошлые собрания» в Секции 7
  // Правки по замечанию (см. миграцию 20260507000006_protocol_corrections.sql)
  corrected_at: string | null
  corrected_by_entity_id: string | null
  correction_source: string | null
  correction_note: string | null
  revisions: Revision[]
}

type Topic = {
  id: string
  code: string
  seq: number
  title: string
  content: string
  raised_by_org: string | null
  status: string
  object_ids: string[]
  quotes: Quote[]
  discussion_date: string | null   // YYYY-MM-DD; по умолчанию = meeting.meeting_date, может быть сдвинута
  // Правки по замечанию
  corrected_at: string | null
  corrected_by_entity_id: string | null
  correction_source: string | null
  correction_note: string | null
  revisions: Revision[]
}

// Типы ролей юр.лица в собрании. Расширяется значением 'participant' в БД-CHECK
// (см. миграцию 20260508000001_meeting_legal_entities_role.sql).
type LegalEntityRole = 'contractor' | 'customer' | 'operator' | 'investor' | 'expert' | 'participant'
type LegalEntityLink = { id: string; role: LegalEntityRole }

// Локализация и цвета бейджей ролей юр.лица в собрании
// (meeting_legal_entities.role — UUID-driven замена deprecated meetings.contractor_code)
const ROLE_LABELS: Record<string, string> = {
  contractor: 'Подрядчик',
  customer:   'Заказчик',
  operator:   'Оператор',
  investor:   'Инвестор',
  expert:     'Эксперт',
  participant:'Участник',
}
const ROLE_BADGE_CLS: Record<string, string> = {
  contractor: 'bg-blue-100 text-blue-800',
  customer:   'bg-emerald-100 text-emerald-800',
  operator:   'bg-amber-100 text-amber-800',
  investor:   'bg-purple-100 text-purple-800',
  expert:     'bg-pink-100 text-pink-800',
  participant:'bg-gray-100 text-gray-700',
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  planned:              { label: 'Создано',          cls: 'bg-gray-100 text-gray-700' },
  transcript_uploaded:  { label: 'Транскрипт',       cls: 'bg-yellow-100 text-yellow-800' },
  processed:            { label: 'LLM-обработано',   cls: 'bg-purple-100 text-purple-800' },
  approved:             { label: 'Утверждено',       cls: 'bg-green-100 text-green-800' },
  protocoled:           { label: 'Протокол готов',   cls: 'bg-blue-100 text-blue-800' },
}

export default function ProtocolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [objects, setObjects] = useState<ObjectInfo[]>([])
  const [allEntities, setAllEntities] = useState<LegalEntity[]>([])
  const [meetingEntityIds, setMeetingEntityIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Section 2: участники
  // contactsByOrg[legal_entity_id] = массив контактов этой организации
  const [contactsByOrg, setContactsByOrg] = useState<Record<string, Contact[]>>({})
  // selectedContactIds — какие контакты отмечены сейчас (working set)
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set())
  // originalContactIds — что было сохранено в БД при последней load() (для diff)
  const [originalContactIds, setOriginalContactIds] = useState<Set<string>>(new Set())
  const [savingParticipants, setSavingParticipants] = useState(false)
  const [participantsError, setParticipantsError] = useState('')
  const [editingParticipants, setEditingParticipants] = useState(false)

  // Inline-форма «Новый контакт»
  const [newContactOpen, setNewContactOpen] = useState(false)
  const [newContactForm, setNewContactForm] = useState({
    legal_entity_id: '',
    last_name: '',
    first_name: '',
    middle_name: '',
    job_title: '',
  })
  const [savingNewContact, setSavingNewContact] = useState(false)

  // Section 3: транскрипция
  const [transcriptionUploading, setTranscriptionUploading] = useState(false)
  // Переключатель в режим ручного ввода (собрание без записи)
  const [switchingToManual, setSwitchingToManual] = useState(false)
  const [transcriptionError, setTranscriptionError] = useState('')
  const [editingTranscription, setEditingTranscription] = useState(false)

  // Section 4: маппинг спикеров
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([])
  const [speakerMap, setSpeakerMap] = useState<Record<string, { contact_id?: string | null; label?: string; org?: string }>>({})
  const [speakersLoading, setSpeakersLoading] = useState(false)
  const [savingSpeakers, setSavingSpeakers] = useState(false)
  const [speakersError, setSpeakersError] = useState('')
  // Сколько образцов реплик показано на каждого спикера (по умолчанию 3)
  const [shownSamples, setShownSamples] = useState<Record<string, number>>({})

  // LLM-анализ спикеров (см. /api/protocols/[id]/analyze-speakers).
  // Ключ — sp.raw, значение — карточка-предложение от LLM с типизированными цитатами.
  type AnalyzedSpeaker = {
    contact_id?: string
    label?: string
    org?: string
    confidence: 'high' | 'medium' | 'low' | 'ambiguous' | 'unknown'
    evidence: Array<{ type: string; text: string }>
    fio_mention?: string | null
    org_mention?: string | null
    candidates?: Array<{ contact_id: string; label: string; org: string }>
  }
  const [speakerAnalysis, setSpeakerAnalysis] = useState<Record<string, AnalyzedSpeaker>>({})
  const [analyzingSpeakers, setAnalyzingSpeakers] = useState(false)
  const [analyzeError, setAnalyzeError] = useState('')
  // Раскрытые карточки evidence (по умолчанию свёрнуты)
  const [expandedEvidence, setExpandedEvidence] = useState<Record<string, boolean>>({})

  // Лог поэтапной обработки (виден в Секции 3, шаги аплоада + Секции 4 — LLM)
  type LogLine = {
    label: string
    status: 'start' | 'ok' | 'fail'
    ts: number
  }
  const [processLog, setProcessLog] = useState<LogLine[]>([])
  const [processing, setProcessing] = useState(false)
  const [processSummary, setProcessSummary] = useState<{ tasks: number; topics: number } | null>(null)

  // Section 5: ревью preliminary
  const [tasks, setTasks] = useState<Task[]>([])
  const [topics, setTopics] = useState<Topic[]>([])
  const [reviewTab, setReviewTab] = useState<'topics' | 'tasks'>('topics')
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [convertingTopic, setConvertingTopic] = useState<Topic | null>(null)
  const [convertingTask, setConvertingTask] = useState<Task | null>(null)

  // Режим правки утверждённого протокола по замечанию организации
  const [correctionMode, setCorrectionMode] = useState(false)
  const [correctionHeader, setCorrectionHeader] = useState({
    corrected_by_entity_id: '',
    correction_source: 'Telegram',
    correction_note: '',
  })
  // Черновики правок per-id: ключ = id топика/задачи, значение = изменённые поля
  const [correctionTopicDrafts, setCorrectionTopicDrafts] = useState<Record<string, Partial<Topic>>>({})
  const [correctionTaskDrafts, setCorrectionTaskDrafts] = useState<Record<string, Partial<Task>>>({})
  const [applyingCorrection, setApplyingCorrection] = useState(false)
  const [correctionError, setCorrectionError] = useState('')
  // Пометки «удалить по замечанию» в режиме правки. id-шники тем/задач,
  // которые попадут в batch как kind='remove_topic'/'remove_task'. До
  // «Применить» — это просто визуальная пометка карточки, БД не меняется.
  const [correctionTopicRemovals, setCorrectionTopicRemovals] = useState<Set<string>>(new Set())
  const [correctionTaskRemovals, setCorrectionTaskRemovals] = useState<Set<string>>(new Set())
  // Новые задачи, добавленные в режиме правки (попадут в batch как kind='add_task').
  // Хранятся локально до «Применить»; не пишутся в БД до подтверждения батча.
  const [correctionNewTasks, setCorrectionNewTasks] = useState<Task[]>([])
  // UI-состояние формы «+ Добавить задачу по замечанию»
  const [correctionAddingTask, setCorrectionAddingTask] = useState(false)
  const [correctionEnrichDesc, setCorrectionEnrichDesc] = useState('')
  const [correctionEnriching, setCorrectionEnriching] = useState(false)
  const [correctionEnrichError, setCorrectionEnrichError] = useState('')
  // Открытый в модалке черновик новой задачи (из enrich или пустой).
  // editingIdx: -1 — создание новой; >=0 — правка уже добавленной в correctionNewTasks[idx]
  const [correctionNewTaskDraft, setCorrectionNewTaskDraft] = useState<Task | null>(null)
  const [correctionNewTaskEditingIdx, setCorrectionNewTaskEditingIdx] = useState<number>(-1)
  const [creatingItem, setCreatingItem] = useState<'task' | 'topic' | null>(null)
  const [reviewError, setReviewError] = useState('')

  // Section 5.5: закрытие задач прошлых собраний
  const [previousTasks, setPreviousTasks] = useState<Task[]>([])
  // Таб Секции 7: «open» — активные задачи прошлых собраний / «closed» — отмеченные
  // как исполненные на этом собрании (в working set до утверждения).
  const [closingTab, setClosingTab] = useState<'open' | 'closed'>('open')
  // Per-object активные пары (task,object) для объектов собрания. Используется
  // в Секции 7 для отображения чекбоксов на каждый объект задачи.
  // См. WIKI 19_Сущность_Задача → Per-object статусы.
  const [previousTaskObjects, setPreviousTaskObjects] =
    useState<Array<{ task_id: string; object_id: string; status: string }>>([])
  // Map: task_id → Set<object_id> — какие пары (task,object) отмечены к закрытию.
  // Per-object закрытие: одну задачу можно закрыть по части объектов собрания.
  const [closeTaskObjects, setCloseTaskObjects] = useState<Map<string, Set<string>>>(new Map())
  // Задачи прошлых собраний, ЗАКРЫТЫЕ на этом собрании (для блока «ПРИНЯЛИ КАК РЕШЁННЫЕ» в Секции 8)
  const [previouslyClosed, setPreviouslyClosed] = useState<Task[]>([])

  // Section 6: утверждение
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState('')

  // Section 5: файлы к протоколу
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const [attachmentKind, setAttachmentKind] = useState<'video' | 'material' | 'other'>('material')

  // Section 9: публикация в Telegram-чаты
  type PublishChat = {
    chat_id: number
    title: string
    object_code: string | null
    object_name: string | null
    already_published: boolean
  }
  type PublishResult = {
    chat_id: number
    title: string
    object_code: string | null
    status: 'ok' | 'fail'
    message_id?: number
    error?: string
  }
  const [publishModalOpen, setPublishModalOpen] = useState(false)
  const [publishLoading, setPublishLoading] = useState(false)
  const [publishStage, setPublishStage] = useState<'preview' | 'sending' | 'done'>('preview')
  const [publishCaption, setPublishCaption] = useState('')
  const [publishChats, setPublishChats] = useState<PublishChat[]>([])
  const [publishResults, setPublishResults] = useState<PublishResult[]>([])
  const [publishError, setPublishError] = useState('')

  // Section 10: резюме встречи
  const [summaryDraft, setSummaryDraft] = useState('')
  const [summaryDirty, setSummaryDirty] = useState(false)
  const [summaryGenerating, setSummaryGenerating] = useState(false)
  const [summarySaving, setSummarySaving] = useState(false)
  const [summaryError, setSummaryError] = useState('')

  // Form state for Section 1 (editable metadata)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<{
    meeting_date: string
    title: string
    object_ids: string[]
    legal_entities: LegalEntityLink[]
  }>({
    meeting_date: '',
    title: '',
    object_ids: [],
    legal_entities: [],
  })
  const [saving, setSaving] = useState(false)
  // Сохранённые на момент load пары (entity_id, role) — нужны для diff в save
  const [meetingEntityRoles, setMeetingEntityRoles] = useState<Record<string, LegalEntityRole>>({})
  // Создано ли событие «Собрание проведено» (entity_link event→meeting). Используется
  // в шапке готовности (ReadinessPanel). Событие синхронизируется DB-триггером
  // `meetings_sync_event_trg`; флаг подгружается из БД при load().
  const [meetingEventExists, setMeetingEventExists] = useState<boolean>(false)

  useEffect(() => {
    load({ showSpinner: true })
  }, [id])

  // Подгружаем уникальных спикеров когда есть транскрипция
  useEffect(() => {
    if (meeting?.transcription_path && speakers.length === 0 && !speakersLoading) {
      void loadSpeakers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting?.transcription_path])

  async function load(opts: { showSpinner?: boolean } = {}) {
    if (opts.showSpinner) setLoading(true)
    const [mRes, oRes, eRes, leRes, mpRes, cRes, tRes, tpRes, aRes] = await Promise.all([
      supabase.from('meetings').select('*').eq('id', id).single(),
      supabase
        .from('objects')
        .select('id,code,current_name,contractor')
        .eq('active', true)
        .order('code'),
      supabase.from('legal_entities').select('id,name,aliases').order('name'),
      supabase
        .from('meeting_legal_entities')
        .select('legal_entity_id, seq, role')
        .eq('meeting_id', id)
        .order('seq', { ascending: true, nullsFirst: false }),
      supabase
        .from('meeting_participants')
        .select('contact_id')
        .eq('meeting_id', id),
      // Все активные контакты — фильтруем по юр.лицам собрания в JS ниже.
      // Объём небольшой (~20 строк), плюс это позволяет инкрементально добавлять
      // юр.лица в метаданных без повторного reload контактов.
      supabase
        .from('contacts')
        .select('id,legal_entity_id,last_name,first_name,middle_name,job_title,is_active')
        .eq('is_active', true)
        .order('last_name'),
      supabase
        .from('tasks')
        .select('id,code,title,explanation,status,priority,assignee_org,due_date,object_ids,quotes,corrected_at,corrected_by_entity_id,correction_source,correction_note,revisions')
        .eq('meeting_id', id)
        .order('code'),
      supabase
        .from('meeting_topics')
        .select('id,code,seq,title,content,raised_by_org,status,object_ids,quotes,discussion_date,corrected_at,corrected_by_entity_id,correction_source,correction_note,revisions')
        .eq('meeting_id', id)
        .order('seq'),
      supabase
        .from('meeting_attachments')
        .select('id,kind,file_path,filename,size_bytes,content_type,indexed_at,note,created_at')
        .eq('meeting_id', id)
        .order('created_at', { ascending: false }),
    ])
    if (mRes.error)  setError(mRes.error.message)
    if (oRes.error)  console.error('objects load:', oRes.error)
    if (eRes.error)  console.error('legal_entities load:', eRes.error)
    if (leRes.error) console.error('meeting_legal_entities load:', leRes.error)
    if (mpRes.error) console.error('meeting_participants load:', mpRes.error)
    if (cRes.error)  console.error('contacts load:', cRes.error)

    let entityIds: string[] = []
    if (mRes.data) {
      const m = mRes.data as Meeting
      m.object_ids = Array.isArray(m.object_ids) ? m.object_ids : []
      m.speaker_map = (m.speaker_map ?? {}) as Meeting['speaker_map']
      setMeeting(m)
      setSpeakerMap(m.speaker_map)
      setSummaryDraft(m.summary_md ?? '')
      setSummaryDirty(false)

      const leRows = (leRes.data ?? []) as Array<{ legal_entity_id: string; role: string | null; seq: number | null }>
      entityIds = leRows.map((r) => r.legal_entity_id)
      setMeetingEntityIds(entityIds)
      const rolesMap: Record<string, LegalEntityRole> = {}
      const formLes: LegalEntityLink[] = []
      for (const r of leRows) {
        const role = (r.role ?? 'participant') as LegalEntityRole
        rolesMap[r.legal_entity_id] = role
        formLes.push({ id: r.legal_entity_id, role })
      }
      setMeetingEntityRoles(rolesMap)

      setForm({
        meeting_date: m.meeting_date,
        title: m.title,
        object_ids: m.object_ids,
        legal_entities: formLes,
      })
    }
    setObjects((oRes.data || []) as ObjectInfo[])
    const ents = ((eRes.data || []) as Array<{ id: string; name: string; aliases: unknown }>).map(
      (e) => ({ id: e.id, name: e.name, aliases: Array.isArray(e.aliases) ? (e.aliases as string[]) : [] })
    )
    setAllEntities(ents)

    // Section 2: группируем контакты по legal_entity_id, фильтруя по юр.лицам собрания
    const entitySet = new Set(entityIds)
    const grouped: Record<string, Contact[]> = {}
    for (const c of (cRes.data || []) as Contact[]) {
      if (!c.legal_entity_id) continue
      if (!entitySet.has(c.legal_entity_id)) continue
      if (!grouped[c.legal_entity_id]) grouped[c.legal_entity_id] = []
      grouped[c.legal_entity_id].push(c)
    }
    setContactsByOrg(grouped)

    const checked = new Set<string>(
      (mpRes.data ?? []).map((r: { contact_id: string }) => r.contact_id),
    )
    setSelectedContactIds(checked)
    setOriginalContactIds(new Set(checked))

    // Section 5: tasks + topics (фильтры — не утверждённые отображаем как preliminary,
    // утверждённые — как readonly результат)
    if (tRes.error) console.error('tasks load:', tRes.error)
    if (tpRes.error) console.error('meeting_topics load:', tpRes.error)
    // Существует ли уже событие «Собрание проведено» (для Section 8 recovery)
    {
      const { data: evLink } = await supabase
        .from('entity_links')
        .select('from_id')
        .eq('from_type', 'event')
        .eq('to_type', 'meeting')
        .eq('to_id', id)
        .eq('link_type', 'from_meeting')
        .maybeSingle()
      setMeetingEventExists(Boolean(evLink))
    }

    setTasks(((tRes.data || []) as Task[]).map((t) => ({
      ...t,
      object_ids: Array.isArray(t.object_ids) ? t.object_ids : [],
      quotes: Array.isArray(t.quotes) ? (t.quotes as Quote[]) : [],
      revisions: Array.isArray(t.revisions) ? (t.revisions as Revision[]) : [],
    })))
    setTopics(((tpRes.data || []) as Topic[]).map((t) => ({
      ...t,
      object_ids: Array.isArray(t.object_ids) ? t.object_ids : [],
      quotes: Array.isArray(t.quotes) ? (t.quotes as Quote[]) : [],
      revisions: Array.isArray(t.revisions) ? (t.revisions as Revision[]) : [],
    })))

    if (aRes?.error) console.error('meeting_attachments load:', aRes.error)
    setAttachments((aRes?.data ?? []) as Attachment[])

    // Section 5.5: открытые задачи прошлых собраний по тем же объектам
    const meetingObjectIds = (mRes.data?.object_ids ?? []) as string[]
    const meetingDate = mRes.data?.meeting_date as string | undefined

    if (meetingObjectIds.length > 0) {
      // Per-object: ищем активные пары (task,object) для объектов собрания
      // через task_object_status. Из них берём task_ids для подгрузки метаданных.
      // См. WIKI 19_Сущность_Задача → Per-object статусы.
      const [{ data: activeTos, error: activeErr }, { data: closedTos, error: closedTosErr }] = await Promise.all([
        supabase
          .from('task_object_status')
          .select('task_id, object_id, status')
          .in('object_id', meetingObjectIds)
          .in('status', ['open', 'in_progress']),
        meetingDate
          ? supabase
              .from('task_object_status')
              .select('task_id, object_id, status, done_date')
              .in('object_id', meetingObjectIds)
              .in('status', ['done', 'closed'])
              .eq('done_date', meetingDate)
          : Promise.resolve({ data: [], error: null }),
      ])
      if (activeErr) console.error('previous task_object_status load:', activeErr)
      if (closedTosErr) console.error('closed task_object_status load:', closedTosErr)

      const activeRows = (activeTos as Array<{ task_id: string; object_id: string; status: string }>) || []
      const closedRows = (closedTos as Array<{ task_id: string; object_id: string; status: string; done_date: string }>) || []

      // task_ids из активных пар. Исключаем задачи текущего собрания (фильтр по
      // tasks.meeting_id выполним после загрузки).
      const allTaskIds = [...new Set([...activeRows.map((r) => r.task_id), ...closedRows.map((r) => r.task_id)])]
      let metaById = new Map<string, Task>()
      if (allTaskIds.length > 0) {
        const meta = await supabase
          .from('tasks')
          .select('id,code,title,explanation,status,priority,assignee_org,due_date,object_ids,quotes,done_date,done_note,meeting_id')
          .in('id', allTaskIds)
        const rows = ((meta.data || []) as Task[]).map((t) => ({
          ...t,
          object_ids: Array.isArray(t.object_ids) ? t.object_ids : [],
          quotes: Array.isArray(t.quotes) ? (t.quotes as Quote[]) : [],
        }))
        for (const t of rows) metaById.set(t.id, t)
      }

      // Активные пары → previousTaskObjects (для UI чекбоксов).
      // Исключаем пары где task привязан к текущему собранию (meeting_id=id).
      const filteredActive = activeRows.filter((r) => {
        const t = metaById.get(r.task_id)
        return t && t.meeting_id !== id
      })
      setPreviousTaskObjects(filteredActive)

      // Уникальные task'и из этих активных пар — для UI группировки и метаданных
      const activeTaskIds = [...new Set(filteredActive.map((r) => r.task_id))]
      setPreviousTasks(activeTaskIds.map((tid) => metaById.get(tid)).filter((t): t is Task => Boolean(t)))

      // Уже закрытые в дату собрания (для блока «уже закрыто N»)
      const closedTaskIds = [...new Set(closedRows.map((r) => r.task_id))]
      setPreviouslyClosed(closedTaskIds.map((tid) => metaById.get(tid)).filter((t): t is Task => Boolean(t)))
    } else {
      setPreviousTasks([])
      setPreviousTaskObjects([])
      setPreviouslyClosed([])
    }

    setLoading(false)
  }

  // ─── Section 2: участники ─────────────────────────────────────────────

  function toggleContact(contactId: string) {
    setSelectedContactIds((prev) => {
      const next = new Set(prev)
      if (next.has(contactId)) next.delete(contactId)
      else next.add(contactId)
      return next
    })
  }

  function toggleAllInOrg(orgId: string, allOn: boolean) {
    const orgContacts = contactsByOrg[orgId] || []
    setSelectedContactIds((prev) => {
      const next = new Set(prev)
      for (const c of orgContacts) {
        if (allOn) next.delete(c.id)
        else next.add(c.id)
      }
      return next
    })
  }

  const participantsDirty =
    selectedContactIds.size !== originalContactIds.size ||
    [...selectedContactIds].some((x) => !originalContactIds.has(x))

  async function saveParticipants() {
    setSavingParticipants(true)
    setParticipantsError('')
    const toAdd = [...selectedContactIds].filter((x) => !originalContactIds.has(x))
    const toRemove = [...originalContactIds].filter((x) => !selectedContactIds.has(x))

    if (toRemove.length > 0) {
      const { error: e } = await supabase
        .from('meeting_participants')
        .delete()
        .eq('meeting_id', id)
        .in('contact_id', toRemove)
      if (e) {
        setSavingParticipants(false)
        setParticipantsError(`Не удалось удалить: ${e.message}`)
        return
      }
    }
    if (toAdd.length > 0) {
      const links = toAdd.map((contact_id) => ({ meeting_id: id, contact_id }))
      const { error: e } = await supabase.from('meeting_participants').insert(links)
      if (e) {
        setSavingParticipants(false)
        setParticipantsError(`Не удалось добавить: ${e.message}`)
        return
      }
    }
    setOriginalContactIds(new Set(selectedContactIds))
    setSavingParticipants(false)
    setEditingParticipants(false)
  }

  function cancelParticipants() {
    setSelectedContactIds(new Set(originalContactIds))
    setEditingParticipants(false)
    setParticipantsError('')
  }

  function openNewContact() {
    setNewContactForm({
      legal_entity_id: meetingEntityIds[0] ?? '',
      last_name: '',
      first_name: '',
      middle_name: '',
      job_title: '',
    })
    setNewContactOpen(true)
    setParticipantsError('')
  }

  function closeNewContact() {
    setNewContactOpen(false)
    setParticipantsError('')
  }

  async function saveNewContact() {
    setSavingNewContact(true)
    setParticipantsError('')
    const payload = {
      legal_entity_id: newContactForm.legal_entity_id,
      last_name: newContactForm.last_name.trim(),
      first_name: newContactForm.first_name.trim(),
      middle_name: newContactForm.middle_name?.trim() || null,
      job_title: newContactForm.job_title?.trim() || null,
      is_active: true,
    }
    if (!payload.legal_entity_id) {
      setParticipantsError('Выберите юр.лицо')
      setSavingNewContact(false)
      return
    }
    if (!payload.last_name || !payload.first_name) {
      setParticipantsError('Фамилия и имя обязательны')
      setSavingNewContact(false)
      return
    }

    const { data, error: e } = await supabase
      .from('contacts')
      .insert(payload)
      .select('id,legal_entity_id,last_name,first_name,middle_name,job_title,is_active')
      .single()
    setSavingNewContact(false)
    if (e || !data) {
      if (e?.code === '23505') {
        setParticipantsError('Контакт с таким ФИО уже есть в этой организации')
      } else {
        setParticipantsError(e?.message ?? 'Не удалось создать контакт')
      }
      return
    }

    // Локально добавляем контакт в группу
    const c = data as Contact
    setContactsByOrg((prev) => {
      const list = prev[c.legal_entity_id ?? ''] ?? []
      return {
        ...prev,
        [c.legal_entity_id ?? '']: [...list, c].sort((a, b) =>
          a.last_name.localeCompare(b.last_name),
        ),
      }
    })
    // Сразу отмечаем
    setSelectedContactIds((prev) => {
      const next = new Set(prev)
      next.add(c.id)
      return next
    })
    setNewContactOpen(false)
  }

  // ─── Section 5: ревью preliminary ─────────────────────────────────────

  async function saveTopic(t: Topic) {
    setReviewError('')
    const payload = {
      title: t.title,
      content: t.content,
      raised_by_org: t.raised_by_org,
      object_ids: t.object_ids,
      quotes: t.quotes,
      discussion_date: t.discussion_date,
    }
    const { error: e } = await supabase.from('meeting_topics').update(payload).eq('id', t.id)
    if (e) {
      setReviewError(e.message)
      return false
    }
    await load()
    setEditingTopic(null)
    return true
  }

  async function saveTask(t: Task) {
    setReviewError('')
    const payload = {
      title: t.title,
      explanation: t.explanation,
      assignee_org: t.assignee_org,
      due_date: t.due_date,
      priority: t.priority,
      object_ids: t.object_ids,
      quotes: t.quotes,
    }
    const { error: e } = await supabase.from('tasks').update(payload).eq('id', t.id)
    if (e) {
      setReviewError(e.message)
      return false
    }
    await load()
    setEditingTask(null)
    return true
  }

  async function deleteTopic(t: Topic) {
    if (!confirm(`Удалить тему «${t.title}»?`)) return
    const { error: e } = await supabase
      .from('meeting_topics')
      .update({ status: 'removed' })
      .eq('id', t.id)
    if (e) setReviewError(e.message)
    else await load()
  }

  async function deleteTask(t: Task) {
    if (!confirm(`Удалить задачу «${t.title}»?`)) return
    const { error: e } = await supabase.from('tasks').delete().eq('id', t.id)
    if (e) setReviewError(e.message)
    else await load()
  }

  /** Убирает один объект из привязки темы (без открытия редактора). */
  async function removeTopicObject(topicId: string, objectId: string) {
    const topic = topics.find((t) => t.id === topicId)
    if (!topic) return
    const newIds = topic.object_ids.filter((oid) => oid !== objectId)
    // Оптимистично обновляем локальный state
    setTopics((prev) => prev.map((t) => t.id === topicId ? { ...t, object_ids: newIds } : t))
    const { error } = await supabase
      .from('meeting_topics')
      .update({ object_ids: newIds })
      .eq('id', topicId)
    if (error) {
      // Откатываем
      setTopics((prev) => prev.map((t) => t.id === topicId ? { ...t, object_ids: topic.object_ids } : t))
      setReviewError(`Не удалось убрать объект: ${error.message}`)
    }
  }

  /** Убирает один объект из привязки задачи (без открытия редактора). */
  async function removeTaskObject(taskId: string, objectId: string) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    const newIds = task.object_ids.filter((oid) => oid !== objectId)
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, object_ids: newIds } : t))
    const { error } = await supabase
      .from('tasks')
      .update({ object_ids: newIds })
      .eq('id', taskId)
    if (error) {
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, object_ids: task.object_ids } : t))
      setReviewError(`Не удалось убрать объект: ${error.message}`)
    }
  }

  async function createTopic(draft: Partial<Topic>) {
    setReviewError('')
    const code = await nextTopicCode()
    const seq = topics.filter((x) => x.status !== 'removed').length + 1
    const payload = {
      meeting_id: id,
      code,
      seq,
      title: draft.title ?? '',
      content: draft.content ?? '',
      raised_by_org: draft.raised_by_org ?? null,
      object_ids: draft.object_ids ?? [],
      quotes: draft.quotes ?? [],
      status: 'preliminary',
      discussion_date: draft.discussion_date ?? meeting?.meeting_date ?? null,
    }
    const { error: e } = await supabase.from('meeting_topics').insert(payload)
    if (e) {
      setReviewError(e.message)
      return false
    }
    await load()
    setCreatingItem(null)
    return true
  }

  async function createTask(draft: Partial<Task>) {
    setReviewError('')
    const code = await nextTaskCode()
    const payload = {
      code,
      meeting_id: id,
      title: draft.title ?? '',
      explanation: draft.explanation ?? '',
      assignee_org: draft.assignee_org ?? null,
      due_date: draft.due_date ?? null,
      priority: draft.priority ?? 'medium',
      object_ids: draft.object_ids ?? [],
      quotes: draft.quotes ?? [],
      status: 'preliminary',
      // Источник = meeting_id (denormalized FK). entity_links(raised_from) создастся
      // триггером tasks_init_raised_from. См. WIKI 19_Сущность_Задача «v2.4».
      tags: ['protocol'],
    }
    const { error: e } = await supabase.from('tasks').insert(payload)
    if (e) {
      setReviewError(e.message)
      return false
    }
    await load()
    setCreatingItem(null)
    return true
  }

  /**
   * Режим правки: «+ Добавить задачу по замечанию» — обогащает по транскрипции
   * краткое описание пользователя через LLM, открывает TaskEditor с черновиком.
   * Если транскрипции нет (manual entry) — кнопка-скип «Заполнить вручную».
   */
  async function enrichTaskForCorrection() {
    const desc = correctionEnrichDesc.trim()
    if (!desc) return
    setCorrectionEnriching(true)
    setCorrectionEnrichError('')
    try {
      const res = await fetch(`/api/protocols/${id}/enrich-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: desc }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      openNewTaskDraftFromEnrich(data)
    } catch (e) {
      setCorrectionEnrichError(e instanceof Error ? e.message : String(e))
    } finally {
      setCorrectionEnriching(false)
    }
  }

  function openNewTaskDraftFromEnrich(data: {
    title?: string
    explanation?: string
    assignee_org?: string | null
    due_date?: string | null
    priority?: 'high' | 'medium' | 'low'
    object_ids?: string[]
    quotes?: Array<{ speaker_org?: string; text?: string }>
    found_in_transcript?: boolean
  }) {
    const fallbackOrg = correctionHeader.corrected_by_entity_id
      ? meetingEntities.find((e) => e.id === correctionHeader.corrected_by_entity_id)?.name ?? null
      : null
    setCorrectionNewTaskDraft({
      id: '',
      code: '',
      title: data.title ?? '',
      explanation: data.explanation ?? '',
      status: 'preliminary',
      priority: data.priority ?? 'medium',
      assignee_org: data.assignee_org ?? fallbackOrg,
      due_date: data.due_date ?? null,
      object_ids: Array.isArray(data.object_ids)
        ? data.object_ids
        : meeting?.object_ids ?? [],
      quotes: Array.isArray(data.quotes)
        ? data.quotes.map((q) => ({
            speaker_org: q.speaker_org ?? '?',
            text: q.text ?? '',
          }))
        : [],
      corrected_at: null,
      corrected_by_entity_id: null,
      correction_source: null,
      correction_note: null,
      revisions: [],
    } as Task)
    setCorrectionNewTaskEditingIdx(-1)
  }

  function openNewTaskDraftEmpty() {
    openNewTaskDraftFromEnrich({})
  }

  function saveNewTaskDraft(t: Task): Promise<boolean> {
    if (!t.title.trim()) return Promise.resolve(false)
    if (correctionNewTaskEditingIdx >= 0) {
      // Редактирование уже добавленного черновика
      setCorrectionNewTasks((prev) => {
        const next = prev.slice()
        next[correctionNewTaskEditingIdx] = t
        return next
      })
    } else {
      // Новый черновик
      setCorrectionNewTasks((prev) => [...prev, t])
    }
    setCorrectionNewTaskDraft(null)
    setCorrectionNewTaskEditingIdx(-1)
    setCorrectionAddingTask(false)
    setCorrectionEnrichDesc('')
    setCorrectionEnrichError('')
    return Promise.resolve(true)
  }

  /** Получает следующий свободный код для темы текущего собрания. */
  async function nextTopicCode(): Promise<string> {
    const base = `${meeting?.code ?? `ПРОТ-${meeting?.meeting_date ?? ''}`}-ОБС`
    const seqs = topics
      .map((t) => t.code.match(new RegExp(`^${escapeRegex(base)}-(\\d+)$`))?.[1])
      .filter(Boolean)
      .map((s) => Number(s))
    const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1
    return `${base}-${String(next).padStart(2, '0')}`
  }

  async function nextTaskCode(): Promise<string> {
    const base = `${meeting?.code ?? `ПРОТ-${meeting?.meeting_date ?? ''}`}-ЗАД`
    const seqs = tasks
      .map((t) => t.code.match(new RegExp(`^${escapeRegex(base)}-(\\d+)$`))?.[1])
      .filter(Boolean)
      .map((s) => Number(s))
    const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1
    return `${base}-${String(next).padStart(2, '0')}`
  }

  function escapeRegex(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // ─── Section 6: утверждение ───────────────────────────────────────────

  /**
   * Закрытие выбранных задач прошлых собраний.
   * Работает независимо от статуса собрания (processed / approved / protocoled) —
   * пользователь может вернуться и закрыть ещё задачи даже после утверждения.
   */
  const [closingNow, setClosingNow] = useState(false)

  async function closeSelectedTasks() {
    if (!meeting || closeCount === 0) return
    if (!confirm(
      `Закрыть ${closeCount} пар (задача × объект) как выполненные на этом собрании? ` +
      `Соответствующие записи в task_object_status получат статус «done» с датой ${meeting.meeting_date}.`,
    )) return

    setClosingNow(true)
    const sourceProto = meeting.code ?? `ПРОТ-${meeting.meeting_date}`
    const note = `Подтверждено выполнение на собрании ${sourceProto}`

    // Готовим строки UPSERT: одна на пару (task,object)
    const rows: Array<{
      task_id: string
      object_id: string
      status: 'done'
      done_date: string
      done_note: string
    }> = []
    for (const [taskId, objs] of closeTaskObjects.entries()) {
      for (const objectId of objs) {
        rows.push({
          task_id: taskId,
          object_id: objectId,
          status: 'done',
          done_date: meeting.meeting_date as string,
          done_note: note,
        })
      }
    }

    const { error: e } = await supabase
      .from('task_object_status')
      .upsert(rows, { onConflict: 'task_id,object_id' })
    setClosingNow(false)
    if (e) {
      setApproveError(`Не удалось закрыть задачи: ${e.message}`)
      return
    }
    setCloseTaskObjects(new Map())
    await load()
  }

  async function approveAll() {
    const prelimTasks = tasks.filter((t) => t.status === 'preliminary').length
    const prelimTopics = topics.filter((t) => t.status === 'preliminary').length
    const closingCount = closeCount

    // Hard pre-check: без объектов DB-триггер `meetings_sync_event_trg` не создаёт
    // событие в журнале (см. миграцию 20260514000001). Блокируем утверждение, чтобы
    // не получить собрание-сироту без события.
    if (!meeting || !meeting.object_ids || meeting.object_ids.length === 0) {
      setApproveError('Сначала выберите объекты собрания в Секции 1 — без них не создаётся событие в журнале проекта.')
      return
    }

    // Soft-warning: нет ни одного юр.лица с ролью contractor. Не блокируем
    // (бывают customer-only собрания: заказчик с инвестором без подрядчика),
    // но просим явное подтверждение.
    const hasContractor = Object.values(meetingEntityRoles).includes('contractor')
    if (!hasContractor) {
      if (!confirm('Среди юр.лиц нет подрядчика (role=contractor). Это намеренно? Утвердить?')) return
    }

    const message =
      prelimTasks + prelimTopics + closingCount === 0
        ? 'Перевести собрание в статус «approved» без изменений в задачах и темах?'
        : `Утвердить ${prelimTasks} задач и ${prelimTopics} тем` +
          (closingCount > 0 ? ` и закрыть ${closingCount} пар (задача × объект) прошлых собраний` : '') +
          '? Они станут активными.'

    if (!confirm(message)) return

    setApproving(true)
    setApproveError('')

    // 1) Темы preliminary → approved
    const { error: e1 } = await supabase
      .from('meeting_topics')
      .update({ status: 'approved' })
      .eq('meeting_id', id)
      .eq('status', 'preliminary')
    if (e1) {
      setApproveError(e1.message)
      setApproving(false)
      return
    }

    // 2) Задачи preliminary → open. Триггер trg_tasks_sync_status создаст
    // строки task_object_status для каждого object_id задачи.
    const { error: e2 } = await supabase
      .from('tasks')
      .update({ status: 'open' })
      .eq('meeting_id', id)
      .eq('status', 'preliminary')
    if (e2) {
      setApproveError(e2.message)
      setApproving(false)
      return
    }

    // 3) Закрытия из Секции 7 (per-object) — UPSERT в junction
    if (closeCount > 0 && meeting) {
      const sourceProto = meeting.code ?? `ПРОТ-${meeting.meeting_date}`
      const note = `Подтверждено выполнение на собрании ${sourceProto}`
      const rows: Array<{ task_id: string; object_id: string; status: 'done'; done_date: string; done_note: string }> = []
      for (const [taskId, objs] of closeTaskObjects.entries()) {
        for (const objectId of objs) {
          rows.push({
            task_id: taskId,
            object_id: objectId,
            status: 'done',
            done_date: meeting.meeting_date as string,
            done_note: note,
          })
        }
      }
      const { error: eClose } = await supabase
        .from('task_object_status')
        .upsert(rows, { onConflict: 'task_id,object_id' })
      if (eClose) {
        setApproveError(`Не удалось закрыть задачи прошлых собраний: ${eClose.message}`)
        setApproving(false)
        return
      }
      setCloseTaskObjects(new Map())
    }

    // 4) Статус собрания. Событие «Собрание проведено» создаётся автоматически
    //    Postgres-триггером `meetings_sync_event_trg` (см. миграцию
    //    20260514000001_meetings_sync_event.sql) при переходе в approved/protocoled
    //    с непустым object_ids.
    const { error: e3 } = await supabase
      .from('meetings')
      .update({ status: 'approved' })
      .eq('id', id)
    if (e3) setApproveError(e3.message)

    setApproving(false)
    await load()
  }

  // Toggle per-object closure для одной пары (task, object)
  function togglePrevTaskObject(taskId: string, objectId: string) {
    setCloseTaskObjects((prev) => {
      const next = new Map(prev)
      const objs = new Set(next.get(taskId) ?? [])
      if (objs.has(objectId)) objs.delete(objectId)
      else objs.add(objectId)
      if (objs.size === 0) next.delete(taskId)
      else next.set(taskId, objs)
      return next
    })
  }

  // Total count: количество отмеченных к закрытию пар (task,object)
  const closeCount = useMemo(() => {
    let n = 0
    for (const objs of closeTaskObjects.values()) n += objs.size
    return n
  }, [closeTaskObjects])

  // ─── Section 9: файлы к протоколу ─────────────────────────────────────

  async function uploadAttachment(file: File) {
    setAttachmentUploading(true)
    setAttachmentError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', attachmentKind)
      const res = await fetch(`/api/protocols/${id}/upload-attachment`, {
        method: 'POST',
        body: fd,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : String(e))
    } finally {
      setAttachmentUploading(false)
    }
  }

  async function deleteAttachment(att: Attachment) {
    if (!confirm(`Удалить «${att.filename}»? Файл будет физически удалён.`)) return
    const res = await fetch(`/api/protocols/${id}/attachments/${att.id}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      setAttachmentError(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  // ─── Section 9: публикация в Telegram ─────────────────────────────────

  /**
   * Открывает модал-предпросмотр: dry-run-запрос → получаем список чатов
   * и текст преамбулы без реальной отправки. Если чатов нет / нет объектов —
   * показываем ошибку прямо в модале.
   */
  async function openPublishModal() {
    setPublishModalOpen(true)
    setPublishStage('preview')
    setPublishError('')
    setPublishResults([])
    setPublishLoading(true)
    try {
      const res = await fetch(`/api/protocols/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setPublishCaption(data.caption ?? '')
      setPublishChats(data.chats ?? [])
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishLoading(false)
    }
  }

  async function confirmPublish() {
    setPublishStage('sending')
    setPublishLoading(true)
    setPublishError('')
    try {
      const res = await fetch(`/api/protocols/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: false }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setPublishResults(data.results ?? [])
      setPublishStage('done')
      // Обновляем published_at в state
      await load()
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
      setPublishStage('preview')
    } finally {
      setPublishLoading(false)
    }
  }

  function closePublishModal() {
    setPublishModalOpen(false)
    setPublishStage('preview')
    setPublishCaption('')
    setPublishChats([])
    setPublishResults([])
    setPublishError('')
  }

  // ─── Section 10: резюме встречи ────────────────────────────────────────

  async function generateSummary() {
    if (summaryDirty && !confirm('У вас есть несохранённые правки. Сгенерировать заново и потерять их?')) {
      return
    }
    setSummaryGenerating(true)
    setSummaryError('')
    try {
      const res = await fetch(`/api/protocols/${id}/summary/generate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      const md = (json.summary_md as string) ?? ''
      setSummaryDraft(md)
      setSummaryDirty(false)
      setMeeting((prev) => (prev ? { ...prev, summary_md: md } : prev))
    } catch (e) {
      setSummaryError((e as Error).message)
    } finally {
      setSummaryGenerating(false)
    }
  }

  async function saveSummary() {
    setSummarySaving(true)
    setSummaryError('')
    try {
      const res = await fetch(`/api/protocols/${id}/summary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary_md: summaryDraft }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setSummaryDirty(false)
      setMeeting((prev) => (prev ? { ...prev, summary_md: summaryDraft } : prev))
    } catch (e) {
      setSummaryError((e as Error).message)
    } finally {
      setSummarySaving(false)
    }
  }

  // ─── Section 3: транскрипция + автозапуск LLM-обработки ───────────────

  function appendLog(line: Omit<LogLine, 'ts'>) {
    setProcessLog((prev) => [...prev, { ...line, ts: Date.now() }])
  }

  function updateLastLog(status: 'ok' | 'fail') {
    setProcessLog((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      next[next.length - 1] = { ...next[next.length - 1], status }
      return next
    })
  }

  async function uploadOnly(file: File) {
    setTranscriptionUploading(true)
    setTranscriptionError('')
    setProcessLog([])
    setProcessSummary(null)

    appendLog({ label: 'Загрузка файла на сервер…', status: 'start' })
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/protocols/${id}/upload-transcription`, {
        method: 'POST',
        body: fd,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      updateLastLog('ok')
      appendLog({
        label: `Файл загружен: ${json.saved_name} (${formatSize(file.size)})`,
        status: 'ok',
      })
    } catch (e) {
      updateLastLog('fail')
      const msg = e instanceof Error ? e.message : String(e)
      setTranscriptionError(`Загрузка: ${msg}`)
      setTranscriptionUploading(false)
      return
    }
    setTranscriptionUploading(false)
    await load()
    setEditingTranscription(false)
    // Подгружаем спикеров (для CSV) — Секция 4 покажет маппинг
    void loadSpeakers()
  }

  // Переключение в режим ручного ввода: транскрипции нет, LLM-обработка пропускается,
  // пользователь сам набивает темы и задачи в Секции 6. Признак режима — status='processed'
  // при transcription_path IS NULL (никаких новых полей в схеме не требуется).
  async function switchToManualEntry() {
    if (!confirm(
      'Перевести собрание в режим ручного ввода?\n\n' +
      'Шаг 3 «Транскрипция» и Шаг 4 «Маппинг + LLM» будут пропущены. ' +
      'Темы «Обсудили» и задачи нужно будет добавить вручную в Секции 6 кнопками «+ Добавить».\n\n' +
      'Если позже появится запись — можно будет загрузить транскрипцию задним числом.',
    )) return
    setSwitchingToManual(true)
    setTranscriptionError('')
    try {
      const { error } = await supabase
        .from('meetings')
        .update({ status: 'processed' })
        .eq('id', id)
      if (error) {
        setTranscriptionError(`Не удалось переключить в режим ручного ввода: ${error.message}`)
        return
      }
      await load()
    } finally {
      setSwitchingToManual(false)
    }
  }

  async function loadSpeakers() {
    setSpeakersLoading(true)
    setSpeakersError('')
    try {
      const res = await fetch(`/api/protocols/${id}/speakers`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setSpeakers(json.speakers ?? [])
    } catch (e) {
      setSpeakersError(e instanceof Error ? e.message : String(e))
      setSpeakers([])
    } finally {
      setSpeakersLoading(false)
    }
  }

  async function saveSpeakerMap() {
    setSavingSpeakers(true)
    setSpeakersError('')
    const { error: e } = await supabase
      .from('meetings')
      .update({ speaker_map: speakerMap })
      .eq('id', id)
    setSavingSpeakers(false)
    if (e) {
      setSpeakersError(e.message)
      return false
    }
    await load()
    return true
  }

  /**
   * LLM-распознавание спикеров. Вызывает /analyze-speakers, складывает
   * результат в speakerAnalysis. Не пишет в БД и не меняет speakerMap —
   * пользователь явно нажимает «✓ Применить» на каждой карточке-предложении.
   */
  async function analyzeSpeakersLLM() {
    setAnalyzingSpeakers(true)
    setAnalyzeError('')
    try {
      const res = await fetch(`/api/protocols/${id}/analyze-speakers`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setSpeakerAnalysis(json.speakers ?? {})
      // Авто-раскрытие evidence для всех непустых предложений
      const next: Record<string, boolean> = {}
      for (const [raw, item] of Object.entries(json.speakers ?? {})) {
        if ((item as AnalyzedSpeaker).evidence?.length > 0) next[raw] = true
      }
      setExpandedEvidence(next)
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalyzingSpeakers(false)
    }
  }

  /** Принять LLM-предложение для спикера: проставить contact_id в speakerMap. */
  function acceptSpeakerSuggestion(raw: string, contactId: string) {
    setSpeaker(raw, contactId)
    // Очищаем карточку-предложение чтобы не загромождать UI после принятия
    setSpeakerAnalysis((prev) => {
      const next = { ...prev }
      delete next[raw]
      return next
    })
  }

  /** Отвергнуть предложение — просто убираем карточку. Ручной выбор остаётся доступен. */
  function dismissSpeakerSuggestion(raw: string) {
    setSpeakerAnalysis((prev) => {
      const next = { ...prev }
      delete next[raw]
      return next
    })
  }

  function setSpeaker(raw: string, contactId: string | null) {
    setSpeakerMap((prev) => {
      const next = { ...prev }
      if (!contactId) {
        delete next[raw]
        return next
      }
      // Найдём контакт и его организацию
      let label = ''
      let org = ''
      for (const list of Object.values(contactsByOrg)) {
        const c = list.find((x) => x.id === contactId)
        if (c) {
          label = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ')
          break
        }
      }
      // organisation by contact_id → from meetingEntities matching contactsByOrg keys
      for (const [orgId, list] of Object.entries(contactsByOrg)) {
        if (list.some((x) => x.id === contactId)) {
          const orgRec = allEntities.find((e) => e.id === orgId)
          org = orgRec?.name ?? ''
          break
        }
      }
      next[raw] = { contact_id: contactId, label, org }
      return next
    })
  }

  async function runProcess() {
    // Сохраняем маппинг (если изменялся) и запускаем streaming /process
    if (JSON.stringify(speakerMap) !== JSON.stringify(meeting?.speaker_map ?? {})) {
      const ok = await saveSpeakerMap()
      if (!ok) return
    }

    setProcessing(true)
    setProcessLog([])
    setProcessSummary(null)
    setTranscriptionError('')

    try {
      const res = await fetch(`/api/protocols/${id}/process`, { method: 'POST' })
      if (!res.body) throw new Error('Нет потока ответа')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let done = false
      while (!done) {
        const r = await reader.read()
        done = r.done
        if (r.value) buffer += decoder.decode(r.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let event: { type: string; status?: string; message: string; data?: { tasks?: number; topics?: number } }
          try {
            event = JSON.parse(trimmed)
          } catch {
            continue
          }
          if (event.type === 'log' && event.status === 'start') {
            appendLog({ label: event.message, status: 'start' })
          } else if (event.type === 'log' && event.status === 'ok') {
            updateLastLog('ok')
            if (event.message) appendLog({ label: event.message, status: 'ok' })
          } else if (event.type === 'done') {
            appendLog({ label: event.message, status: 'ok' })
            const d = event.data || {}
            setProcessSummary({ tasks: d.tasks ?? 0, topics: d.topics ?? 0 })
          } else if (event.type === 'error') {
            updateLastLog('fail')
            appendLog({ label: event.message, status: 'fail' })
            setTranscriptionError(event.message)
          }
        }
      }
    } catch (e) {
      updateLastLog('fail')
      const msg = e instanceof Error ? e.message : String(e)
      setTranscriptionError(`Обработка: ${msg}`)
    } finally {
      setProcessing(false)
    }

    await load()
  }

  function transcriptionFileName(): string | null {
    if (!meeting?.transcription_path) return null
    const parts = meeting.transcription_path.split('/')
    return parts[parts.length - 1] || null
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function toggleObject(objectId: string) {
    setForm((f) => ({
      ...f,
      object_ids: f.object_ids.includes(objectId)
        ? f.object_ids.filter((c) => c !== objectId)
        : [...f.object_ids, objectId],
    }))
  }

  function toggleEntity(eid: string) {
    setForm((f) => {
      const exists = f.legal_entities.some((le) => le.id === eid)
      if (exists) {
        return { ...f, legal_entities: f.legal_entities.filter((le) => le.id !== eid) }
      }
      // По умолчанию новое юр.лицо — participant; пользователь может сменить роль селектором
      return { ...f, legal_entities: [...f.legal_entities, { id: eid, role: 'participant' }] }
    })
  }

  function changeEntityRole(eid: string, role: LegalEntityRole) {
    setForm((f) => ({
      ...f,
      legal_entities: f.legal_entities.map((le) => (le.id === eid ? { ...le, role } : le)),
    }))
  }

  async function save() {
    setSaving(true)
    setError('')
    if (!form.title.trim() || !form.meeting_date) {
      setError('Дата и название обязательны')
      setSaving(false)
      return
    }
    if (form.legal_entities.length === 0) {
      setError('Выберите хотя бы одно юр.лицо-участника')
      setSaving(false)
      return
    }

    // 1) Обновляем основные поля. folder_path не правится из UI — он управляется
    //    системой (см. WIKI 02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ → ПРОТОКОЛЫ).
    //    Связь с объектами — по UUID (см. WIKI 09_Правило_связей).
    const payload = {
      meeting_date: form.meeting_date,
      title: form.title.trim(),
      object_ids: form.object_ids,
    }
    const { error: e1 } = await supabase.from('meetings').update(payload).eq('id', id)
    if (e1) {
      setSaving(false)
      setError(e1.message)
      return
    }

    // 2) Синхронизируем meeting_legal_entities (diff add / remove / role-update)
    const current = new Set(meetingEntityIds)
    const formIds = form.legal_entities.map((le) => le.id)
    const next = new Set(formIds)
    const toRemove = [...current].filter((x) => !next.has(x))
    const toAdd = form.legal_entities.filter((le) => !current.has(le.id))
    const toUpdateRole = form.legal_entities.filter(
      (le) => current.has(le.id) && meetingEntityRoles[le.id] !== le.role,
    )

    if (toRemove.length > 0) {
      // Каскад: удалить участников этих юр.лиц из meeting_participants,
      // иначе FK on delete restrict не даст удалить связь.
      const contactsToRemove: string[] = []
      for (const orgId of toRemove) {
        const orgContacts = contactsByOrg[orgId] || []
        for (const c of orgContacts) contactsToRemove.push(c.id)
      }
      if (contactsToRemove.length > 0) {
        const { error: ePart } = await supabase
          .from('meeting_participants')
          .delete()
          .eq('meeting_id', id)
          .in('contact_id', contactsToRemove)
        if (ePart) {
          setSaving(false)
          setError(`Не удалось удалить участников: ${ePart.message}`)
          return
        }
      }

      const { error: eRem } = await supabase
        .from('meeting_legal_entities')
        .delete()
        .eq('meeting_id', id)
        .in('legal_entity_id', toRemove)
      if (eRem) {
        setSaving(false)
        setError(`Не удалось удалить юр.лица: ${eRem.message}`)
        return
      }
    }
    if (toAdd.length > 0) {
      const baseSeq = meetingEntityIds.filter((x) => next.has(x)).length
      const links = toAdd.map((le, idx) => ({
        meeting_id: id,
        legal_entity_id: le.id,
        role: le.role,
        seq: baseSeq + idx + 1,
      }))
      const { error: eAdd } = await supabase.from('meeting_legal_entities').insert(links)
      if (eAdd) {
        setSaving(false)
        setError(`Не удалось добавить юр.лица: ${eAdd.message}`)
        return
      }
    }
    if (toUpdateRole.length > 0) {
      // По одному UPDATE на юр.лицо. Объём небольшой — обычно ≤ 5 за сохранение.
      for (const le of toUpdateRole) {
        const { error: eUpd } = await supabase
          .from('meeting_legal_entities')
          .update({ role: le.role })
          .eq('meeting_id', id)
          .eq('legal_entity_id', le.id)
        if (eUpd) {
          setSaving(false)
          setError(`Не удалось обновить роль: ${eUpd.message}`)
          return
        }
      }
    }

    // Событие «Собрание проведено» синхронизируется автоматически Postgres-триггерами
    // `meetings_sync_event_trg` и `meeting_le_sync_event_trg`: при UPDATE meetings
    // (status/title/date/object_ids) и при INSERT/UPDATE/DELETE meeting_legal_entities
    // вызывается функция sync_meeting_event(meeting_id). См. миграцию
    // 20260514000001_meetings_sync_event.sql.

    setSaving(false)
    setEditing(false)
    load()
  }

  function cancel() {
    if (!meeting) return
    const formLes: LegalEntityLink[] = meetingEntityIds.map((eid) => ({
      id: eid,
      role: (meetingEntityRoles[eid] ?? 'participant') as LegalEntityRole,
    }))
    setForm({
      meeting_date: meeting.meeting_date,
      title: meeting.title,
      object_ids: meeting.object_ids,
      legal_entities: formLes,
    })
    setEditing(false)
    setError('')
  }

  function formatDate(iso: string) {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
  }

  /** Принимает UUID объекта (object_ids[*]) и возвращает «code: name». */
  function objectName(idOrCode: string) {
    const o = objects.find((x) => x.id === idOrCode || x.code === idOrCode)
    return o ? `${o.code}: ${o.current_name}` : idOrCode
  }
  /** Только current_name по UUID — для коротких чипов. */
  function objectShortName(idOrCode: string) {
    return objects.find((x) => x.id === idOrCode || x.code === idOrCode)?.current_name ?? idOrCode
  }
  function objectCode(id: string) {
    return objects.find((x) => x.id === id)?.code ?? ''
  }

  function entityById(eid: string): LegalEntity | undefined {
    return allEntities.find((e) => e.id === eid)
  }

  if (loading)  return <div className="p-8">Загрузка…</div>
  if (!meeting) return <div className="p-8">Собрание не найдено</div>

  const status = STATUS_LABELS[meeting.status] ?? {
    label: meeting.status,
    cls: 'bg-gray-100 text-gray-700',
  }

  const meetingEntities = meetingEntityIds
    .map(entityById)
    .filter((x): x is LegalEntity => Boolean(x))

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div>
        <Link href="/protocols" className="text-sm text-blue-600 hover:underline">
          ← К списку протоколов
        </Link>
        <div className="flex items-start justify-between mt-2">
          <div>
            <h1 className="text-2xl font-bold">{meeting.title}</h1>
            <p className="text-gray-600 text-sm mt-1">
              {formatDate(meeting.meeting_date)}
              {meetingEntities.length > 0 &&
                ' · ' + meetingEntities.map((e) => e.aliases[0] ?? e.name).join(', ')}
              {meeting.object_ids.length > 0 &&
                ` · ${meeting.object_ids.map(objectShortName).join(', ')}`}
            </p>
          </div>
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${status.cls}`}>
            {status.label}
          </span>
        </div>
      </div>

      {/* Шапка готовности — сводка состояния по 7 пунктам */}
      <ReadinessPanel
        meeting={meeting}
        meetingEntities={meetingEntities}
        meetingEntityRoles={meetingEntityRoles}
        contactCount={Array.from(selectedContactIds).length}
        prelimTopics={topics.filter((t) => t.status === 'preliminary').length}
        prelimTasks={tasks.filter((t) => t.status === 'preliminary').length}
        topicsCount={topics.filter((t) => t.status !== 'removed').length}
        tasksCount={tasks.length}
        meetingEventExists={meetingEventExists}
      />

      {/* Секция 1: Метаданные (редактируемые) */}
      <section id="section-1" className="bg-white border rounded shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">1. Метаданные</h2>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Редактировать
            </button>
          )}
        </div>

        {error && (
          <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
            {error}
          </div>
        )}

        {!editing ? (
          <dl className="grid grid-cols-[180px_1fr] gap-y-3 gap-x-4 text-sm">
            <dt className="text-gray-500">Дата</dt>
            <dd className="font-mono">{formatDate(meeting.meeting_date)}</dd>

            <dt className="text-gray-500">Название</dt>
            <dd>{meeting.title}</dd>

            <dt className="text-gray-500">Юр.лица</dt>
            <dd>
              {meetingEntities.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {meetingEntities.map((e) => {
                    const role = (meetingEntityRoles[e.id] ?? 'participant') as LegalEntityRole
                    const roleLabel = ROLE_LABELS[role] ?? role
                    const roleCls = ROLE_BADGE_CLS[role] ?? 'bg-gray-100 text-gray-700'
                    return (
                      <span
                        key={e.id}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs"
                        title={e.name}
                      >
                        {e.name}
                        <span className={`px-1.5 py-px rounded ${roleCls}`}>{roleLabel}</span>
                      </span>
                    )
                  })}
                </div>
              ) : (
                <span className="text-red-500">— не выбрано —</span>
              )}
            </dd>

            <dt className="text-gray-500">Объекты обсуждения</dt>
            <dd>
              {meeting.object_ids.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {meeting.object_ids.map((oid) => (
                    <span
                      key={oid}
                      className="inline-block px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs"
                    >
                      <span className="font-mono">{objectCode(oid)}</span>
                      <span className="text-blue-500 ml-1">{objectShortName(oid)}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-gray-400">— не выбрано —</span>
              )}
            </dd>

            <dt className="text-gray-500">Статус</dt>
            <dd>
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${status.cls}`}>
                {status.label}
              </span>
            </dd>
          </dl>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-[180px_1fr] gap-x-4 items-center">
              <label className="text-sm text-gray-700">Дата *</label>
              <input
                type="date"
                value={form.meeting_date}
                onChange={(e) => setForm({ ...form, meeting_date: e.target.value })}
                className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-[180px_1fr] gap-x-4 items-center">
              <label className="text-sm text-gray-700">Название *</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-[180px_1fr] gap-x-4">
              <label className="text-sm text-gray-700 pt-2">Юр.лица *</label>
              <div className="space-y-1 max-h-56 overflow-y-auto border border-gray-200 rounded p-3 bg-gray-50">
                {allEntities.length === 0 ? (
                  <p className="text-sm text-gray-400">Юр.лица не загружены</p>
                ) : (
                  allEntities.map((e) => {
                    const link = form.legal_entities.find((le) => le.id === e.id)
                    const checked = !!link
                    const role = link?.role ?? 'participant'
                    return (
                      <div
                        key={e.id}
                        className="flex items-center gap-2 text-sm hover:bg-white px-2 py-1 rounded"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleEntity(e.id)}
                          className="rounded cursor-pointer"
                        />
                        <span className="text-gray-800 flex-1">{e.name}</span>
                        {e.aliases.length > 0 && (
                          <span className="text-xs text-gray-400">
                            {e.aliases[0]}
                          </span>
                        )}
                        <select
                          value={role}
                          onChange={(ev) => changeEntityRole(e.id, ev.target.value as LegalEntityRole)}
                          disabled={!checked}
                          className="text-xs px-2 py-1 border border-gray-300 rounded bg-white disabled:opacity-40"
                        >
                          <option value="participant">Участник</option>
                          <option value="contractor">Подрядчик</option>
                          <option value="customer">Заказчик</option>
                          <option value="operator">Оператор</option>
                          <option value="investor">Инвестор</option>
                          <option value="expert">Эксперт</option>
                        </select>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div className="grid grid-cols-[180px_1fr] gap-x-4">
              <label className="text-sm text-gray-700 pt-2">Объекты обсуждения</label>
              <div className="space-y-1 max-h-64 overflow-y-auto border border-gray-200 rounded p-3 bg-gray-50">
                {objects.length === 0 ? (
                  <p className="text-sm text-gray-400">Объекты не загружены</p>
                ) : (
                  objects.map((o) => {
                    const checked = form.object_ids.includes(o.id)
                    return (
                      <label
                        key={o.id}
                        className="flex items-center gap-3 text-sm cursor-pointer hover:bg-white px-2 py-1 rounded"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleObject(o.id)}
                          className="rounded shrink-0"
                        />
                        <span className="font-mono text-xs text-gray-500 shrink-0 whitespace-nowrap">
                          {o.code}
                        </span>
                        <span className="text-gray-800 truncate">{o.current_name}</span>
                      </label>
                    )
                  })
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={cancel}
                disabled={saving}
                className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
              >
                Отмена
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Секция 2: Участники */}
      <section id="section-2" className="bg-white border rounded shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            2. Участники
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({selectedContactIds.size} чел.)
            </span>
          </h2>
          <div className="flex items-center gap-3">
            {editingParticipants && (
              <button
                onClick={openNewContact}
                disabled={meetingEntityIds.length === 0}
                className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400 disabled:cursor-not-allowed"
                title={meetingEntityIds.length === 0 ? 'Сначала выберите юр.лица в метаданных' : ''}
              >
                + Новый контакт
              </button>
            )}
            {!editingParticipants && (
              <button
                onClick={() => setEditingParticipants(true)}
                disabled={meetingEntityIds.length === 0}
                className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-400 disabled:cursor-not-allowed"
                title={meetingEntityIds.length === 0 ? 'Сначала выберите юр.лица в метаданных' : ''}
              >
                Редактировать
              </button>
            )}
          </div>
        </div>

        {participantsError && (
          <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
            {participantsError}
          </div>
        )}

        {meetingEntityIds.length === 0 ? (
          <p className="text-sm text-gray-500">
            Сначала выберите юр.лица в секции «Метаданные» — затем здесь появятся
            их сотрудники для отметки.
          </p>
        ) : !editingParticipants ? (
          /* ── Режим просмотра ── */
          selectedContactIds.size === 0 ? (
            <p className="text-sm text-gray-400">
              Участники ещё не отмечены. Нажмите «Редактировать» чтобы выбрать.
            </p>
          ) : (
            <div className="space-y-3">
              {meetingEntities.map((org) => {
                const orgContacts = contactsByOrg[org.id] || []
                const selected = orgContacts.filter((c) => selectedContactIds.has(c.id))
                if (selected.length === 0) return null
                return (
                  <div key={org.id}>
                    <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      {org.name}
                    </div>
                    <ul className="space-y-0.5">
                      {selected.map((c) => {
                        const fio = [c.last_name, c.first_name, c.middle_name]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <li key={c.id} className="text-sm">
                            <span className="font-medium text-gray-800">{fio}</span>
                            {c.job_title && (
                              <span className="text-gray-500"> — {c.job_title}</span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          /* ── Режим редактирования ── */
          <div className="space-y-4">
            {meetingEntities.map((org) => {
              const orgContacts = contactsByOrg[org.id] || []
              const total = orgContacts.length
              const checkedCount = orgContacts.filter((c) =>
                selectedContactIds.has(c.id),
              ).length
              const allOn = total > 0 && checkedCount === total
              return (
                <div key={org.id} className="border border-gray-200 rounded">
                  <div className="flex items-center justify-between bg-gray-50 px-3 py-2 border-b border-gray-200">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{org.name}</span>
                      <span className="text-xs text-gray-500">
                        {checkedCount} из {total}
                      </span>
                    </div>
                    {total > 0 && (
                      <button
                        onClick={() => toggleAllInOrg(org.id, allOn)}
                        className="text-xs text-blue-600 hover:text-blue-800"
                      >
                        {allOn ? 'снять все' : 'выбрать все'}
                      </button>
                    )}
                  </div>
                  {total === 0 ? (
                    <p className="px-3 py-2 text-sm text-gray-400">
                      Нет контактов в справочнике. Добавьте через «+ Новый контакт» вверху.
                    </p>
                  ) : (
                    <div className="divide-y divide-gray-100">
                      {orgContacts.map((c) => {
                        const checked = selectedContactIds.has(c.id)
                        const fio = [c.last_name, c.first_name, c.middle_name]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <label
                            key={c.id}
                            className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-blue-50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleContact(c.id)}
                              className="rounded"
                            />
                            <span className="font-medium text-gray-800">{fio}</span>
                            {c.job_title && (
                              <span className="text-xs text-gray-500">
                                — {c.job_title}
                              </span>
                            )}
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={cancelParticipants}
                disabled={savingParticipants}
                className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
              >
                Отмена
              </button>
              <button
                onClick={saveParticipants}
                disabled={savingParticipants || !participantsDirty}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
              >
                {savingParticipants ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        )}

        {/* Inline-форма «Новый контакт» */}
        {newContactOpen && (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
            onClick={closeNewContact}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-lg w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-5 border-b">
                <h3 className="text-lg font-semibold">Новый контакт</h3>
              </div>
              <div className="p-5 space-y-3">
                {participantsError && (
                  <div className="p-2 bg-red-50 text-red-700 border border-red-200 rounded text-xs">
                    {participantsError}
                  </div>
                )}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Юр.лицо *</label>
                  <select
                    value={newContactForm.legal_entity_id}
                    onChange={(e) =>
                      setNewContactForm({ ...newContactForm, legal_entity_id: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">— выбрать —</option>
                    {meetingEntities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Фамилия *</label>
                    <input
                      type="text"
                      value={newContactForm.last_name}
                      onChange={(e) =>
                        setNewContactForm({ ...newContactForm, last_name: e.target.value })
                      }
                      className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Имя *</label>
                    <input
                      type="text"
                      value={newContactForm.first_name}
                      onChange={(e) =>
                        setNewContactForm({ ...newContactForm, first_name: e.target.value })
                      }
                      className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Отчество</label>
                    <input
                      type="text"
                      value={newContactForm.middle_name}
                      onChange={(e) =>
                        setNewContactForm({ ...newContactForm, middle_name: e.target.value })
                      }
                      className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Должность</label>
                  <input
                    type="text"
                    value={newContactForm.job_title}
                    onChange={(e) =>
                      setNewContactForm({ ...newContactForm, job_title: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
                <button
                  onClick={closeNewContact}
                  disabled={savingNewContact}
                  className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
                >
                  Отмена
                </button>
                <button
                  onClick={saveNewContact}
                  disabled={savingNewContact}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
                >
                  {savingNewContact ? 'Создание…' : 'Создать и отметить'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Секция 3: Транскрипция (или ручной ввод, если файла нет) */}
      {(() => {
        // Режим ручного ввода: пользователь сам набивает темы/задачи в Секции 6
        // без транскрипции и LLM-обработки. Признак — status >= processed без
        // transcription_path. Включается через кнопку «✍️ Без транскрипции».
        const isManualEntry = !meeting.transcription_path && (
          meeting.status === 'processed' ||
          meeting.status === 'approved' ||
          meeting.status === 'protocoled'
        )
        return (
      <section id="section-3" className="bg-white border rounded shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            3. Транскрипция
            {isManualEntry && (
              <span className="ml-2 text-sm font-normal text-amber-700">— ручной ввод</span>
            )}
          </h2>
          {!editingTranscription && meeting.transcription_path && (
            <button
              onClick={() => {
                setEditingTranscription(true)
                setTranscriptionError('')
              }}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Заменить
            </button>
          )}
        </div>

        {transcriptionError && (
          <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
            {transcriptionError}
          </div>
        )}

        {isManualEntry ? (
          /* ── Режим ручного ввода: транскрипции нет, темы/задачи вводятся в Секции 6 ── */
          <div className="border border-amber-200 bg-amber-50 rounded p-3 space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-2xl">✍️</span>
              <div className="flex-1">
                <div className="font-medium text-sm text-amber-900">
                  Собрание ведётся вручную (без записи)
                </div>
                <div className="text-xs text-amber-800 mt-0.5">
                  Транскрипция и LLM-обработка пропущены. Темы «Обсудили» и задачи вводятся вручную в Секции 6 кнопками «+ Добавить тему/задачу».
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <label className="text-xs text-amber-700 hover:text-amber-900 cursor-pointer">
                ↺ Передумали? Загрузить транскрипцию задним числом
                <input
                  type="file"
                  accept=".docx,.csv,.txt"
                  disabled={transcriptionUploading || processing}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) uploadOnly(f)
                    e.target.value = ''
                  }}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        ) : !editingTranscription && meeting.transcription_path ? (
          /* ── Режим просмотра: файл загружен ── */
          <div className="space-y-2">
            <div className="border border-gray-200 rounded p-3 bg-gray-50">
              <div className="flex items-center gap-3">
                <span className="text-2xl">📄</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-800 truncate">
                    {transcriptionFileName()}
                  </div>
                  <div className="text-xs text-gray-500 font-mono mt-0.5">
                    {meeting.transcription_path}
                  </div>
                </div>
              </div>
            </div>
            {meeting.transcription_resolved_path && (
              <div className="border border-emerald-200 rounded p-3 bg-emerald-50">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">📝</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-emerald-800 truncate">
                      {meeting.transcription_resolved_path.split('/').pop()}
                    </div>
                    <div className="text-xs text-emerald-700 mt-0.5">
                      Распознанная версия — текст после применения маппинга спикеров
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── Режим загрузки ── */
          <div className="space-y-3">
            {meeting.transcription_path && (
              <p className="text-xs text-gray-500">
                Текущая: <span className="font-mono">{transcriptionFileName()}</span> —
                будет заменена при загрузке нового файла.
              </p>
            )}

            <label className="flex flex-col items-center justify-center gap-2 px-4 py-8 border-2 border-dashed border-gray-300 rounded cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors">
              <span className="text-3xl">📥</span>
              <span className="text-sm font-medium text-gray-700">
                {transcriptionUploading ? 'Загрузка…' : 'Выбрать файл транскрипции'}
              </span>
              <span className="text-xs text-gray-500">
                .docx, .csv, .txt — сохранится в STORAGE_DIR\ПРОТОКОЛЫ\
              </span>
              <input
                type="file"
                accept=".docx,.csv,.txt"
                disabled={transcriptionUploading || processing}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) uploadOnly(f)
                  // сбросим input чтобы можно было выбрать тот же файл повторно
                  e.target.value = ''
                }}
                className="hidden"
              />
            </label>

            {meeting.transcription_path && editingTranscription && !processing && (
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    setEditingTranscription(false)
                    setTranscriptionError('')
                  }}
                  disabled={transcriptionUploading}
                  className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
                >
                  Отмена
                </button>
              </div>
            )}

            {/* Кнопка «без транскрипции» — для собраний без записи (ручное ведение) */}
            {!meeting.transcription_path && !transcriptionUploading && (
              <div className="border-t border-gray-200 pt-3 mt-1">
                <div className="text-xs text-gray-500 mb-2">
                  Собрание не записывалось — есть только рукописные заметки?
                </div>
                <button
                  onClick={switchToManualEntry}
                  disabled={switchingToManual}
                  className="px-3 py-2 bg-white border border-amber-300 text-amber-700 rounded hover:bg-amber-50 disabled:opacity-50 text-sm"
                >
                  {switchingToManual ? 'Переключение…' : '✍️ Без транскрипции — ручной ввод'}
                </button>
              </div>
            )}
          </div>
        )}

      </section>
        )
      })()}

      {/* Секция 4: Маппинг спикеров — скрыта в режиме ручного ввода */}
      {(() => {
        const isManualEntry = !meeting.transcription_path && (
          meeting.status === 'processed' ||
          meeting.status === 'approved' ||
          meeting.status === 'protocoled'
        )
        if (isManualEntry) return null
        return (
      <section
        className={`bg-white border rounded shadow-sm p-5 ${
          !meeting.transcription_path ? 'opacity-50' : ''
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">
            4. Маппинг спикеров
            {speakers.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({Object.keys(speakerMap).length} из {speakers.length} назначено)
              </span>
            )}
          </h2>
          {meeting.transcription_path && speakers.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={analyzeSpeakersLLM}
                disabled={analyzingSpeakers || selectedContactIds.size === 0}
                title={selectedContactIds.size === 0
                  ? 'Сначала добавьте контакты в Секцию 2'
                  : 'LLM попробует определить имена спикеров по содержанию реплик'}
                className="text-sm px-3 py-1 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
              >
                {analyzingSpeakers ? '🤖 Анализ…' : '🤖 Проанализировать спикеров'}
              </button>
              <button
                onClick={loadSpeakers}
                disabled={speakersLoading}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ↻ Перечитать
              </button>
            </div>
          )}
        </div>

        {analyzeError && (
          <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
            🤖 {analyzeError}
          </div>
        )}

        {speakersError && (
          <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
            {speakersError}
          </div>
        )}

        {!meeting.transcription_path ? (
          <p className="text-sm text-gray-500">
            Загрузите транскрипцию в Секции 3 — здесь появится список найденных спикеров
            для сопоставления с участниками собрания.
          </p>
        ) : speakersLoading ? (
          <p className="text-sm text-gray-500">Извлечение спикеров…</p>
        ) : speakers.length === 0 ? (
          <p className="text-sm text-gray-500">
            В файле не удалось определить спикеров (только CSV с колонкой «Speaker»
            поддерживает маппинг). Для DOCX/TXT — пропустите этот шаг и нажмите
            «Запустить обработку».
          </p>
        ) : (
          <div className="space-y-2">
            {speakers.map((sp) => {
              const mapped = speakerMap[sp.raw]
              const shown = shownSamples[sp.raw] ?? 3
              const visibleSamples = sp.samples.slice(0, shown)
              const hasMore = sp.samples.length > shown
              return (
                <div
                  key={sp.raw}
                  className="border border-gray-200 rounded p-3 grid grid-cols-[1fr_auto_2fr] gap-3 items-start"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm font-mono">{sp.raw}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {sp.count} реплик
                    </div>
                    {visibleSamples.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {visibleSamples.map((s, i) => (
                          <div
                            key={i}
                            className="text-xs text-gray-600 italic border-l-2 border-gray-200 pl-2"
                          >
                            «{s}»
                          </div>
                        ))}
                        <div className="flex items-center gap-2 pt-1">
                          {hasMore && (
                            <button
                              onClick={() =>
                                setShownSamples((prev) => ({
                                  ...prev,
                                  [sp.raw]: Math.min(shown + 5, sp.samples.length),
                                }))
                              }
                              className="text-xs text-blue-600 hover:text-blue-800"
                            >
                              ↓ Ещё реплики ({sp.samples.length - shown})
                            </button>
                          )}
                          {!hasMore && shown > 3 && (
                            <button
                              onClick={() =>
                                setShownSamples((prev) => ({ ...prev, [sp.raw]: 3 }))
                              }
                              className="text-xs text-gray-500 hover:text-gray-700"
                            >
                              ↑ Свернуть
                            </button>
                          )}
                          {sp.samples.length === 0 && (
                            <span className="text-xs text-gray-400">нет образцов</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="text-gray-400 text-xs pt-1">→</div>
                  <div className="space-y-2">
                    {/* LLM-предложение (если есть) */}
                    {(() => {
                      const sugg = speakerAnalysis[sp.raw]
                      if (!sugg || mapped) return null
                      // Скрываем «UNKNOWN без evidence» — пустая карточка не информативна.
                      // Полностью пустые случаи держим в state, чтобы счётчик «N из M проанализировано»
                      // был честным, но UI не загромождаем.
                      if (sugg.confidence === 'unknown' &&
                          !sugg.contact_id &&
                          !sugg.fio_mention &&
                          !sugg.org_mention &&
                          sugg.evidence.length === 0) return null

                      const confColor = sugg.confidence === 'high'
                        ? 'border-green-300 bg-green-50'
                        : sugg.confidence === 'medium'
                        ? 'border-blue-300 bg-blue-50'
                        : sugg.confidence === 'ambiguous'
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-gray-300 bg-gray-50'

                      const confBadge = sugg.confidence === 'high'
                        ? 'bg-green-200 text-green-900'
                        : sugg.confidence === 'medium'
                        ? 'bg-blue-200 text-blue-900'
                        : sugg.confidence === 'ambiguous'
                        ? 'bg-amber-200 text-amber-900'
                        : 'bg-gray-200 text-gray-700'

                      const evidenceTypeLabel = (t: string): string => {
                        switch (t) {
                          case 'self_intro':           return '🎤 Представился'
                          case 'addressed_by_name':    return '📛 Обращение по имени'
                          case 'addressed_to_company': return '🏷 Обращение к орг'
                          case 'mentioned_company':    return '🏢 Назвал свою орг'
                          case 'first_name_only':      return '👤 Только имя'
                          case 'role_mention':         return '🛠 По роли / теме'
                          case 'third_person':         return '↩ В третьем лице'
                          default:                     return '· Сигнал'
                        }
                      }

                      const evExpanded = expandedEvidence[sp.raw] ?? false

                      return (
                        <div className={`border rounded p-2 ${confColor}`}>
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-xs font-medium text-gray-700">🤖 LLM-предложение</span>
                            <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${confBadge}`}>
                              {sugg.confidence}
                            </span>
                          </div>
                          {sugg.contact_id ? (
                            <div>
                              <div className="text-sm font-medium text-gray-900">{sugg.label}</div>
                              {sugg.org && <div className="text-xs text-gray-600">{sugg.org}</div>}
                              <div className="flex items-center gap-1 mt-2">
                                <button
                                  onClick={() => acceptSpeakerSuggestion(sp.raw, sugg.contact_id!)}
                                  className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700"
                                >
                                  ✓ Применить
                                </button>
                                <button
                                  onClick={() => dismissSpeakerSuggestion(sp.raw)}
                                  className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-white"
                                >
                                  ✕ Отклонить
                                </button>
                              </div>
                            </div>
                          ) : sugg.candidates && sugg.candidates.length > 0 ? (
                            <div>
                              <div className="text-xs text-gray-700 mb-1">
                                Найдено {sugg.candidates.length} кандидата — выберите:
                              </div>
                              <div className="space-y-1">
                                {sugg.candidates.map((c) => (
                                  <button
                                    key={c.contact_id}
                                    onClick={() => acceptSpeakerSuggestion(sp.raw, c.contact_id)}
                                    className="w-full text-left text-xs px-2 py-1 bg-white border border-amber-300 rounded hover:bg-amber-100"
                                  >
                                    <span className="font-medium">{c.label}</span>
                                    {c.org && <span className="text-gray-500"> · {c.org}</span>}
                                  </button>
                                ))}
                              </div>
                              <button
                                onClick={() => dismissSpeakerSuggestion(sp.raw)}
                                className="text-xs text-gray-600 hover:text-gray-900 mt-2"
                              >
                                ✕ Ни один из них
                              </button>
                            </div>
                          ) : (
                            <div>
                              {sugg.fio_mention || sugg.org_mention ? (
                                <div className="text-xs text-gray-700">
                                  В транскрипции звучит{' '}
                                  {sugg.fio_mention && <strong>«{sugg.fio_mention}»</strong>}
                                  {sugg.fio_mention && sugg.org_mention && ' / '}
                                  {sugg.org_mention && <em>«{sugg.org_mention}»</em>}
                                  {' '}— но среди участников совпадений нет.
                                </div>
                              ) : (
                                <div className="text-xs text-gray-500">
                                  LLM не нашла упоминаний имени / организации для этого спикера.
                                </div>
                              )}
                              <button
                                onClick={() => dismissSpeakerSuggestion(sp.raw)}
                                className="text-xs text-gray-600 hover:text-gray-900 mt-1"
                              >
                                Скрыть
                              </button>
                            </div>
                          )}

                          {sugg.evidence.length > 0 && (
                            <details
                              className="mt-2"
                              open={evExpanded}
                              onToggle={(e) =>
                                setExpandedEvidence((prev) => ({
                                  ...prev,
                                  [sp.raw]: (e.target as HTMLDetailsElement).open,
                                }))
                              }
                            >
                              <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-800 select-none">
                                Обоснование ({sugg.evidence.length} {sugg.evidence.length === 1 ? 'сигнал' : 'сигнала'})
                              </summary>
                              <div className="mt-1 space-y-1">
                                {sugg.evidence.map((ev, i) => (
                                  <div key={i} className="text-xs bg-white border-l-2 border-blue-300 pl-2 py-1 rounded-r">
                                    <div className="text-[10px] uppercase text-gray-500 mb-0.5">
                                      {evidenceTypeLabel(ev.type)}
                                    </div>
                                    <div className="text-gray-700 italic">«{ev.text}»</div>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      )
                    })()}

                    <select
                      value={mapped?.contact_id ?? ''}
                      onChange={(e) => setSpeaker(sp.raw, e.target.value || null)}
                      className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">— не назначено —</option>
                      {meetingEntities.map((org) => {
                        const list = contactsByOrg[org.id] || []
                        if (list.length === 0) return null
                        return (
                          <optgroup key={org.id} label={org.name}>
                            {list.map((c) => {
                              const fio = [c.last_name, c.first_name, c.middle_name]
                                .filter(Boolean)
                                .join(' ')
                              return (
                                <option key={c.id} value={c.id}>
                                  {fio} {c.job_title ? `— ${c.job_title}` : ''}
                                </option>
                              )
                            })}
                          </optgroup>
                        )
                      })}
                    </select>
                    {mapped?.label && (
                      <div className="text-xs text-gray-500 mt-1">
                        ✓ {mapped.label}
                        {mapped.org && <span className="text-gray-400"> ({mapped.org})</span>}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Кнопка запуска обработки */}
        {meeting.transcription_path && (
          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-gray-500">
              {meeting.status === 'transcript_uploaded'
                ? 'Готово к обработке.'
                : meeting.status === 'processed' || meeting.status === 'approved' || meeting.status === 'protocoled'
                ? 'Обработка уже выполнена. Повторный запуск пересоздаст preliminary-задачи и темы.'
                : ''}
            </div>
            <button
              onClick={runProcess}
              disabled={processing || savingSpeakers}
              className="px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50 text-sm"
            >
              {processing
                ? 'Обработка…'
                : savingSpeakers
                ? 'Сохранение…'
                : meeting.status === 'transcript_uploaded'
                ? '▶ Запустить обработку LLM'
                : '↻ Перезапустить обработку'}
            </button>
          </div>
        )}

        {/* Лог поэтапной обработки — переехал сюда из Секции 3 */}
        {processLog.length > 0 && (
          <div className="mt-4 bg-gray-900 rounded p-3 font-mono text-xs leading-relaxed">
            {processLog.map((l, i) => {
              const icon =
                l.status === 'start' ? '⏳' :
                l.status === 'ok'    ? '✅' :
                                       '❌'
              const color =
                l.status === 'start' ? 'text-gray-300' :
                l.status === 'ok'    ? 'text-green-400' :
                                       'text-red-400'
              return (
                <div key={i} className={color}>
                  <span className="mr-2">{icon}</span>
                  {l.label}
                </div>
              )
            })}
            {processing && <div className="text-gray-500 mt-1 animate-pulse">…</div>}
          </div>
        )}

        {/* Сводка результата */}
        {processSummary && (
          <div className="mt-4 flex gap-4">
            <div className="flex-1 border border-blue-200 bg-blue-50 rounded p-3">
              <div className="text-2xl font-bold text-blue-700">
                {processSummary.tasks}
              </div>
              <div className="text-xs text-blue-600 uppercase tracking-wide">
                задач (preliminary)
              </div>
            </div>
            <div className="flex-1 border border-purple-200 bg-purple-50 rounded p-3">
              <div className="text-2xl font-bold text-purple-700">
                {processSummary.topics}
              </div>
              <div className="text-xs text-purple-600 uppercase tracking-wide">
                тем «Обсудили»
              </div>
            </div>
          </div>
        )}
      </section>
        )
      })()}

      {/* Секция 5: Файлы к протоколу — после транскрипции/маппинга, до ревью */}
      {(() => {
        const groups: Record<'video' | 'material' | 'other', Attachment[]> = {
          video: [],
          material: [],
          other: [],
        }
        for (const a of attachments) groups[a.kind].push(a)
        const KIND_LABELS = {
          video: { icon: '🎥', label: 'Видеозапись', color: 'red' },
          material: { icon: '📄', label: 'Материалы', color: 'blue' },
          other: { icon: '📁', label: 'Прочее', color: 'gray' },
        }
        return (
          <section className="bg-white border rounded shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">
                5. Файлы к протоколу
                {attachments.length > 0 && (
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    ({attachments.length})
                  </span>
                )}
              </h2>
            </div>

            {attachmentError && (
              <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                {attachmentError}
              </div>
            )}

            {/* Загрузка нового файла */}
            <div className="border border-dashed border-gray-300 rounded p-4 mb-4">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-sm text-gray-700">Тип файла:</label>
                <select
                  value={attachmentKind}
                  onChange={(e) => setAttachmentKind(e.target.value as 'video' | 'material' | 'other')}
                  disabled={attachmentUploading}
                  className="px-2 py-1 border border-gray-300 rounded text-sm"
                >
                  <option value="material">📄 Материал (для семантического поиска)</option>
                  <option value="video">🎥 Видеозапись</option>
                  <option value="other">📁 Прочее</option>
                </select>
                <label className="ml-auto px-3 py-1.5 bg-blue-600 text-white rounded text-sm cursor-pointer hover:bg-blue-700">
                  {attachmentUploading ? 'Загрузка…' : '📎 Добавить файл'}
                  <input
                    type="file"
                    disabled={attachmentUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) uploadAttachment(f)
                      e.target.value = ''
                    }}
                    className="hidden"
                  />
                </label>
              </div>
              {attachmentKind === 'material' && (
                <p className="text-xs text-gray-500 mt-2">
                  ⓘ Материалы будут проиндексированы в векторной БД для семантического поиска
                  (планируется — статус индексации видно в списке).
                </p>
              )}
            </div>

            {attachments.length === 0 ? (
              <p className="text-sm text-gray-400">Файлов пока нет.</p>
            ) : (
              <div className="space-y-3">
                {(['video', 'material', 'other'] as const).map((kind) => {
                  const list = groups[kind]
                  if (list.length === 0) return null
                  const meta = KIND_LABELS[kind]
                  return (
                    <div key={kind}>
                      <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                        {meta.icon} {meta.label} ({list.length})
                      </div>
                      <ul className="space-y-1">
                        {list.map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center gap-3 px-3 py-2 border border-gray-200 rounded text-sm hover:bg-gray-50"
                          >
                            <a
                              href={`/api/protocols/${id}/attachments/${a.id}/download`}
                              download={a.filename}
                              className="flex-1 min-w-0 truncate font-medium text-blue-600 hover:text-blue-800 hover:underline"
                              title={`Скачать «${a.filename}»`}
                            >
                              {a.filename}
                            </a>
                            <span className="text-xs text-gray-500">
                              {formatBytes(a.size_bytes)}
                            </span>
                            {kind === 'material' && (
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  a.indexed_at
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-amber-100 text-amber-800'
                                }`}
                                title={a.indexed_at ? `Индексировано: ${a.indexed_at}` : 'Не индексировано'}
                              >
                                {a.indexed_at ? '✓ индекс' : 'TODO индекс'}
                              </span>
                            )}
                            <button
                              onClick={() => deleteAttachment(a)}
                              className="text-xs text-red-600 hover:text-red-800 ml-1"
                            >
                              🗑
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })()}

      {/* Секция 6: Ревью preliminary */}
      {(() => {
        const prelimTopics = topics.filter((t) => t.status === 'preliminary')
        const prelimTasks  = tasks.filter((t) => t.status === 'preliminary')
        const totalPrelim = prelimTopics.length + prelimTasks.length
        return (
          <section
            id="section-6"
            className={`bg-white border rounded shadow-sm p-5 ${
              meeting.status === 'planned' || meeting.status === 'transcript_uploaded'
                ? 'opacity-50'
                : ''
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                6. Ревью
                {totalPrelim > 0 && (
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    ({totalPrelim} preliminary)
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-3">
                {meeting.status === 'processed' && (
                  <button
                    onClick={() => setCreatingItem(reviewTab === 'topics' ? 'topic' : 'task')}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    + {reviewTab === 'topics' ? 'Добавить тему' : 'Добавить задачу'}
                  </button>
                )}
                {(meeting.status === 'approved' || meeting.status === 'protocoled') && !correctionMode && (
                  <button
                    onClick={() => {
                      setCorrectionMode(true)
                      setCorrectionError('')
                    }}
                    className="text-sm text-amber-700 hover:text-amber-900 border border-amber-300 rounded px-3 py-1"
                  >
                    ✎ Режим правки по замечанию
                  </button>
                )}
                {correctionMode && (
                  <button
                    onClick={() => {
                      setCorrectionMode(false)
                      setCorrectionTopicDrafts({})
                      setCorrectionTaskDrafts({})
                      setCorrectionNewTasks([])
                      setCorrectionTopicRemovals(new Set())
                      setCorrectionTaskRemovals(new Set())
                      setCorrectionAddingTask(false)
                      setCorrectionEnrichDesc('')
                      setCorrectionEnrichError('')
                      setCorrectionError('')
                    }}
                    className="text-sm text-gray-600 hover:text-gray-900 border rounded px-3 py-1"
                  >
                    ✕ Выйти из режима правки
                  </button>
                )}
              </div>
            </div>

            {/* Шапка режима правки по замечанию */}
            {correctionMode && (() => {
              const draftCount =
                Object.keys(correctionTopicDrafts).length +
                Object.keys(correctionTaskDrafts).length +
                correctionNewTasks.length +
                correctionTopicRemovals.size +
                correctionTaskRemovals.size
              const canApply =
                draftCount > 0 &&
                correctionHeader.corrected_by_entity_id !== '' &&
                !applyingCorrection

              async function applyBatch() {
                setApplyingCorrection(true)
                setCorrectionError('')
                try {
                  // Тип расширен: для add_task fields содержит массивы (object_ids,
                  // quotes) и priority — поэтому unknown в значениях.
                  const items: Array<{
                    kind: 'topic' | 'task' | 'add_task' | 'remove_topic' | 'remove_task'
                    target_id?: string
                    fields: Record<string, unknown>
                  }> = []
                  for (const [tid, draft] of Object.entries(correctionTopicDrafts)) {
                    const fields: Record<string, string | null> = {}
                    if (draft.title !== undefined) fields.title = draft.title ?? ''
                    if (draft.content !== undefined) fields.content = draft.content ?? ''
                    if (draft.raised_by_org !== undefined) fields.raised_by_org = draft.raised_by_org
                    items.push({ kind: 'topic', target_id: tid, fields })
                  }
                  for (const [tid, draft] of Object.entries(correctionTaskDrafts)) {
                    const fields: Record<string, string | null> = {}
                    if (draft.title !== undefined) fields.title = draft.title ?? ''
                    if (draft.explanation !== undefined) fields.explanation = draft.explanation ?? ''
                    if (draft.assignee_org !== undefined) fields.assignee_org = draft.assignee_org
                    if (draft.due_date !== undefined) fields.due_date = draft.due_date
                    items.push({ kind: 'task', target_id: tid, fields })
                  }
                  // Новые задачи: kind=add_task — INSERT нового tasks-row
                  // (см. apply_correction_batch v2, миграция 20260522000002).
                  for (const t of correctionNewTasks) {
                    items.push({
                      kind: 'add_task',
                      fields: {
                        title: t.title,
                        explanation: t.explanation ?? '',
                        assignee_org: t.assignee_org,
                        due_date: t.due_date,
                        priority: t.priority,
                        object_ids: t.object_ids,
                        quotes: t.quotes,
                      },
                    })
                  }
                  // Удаления по замечанию: kind=remove_topic/remove_task
                  // (миграция 20260522000003). Логическое: status → removed/cancelled.
                  for (const tid of correctionTopicRemovals) {
                    items.push({ kind: 'remove_topic', target_id: tid, fields: {} })
                  }
                  for (const tid of correctionTaskRemovals) {
                    items.push({ kind: 'remove_task', target_id: tid, fields: {} })
                  }
                  const res = await fetch(`/api/protocols/${id}/corrections`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      corrected_by_entity_id: correctionHeader.corrected_by_entity_id || null,
                      correction_source: correctionHeader.correction_source,
                      correction_note: correctionHeader.correction_note,
                      items,
                    }),
                  })
                  const data = await res.json()
                  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
                  // success
                  setCorrectionMode(false)
                  setCorrectionTopicDrafts({})
                  setCorrectionTaskDrafts({})
                  setCorrectionNewTasks([])
                  setCorrectionTopicRemovals(new Set())
                  setCorrectionTaskRemovals(new Set())
                  setCorrectionAddingTask(false)
                  setCorrectionEnrichDesc('')
                  setCorrectionEnrichError('')
                  await load()
                } catch (e) {
                  setCorrectionError(e instanceof Error ? e.message : String(e))
                } finally {
                  setApplyingCorrection(false)
                }
              }

              return (
                <div className="mb-4 border border-amber-300 bg-amber-50 rounded p-4 space-y-3">
                  <div className="text-sm font-semibold text-amber-900">
                    ✎ Правки по замечанию ({draftCount} {draftCount === 1 ? 'правка' : 'правок'} в черновике)
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">От кого *</label>
                      <select
                        value={correctionHeader.corrected_by_entity_id}
                        onChange={(e) => setCorrectionHeader({ ...correctionHeader, corrected_by_entity_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
                      >
                        <option value="">— выберите юр.лицо —</option>
                        {meetingEntities.map((e) => (
                          <option key={e.id} value={e.id}>{e.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Канал</label>
                      <select
                        value={correctionHeader.correction_source}
                        onChange={(e) => setCorrectionHeader({ ...correctionHeader, correction_source: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
                      >
                        <option value="Telegram">Telegram</option>
                        <option value="Email">Email</option>
                        <option value="Письмо">Письмо</option>
                        <option value="Устно">Устно</option>
                        <option value="Другое">Другое</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Комментарий</label>
                    <textarea
                      value={correctionHeader.correction_note}
                      onChange={(e) => setCorrectionHeader({ ...correctionHeader, correction_note: e.target.value })}
                      rows={2}
                      placeholder="Краткое пояснение, что правит организация и почему"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm bg-white"
                    />
                  </div>
                  {correctionError && (
                    <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                      {correctionError}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={applyBatch}
                      disabled={!canApply}
                      className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 text-sm"
                    >
                      {applyingCorrection ? 'Применение…' : `✅ Применить (${draftCount})`}
                    </button>
                  </div>
                </div>
              )
            })()}

            {/* Блок «+ Добавить задачу по замечанию» — только на табе задач,
                в режиме правки. По кнопке открывается inline-форма ввода описания;
                после LLM-обогащения / ручной кнопки — модалка TaskEditor. */}
            {correctionMode && reviewTab === 'tasks' && (
              <div className="mb-4 border border-amber-200 bg-amber-50/50 rounded p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-amber-900">
                    Новые задачи по замечанию{correctionNewTasks.length > 0 && ` (${correctionNewTasks.length})`}
                  </div>
                  {!correctionAddingTask && (
                    <button
                      onClick={() => {
                        setCorrectionAddingTask(true)
                        setCorrectionEnrichError('')
                      }}
                      className="text-sm text-amber-700 hover:text-amber-900 border border-amber-300 rounded px-3 py-1 bg-white"
                    >
                      + Добавить задачу
                    </button>
                  )}
                </div>

                {/* Список уже добавленных черновиков с возможностью править/удалить */}
                {correctionNewTasks.length > 0 && (
                  <div className="space-y-2">
                    {correctionNewTasks.map((t, idx) => (
                      <div key={idx} className="bg-white border border-amber-200 rounded p-2 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900 truncate">{t.title}</div>
                            {t.explanation && (
                              <div className="text-xs text-gray-600 mt-0.5 line-clamp-2">{t.explanation}</div>
                            )}
                            <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                              {t.assignee_org && <span>→ {t.assignee_org}</span>}
                              {t.due_date && <span>📅 {t.due_date}</span>}
                              <span>prio: {t.priority}</span>
                              {t.object_ids.length > 0 && (
                                <span>· {t.object_ids.length} объект{t.object_ids.length === 1 ? '' : 'а'}</span>
                              )}
                              {t.quotes.length > 0 && <span>· {t.quotes.length} цит.</span>}
                            </div>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <button
                              onClick={() => {
                                setCorrectionNewTaskDraft(t)
                                setCorrectionNewTaskEditingIdx(idx)
                              }}
                              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                            >
                              ✎
                            </button>
                            <button
                              onClick={() => {
                                setCorrectionNewTasks((prev) => prev.filter((_, i) => i !== idx))
                              }}
                              className="text-xs px-2 py-1 border border-red-300 text-red-700 rounded hover:bg-red-50"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Inline-форма ввода описания + кнопки enrich/manual */}
                {correctionAddingTask && (
                  <div className="border border-amber-300 rounded p-3 bg-white space-y-2">
                    <label className="block text-xs text-gray-600">
                      Краткое описание задачи (1-2 предложения о том, что нужно добавить)
                    </label>
                    <textarea
                      value={correctionEnrichDesc}
                      onChange={(e) => setCorrectionEnrichDesc(e.target.value)}
                      rows={2}
                      placeholder="Например: ИП Симоненко передаёт документацию по геологии в срок до 25.05"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                    {!meeting.transcription_path && (
                      <div className="text-xs text-gray-500">
                        У собрания нет транскрипции — LLM-обогащение недоступно. Заполните задачу вручную.
                      </div>
                    )}
                    {correctionEnrichError && (
                      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                        {correctionEnrichError}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        onClick={() => {
                          setCorrectionAddingTask(false)
                          setCorrectionEnrichDesc('')
                          setCorrectionEnrichError('')
                        }}
                        className="text-sm px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50"
                      >
                        Отмена
                      </button>
                      <button
                        onClick={openNewTaskDraftEmpty}
                        className="text-sm px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50"
                      >
                        Заполнить вручную
                      </button>
                      <button
                        onClick={enrichTaskForCorrection}
                        disabled={
                          !correctionEnrichDesc.trim() ||
                          !meeting.transcription_path ||
                          correctionEnriching
                        }
                        className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                      >
                        {correctionEnriching ? '…' : '✨ Найти в транскрипции'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {reviewError && (
              <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                {reviewError}
              </div>
            )}

            {meeting.status === 'planned' || meeting.status === 'transcript_uploaded' ? (
              <p className="text-sm text-gray-500">
                Завершите загрузку транскрипции и LLM-обработку — здесь появятся извлечённые
                задачи и темы для ревью.
              </p>
            ) : (
              <>
                {/* Табы */}
                <div className="flex border-b border-gray-200 mb-4">
                  <button
                    onClick={() => setReviewTab('topics')}
                    className={`px-4 py-2 text-sm font-medium border-b-2 ${
                      reviewTab === 'topics'
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-gray-500 hover:text-gray-800'
                    }`}
                  >
                    Темы ({topics.filter((t) => t.status !== 'removed').length})
                  </button>
                  <button
                    onClick={() => setReviewTab('tasks')}
                    className={`px-4 py-2 text-sm font-medium border-b-2 ${
                      reviewTab === 'tasks'
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-gray-500 hover:text-gray-800'
                    }`}
                  >
                    Задачи ({tasks.length})
                  </button>
                </div>

                {/* Список */}
                {reviewTab === 'topics' ? (
                  <TopicList
                    topics={topics}
                    canEdit={meeting.status === 'processed'}
                    correctionMode={correctionMode}
                    correctionDrafts={correctionTopicDrafts}
                    correctionRemovals={correctionTopicRemovals}
                    onToggleRemove={(t) => {
                      setCorrectionTopicRemovals((prev) => {
                        const next = new Set(prev)
                        if (next.has(t.id)) next.delete(t.id)
                        else next.add(t.id)
                        return next
                      })
                    }}
                    onEdit={(t) => setEditingTopic(t)}
                    onDelete={deleteTopic}
                    objectName={objectShortName}
                    objectCode={objectCode}
                    onRemoveObject={(meeting.status === 'processed' || correctionMode) ? removeTopicObject : undefined}
                  />
                ) : (
                  <TaskList
                    tasks={tasks}
                    canEdit={meeting.status === 'processed'}
                    correctionMode={correctionMode}
                    correctionDrafts={correctionTaskDrafts}
                    correctionRemovals={correctionTaskRemovals}
                    onToggleRemove={(t) => {
                      setCorrectionTaskRemovals((prev) => {
                        const next = new Set(prev)
                        if (next.has(t.id)) next.delete(t.id)
                        else next.add(t.id)
                        return next
                      })
                    }}
                    onEdit={(t) => setEditingTask(t)}
                    onDelete={deleteTask}
                    objectName={objectShortName}
                    objectCode={objectCode}
                    onRemoveObject={(meeting.status === 'processed' || correctionMode) ? removeTaskObject : undefined}
                  />
                )}
              </>
            )}
          </section>
        )
      })()}

      {editingTopic && (
        <TopicEditor
          topic={editingTopic}
          allObjects={objects}
          allEntities={meetingEntities}
          mode={correctionMode ? 'correction' : 'normal'}
          onSave={correctionMode
            ? async (t) => {
                // Собираем diff с оригиналом и кладём в черновик
                const orig = topics.find((x) => x.id === t.id)
                if (!orig) { setEditingTopic(null); return false }
                const draft: Partial<Topic> = {}
                if (t.title !== orig.title) draft.title = t.title
                if (t.content !== orig.content) draft.content = t.content
                if (t.raised_by_org !== orig.raised_by_org) draft.raised_by_org = t.raised_by_org
                if (Object.keys(draft).length > 0) {
                  setCorrectionTopicDrafts({ ...correctionTopicDrafts, [t.id]: draft })
                }
                setEditingTopic(null)
                return true
              }
            : saveTopic}
          onCancel={() => setEditingTopic(null)}
          onConvertToTask={correctionMode ? undefined : (t) => { setEditingTopic(null); setConvertingTopic(t) }}
        />
      )}
      {editingTask && (
        <TaskEditor
          task={editingTask}
          allObjects={objects}
          allEntities={meetingEntities}
          mode={correctionMode ? 'correction' : 'normal'}
          onSave={correctionMode
            ? async (t) => {
                const orig = tasks.find((x) => x.id === t.id)
                if (!orig) { setEditingTask(null); return false }
                const draft: Partial<Task> = {}
                if (t.title !== orig.title) draft.title = t.title
                if ((t.explanation ?? '') !== (orig.explanation ?? '')) draft.explanation = t.explanation
                if (t.assignee_org !== orig.assignee_org) draft.assignee_org = t.assignee_org
                if (t.due_date !== orig.due_date) draft.due_date = t.due_date
                if (Object.keys(draft).length > 0) {
                  setCorrectionTaskDrafts({ ...correctionTaskDrafts, [t.id]: draft })
                }
                setEditingTask(null)
                return true
              }
            : saveTask}
          onCancel={() => setEditingTask(null)}
          onConvertToTopic={correctionMode ? undefined : (t) => { setEditingTask(null); setConvertingTask(t) }}
        />
      )}
      {convertingTopic && (
        <ConvertTopicToTaskModal
          topic={convertingTopic}
          allObjects={objects}
          allEntities={meetingEntities}
          onClose={() => setConvertingTopic(null)}
          onSuccess={async () => {
            setConvertingTopic(null)
            await load()
            setReviewTab('tasks')
          }}
        />
      )}
      {convertingTask && (
        <ConvertTaskToTopicModal
          task={convertingTask}
          allObjects={objects}
          allEntities={meetingEntities}
          meetingDate={meeting.meeting_date}
          onClose={() => setConvertingTask(null)}
          onSuccess={async () => {
            setConvertingTask(null)
            await load()
            setReviewTab('topics')
          }}
        />
      )}
      {publishModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={closePublishModal}>
          <div
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b flex items-center justify-between">
              <h3 className="text-lg font-semibold">📤 Публикация протокола в Telegram</h3>
              <button
                onClick={closePublishModal}
                className="text-gray-400 hover:text-gray-700 text-xl leading-none"
                aria-label="Закрыть"
              >×</button>
            </div>

            <div className="p-5 space-y-4">
              {publishError && (
                <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                  {publishError}
                </div>
              )}

              {publishLoading && publishStage !== 'done' && (
                <div className="text-sm text-gray-500">
                  {publishStage === 'sending' ? 'Отправка в Telegram…' : 'Поиск привязанных чатов…'}
                </div>
              )}

              {/* Превью: текст преамбулы + список чатов */}
              {publishStage === 'preview' && !publishLoading && !publishError && publishChats.length > 0 && (
                <>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                      Текст преамбулы
                    </div>
                    <div className="border border-gray-200 bg-gray-50 rounded p-3 text-sm whitespace-pre-line font-mono">
                      {publishCaption}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                      Чаты для публикации ({publishChats.filter((c) => !c.already_published).length} новых из {publishChats.length})
                    </div>
                    <div className="border border-gray-200 rounded divide-y divide-gray-100">
                      {publishChats.map((c) => (
                        <div key={c.chat_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-800 truncate">{c.title}</div>
                            <div className="text-xs text-gray-500">
                              {c.object_code && <span className="font-mono mr-2">{c.object_code}</span>}
                              {c.object_name && <span>{c.object_name}</span>}
                              <span className="text-gray-400 ml-2">· chat_id {c.chat_id}</span>
                            </div>
                          </div>
                          {c.already_published ? (
                            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 shrink-0">
                              уже опубликовано
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">
                              новый
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="text-xs text-gray-500">
                    Файл протокола (.docx) и текст выше будут отправлены под вашим личным аккаунтом
                    в каждый «новый» чат. «Уже опубликованные» пропускаются — защита от дублей.
                  </div>
                </>
              )}

              {/* Результат отправки */}
              {publishStage === 'done' && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
                    Результат
                  </div>
                  <div className="border border-gray-200 rounded divide-y divide-gray-100">
                    {publishResults.map((r) => (
                      <div key={r.chat_id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-800 truncate">{r.title}</div>
                          {r.object_code && (
                            <div className="text-xs text-gray-500 font-mono">{r.object_code}</div>
                          )}
                          {r.error && (
                            <div className="text-xs text-red-700 mt-1">{r.error}</div>
                          )}
                        </div>
                        {r.status === 'ok' ? (
                          <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800 shrink-0">
                            ✓ отправлено (msg {r.message_id})
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800 shrink-0">
                            ✕ ошибка
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-5 border-t flex items-center justify-end gap-2">
              {publishStage === 'preview' && (
                <>
                  <button
                    onClick={closePublishModal}
                    className="text-sm px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={confirmPublish}
                    disabled={
                      publishLoading ||
                      publishChats.filter((c) => !c.already_published).length === 0
                    }
                    className="text-sm px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                  >
                    📤 Опубликовать ({publishChats.filter((c) => !c.already_published).length})
                  </button>
                </>
              )}
              {publishStage === 'done' && (
                <button
                  onClick={closePublishModal}
                  className="text-sm px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Закрыть
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {creatingItem === 'topic' && (
        <TopicEditor
          topic={{
            id: '', code: '', seq: 0, title: '', content: '', raised_by_org: null,
            status: 'preliminary', object_ids: [], quotes: [],
            discussion_date: meeting.meeting_date,
            corrected_at: null, corrected_by_entity_id: null,
            correction_source: null, correction_note: null, revisions: [],
          }}
          allObjects={objects}
          allEntities={meetingEntities}
          onSave={(t) => createTopic(t)}
          onCancel={() => setCreatingItem(null)}
        />
      )}
      {creatingItem === 'task' && (
        <TaskEditor
          task={{
            id: '', code: '', title: '', explanation: '', status: 'preliminary',
            priority: 'medium', assignee_org: null, due_date: null, object_ids: [], quotes: [],
            corrected_at: null, corrected_by_entity_id: null,
            correction_source: null, correction_note: null, revisions: [],
          }}
          allObjects={objects}
          allEntities={meetingEntities}
          onSave={(t) => createTask(t)}
          onCancel={() => setCreatingItem(null)}
        />
      )}
      {/* Модалка для новой задачи в режиме правки. Не пишет в БД сразу —
          результат складывается в correctionNewTasks и уходит одним batch'ем
          при «Применить» (как item kind='add_task'). */}
      {correctionNewTaskDraft && (
        <TaskEditor
          task={correctionNewTaskDraft}
          allObjects={objects}
          allEntities={meetingEntities}
          onSave={(t) => saveNewTaskDraft(t)}
          onCancel={() => {
            setCorrectionNewTaskDraft(null)
            setCorrectionNewTaskEditingIdx(-1)
          }}
          mode="correction"
        />
      )}

      {/* Секция 7: Закрытие задач прошлых собраний — per-object.
          У каждой задачи раскрывается список её активных объектов
          (пересечение task.object_ids ∩ meeting.object_ids). Чекбокс на
          каждую (task,object) пару. Можно закрыть задачу по части объектов.
          См. WIKI 19_Сущность_Задача → Per-object статусы. */}
      <section
        className={`bg-white border rounded shadow-sm p-5 ${
          meeting.status === 'planned' ? 'opacity-50' : ''
        }`}
      >
        <h2 className="text-lg font-semibold mb-3">
          7. Закрытие задач прошлых собраний
          {previousTasks.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({closeCount} {closeCount === 1 ? 'пара' : 'пар'} (задача × объект) отмечено)
            </span>
          )}
        </h2>

        {meeting.object_ids.length === 0 ? (
          <p className="text-sm text-gray-500">
            Объекты не выбраны в Секции 1 — нет основания искать прошлые задачи.
          </p>
        ) : previousTasks.length === 0 ? (
          <p className="text-sm text-gray-500">
            По выбранным объектам нет открытых задач прошлых собраний.
            {previouslyClosed.length > 0 && (
              <span> Уже закрыто на этом собрании: <strong>{previouslyClosed.length}</strong> задач (см. Секцию 8).</span>
            )}
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Нажмите <strong>«✓ Принять»</strong> у каждой задачи, по которой работа выполнена
              на текущем собрании — она переедет в таб «Принятые как исполненные». В этом табе
              можно вернуть обратно одним кликом до утверждения протокола. Закрытие
              <strong> per-object</strong>: если задача висит на нескольких объектах, остальные
              останутся активными.
              {previouslyClosed.length > 0 && (
                <span> Уже закрыто на этом собрании: <strong>{previouslyClosed.length}</strong> задач.</span>
              )}
            </p>

            {(() => {
              // Разделяем все пары на «open» и «closed» по состоянию closeTaskObjects.
              const pairsOpen: Array<{ task: Task; oid: string; status: string }> = []
              const pairsClosed: Array<{ task: Task; oid: string; status: string }> = []
              for (const r of previousTaskObjects) {
                const t = previousTasks.find((x) => x.id === r.task_id)
                if (!t) continue
                const isClosed = closeTaskObjects.get(t.id)?.has(r.object_id) ?? false
                ;(isClosed ? pairsClosed : pairsOpen).push({ task: t, oid: r.object_id, status: r.status })
              }
              const activePairs = closingTab === 'open' ? pairsOpen : pairsClosed
              const totalOpen = pairsOpen.length
              const totalClosed = pairsClosed.length

              // Группируем выбранные пары по объекту
              const pairsByObject = new Map<string, Array<{ task: Task; status: string }>>()
              for (const p of activePairs) {
                if (!pairsByObject.has(p.oid)) pairsByObject.set(p.oid, [])
                pairsByObject.get(p.oid)!.push({ task: p.task, status: p.status })
              }

              return (
                <>
                  {/* Табы */}
                  <div className="flex border-b border-gray-200">
                    <button
                      onClick={() => setClosingTab('open')}
                      className={`px-4 py-2 text-sm font-medium border-b-2 ${
                        closingTab === 'open'
                          ? 'border-blue-600 text-blue-700'
                          : 'border-transparent text-gray-500 hover:text-gray-800'
                      }`}
                    >
                      Открытые ({totalOpen})
                    </button>
                    <button
                      onClick={() => setClosingTab('closed')}
                      className={`px-4 py-2 text-sm font-medium border-b-2 ${
                        closingTab === 'closed'
                          ? 'border-green-600 text-green-700'
                          : 'border-transparent text-gray-500 hover:text-gray-800'
                      }`}
                    >
                      ✓ Принятые как исполненные ({totalClosed})
                    </button>
                  </div>

                  {activePairs.length === 0 ? (
                    <p className="text-sm text-gray-400 py-3">
                      {closingTab === 'open'
                        ? 'Все активные задачи прошлых собраний уже принятые. Можно утверждать протокол.'
                        : 'Пока ни одна задача не помечена как исполненная. Перейдите в «Открытые» и нажмите «✓ Принять».'}
                    </p>
                  ) : (
                    [...pairsByObject.entries()].map(([oid, pairs]) => (
                      <div key={oid} className="border border-gray-200 rounded">
                        <div className={`px-3 py-2 border-b border-gray-200 text-sm ${
                          closingTab === 'closed' ? 'bg-green-50' : 'bg-gray-50'
                        }`}>
                          <span className="font-mono text-xs text-gray-500 mr-2">
                            {objectCode(oid) || '—'}
                          </span>
                          <span className="font-medium">{objectShortName(oid)}</span>
                          <span className="ml-2 text-xs text-gray-500">
                            {pairs.length} {closingTab === 'closed' ? 'принято' : 'активны'}
                          </span>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {pairs.map(({ task: t, status }) => {
                            const overdue = t.due_date && t.due_date < (meeting.meeting_date ?? '')
                            const otherObjects = (t.object_ids ?? []).filter((x) => x !== oid)
                            const isClosed = closingTab === 'closed'
                            return (
                              <div
                                key={`${t.id}-${oid}`}
                                className={`flex items-start gap-3 px-3 py-2 text-sm ${
                                  isClosed ? 'bg-green-50/40' : ''
                                }`}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs text-gray-400 font-mono">{t.code}</span>
                                    {t.priority && (
                                      <span className={`inline-block px-1.5 py-0 rounded text-xs ${
                                        t.priority === 'high' ? 'bg-red-100 text-red-700'
                                        : t.priority === 'medium' ? 'bg-amber-100 text-amber-800'
                                        : 'bg-gray-100 text-gray-600'
                                      }`}>
                                        {t.priority}
                                      </span>
                                    )}
                                    {status === 'in_progress' && (
                                      <span className="inline-block px-1.5 py-0 rounded text-xs bg-amber-100 text-amber-700">
                                        в работе
                                      </span>
                                    )}
                                    {t.due_date && (
                                      <span className={`text-xs ${overdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                                        срок: {t.due_date}
                                      </span>
                                    )}
                                    {otherObjects.length > 0 && (
                                      <span className="text-xs text-gray-400">
                                        · ещё на {otherObjects.length} объекта{otherObjects.length === 1 ? 'х' : ''}
                                      </span>
                                    )}
                                  </div>
                                  <div className={`font-medium mt-0.5 ${isClosed ? 'text-gray-700' : 'text-gray-800'}`}>
                                    {t.title}
                                  </div>
                                  {t.assignee_org && (
                                    <div className="text-xs text-gray-500 mt-0.5">
                                      Исп.: {t.assignee_org}
                                    </div>
                                  )}
                                </div>
                                <button
                                  onClick={() => togglePrevTaskObject(t.id, oid)}
                                  className={`text-xs shrink-0 px-2 py-1 rounded border ${
                                    isClosed
                                      ? 'border-gray-300 text-gray-700 hover:bg-gray-50'
                                      : 'border-green-300 text-green-700 bg-white hover:bg-green-50'
                                  }`}
                                  title={isClosed
                                    ? 'Вернуть задачу в «Открытые»'
                                    : 'Принять задачу как исполненную на этом объекте'}
                                >
                                  {isClosed ? '↩ Вернуть' : '✓ Принять'}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </>
              )
            })()}

            {closeCount > 0 && (
              <div className="flex items-center justify-end gap-3 pt-2 sticky bottom-2">
                <button
                  onClick={() => setCloseTaskObjects(new Map())}
                  disabled={closingNow}
                  className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
                >
                  Снять отметки
                </button>
                <button
                  onClick={closeSelectedTasks}
                  disabled={closingNow}
                  className="px-5 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 text-sm font-medium"
                >
                  {closingNow
                    ? 'Закрытие…'
                    : `🔄 Переформировать протокол (закрыть ${closeCount})`}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Секция 8: Утверждение */}
      {(() => {
        const prelimTopics = topics.filter((t) => t.status === 'preliminary').length
        const prelimTasks  = tasks.filter((t) => t.status === 'preliminary').length
        const activeTopics = topics.filter((t) => t.status === 'approved').length
        const activeTasks  = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length
        const totalTopics  = topics.length
        const totalTasks   = tasks.length
        const isApproved = meeting.status === 'approved' || meeting.status === 'protocoled'
        return (
          <section
            id="section-8"
            className={`bg-white border rounded shadow-sm p-5 ${
              meeting.status !== 'processed' && !isApproved ? 'opacity-50' : ''
            }`}
          >
            <h2 className="text-lg font-semibold mb-3">8. Утверждение</h2>

            {approveError && (
              <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                {approveError}
              </div>
            )}

            {isApproved ? (
              <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded">
                <span className="text-2xl">✅</span>
                <div className="text-sm">
                  <div className="font-medium text-green-800">
                    Протокол утверждён
                  </div>
                  <div className="text-green-700">
                    Темы переведены в <code className="bg-white px-1 rounded">approved</code>,
                    задачи — в <code className="bg-white px-1 rounded">open</code>.
                    См. готовый протокол в Секции 9.
                  </div>
                </div>
              </div>
            ) : meeting.status !== 'processed' ? (
              <p className="text-sm text-gray-500">
                Сначала пройдите ревью preliminary в Секции 5.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-2">
                  <div>
                    В протоколе: <strong>{totalTopics}</strong> тем
                    {totalTopics > 0 && (
                      <span className="text-gray-500">
                        {' '}({activeTopics} активных
                        {prelimTopics > 0 && `, ${prelimTopics} к утверждению`})
                      </span>
                    )}
                    , <strong>{totalTasks}</strong> задач
                    {totalTasks > 0 && (
                      <span className="text-gray-500">
                        {' '}({activeTasks} активных
                        {prelimTasks > 0 && `, ${prelimTasks} к утверждению`})
                      </span>
                    )}.
                  </div>
                </div>
                {(prelimTopics > 0 || prelimTasks > 0) && (
                  <p className="text-sm text-gray-700">
                    Будут утверждены: <strong>{prelimTopics}</strong> тем и{' '}
                    <strong>{prelimTasks}</strong> задач. После утверждения они станут
                    активными — задачи попадут в общий список{' '}
                    <code className="bg-gray-100 px-1 rounded">/tasks</code>.
                  </p>
                )}
                {closeCount > 0 && (
                  <p className="text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded p-2">
                    Также будут закрыты <strong>{closeCount}</strong> пар (задача × объект) из прошлых собраний (Секция 7):
                    запись в <code className="bg-white px-1 rounded">task_object_status</code> со статусом{' '}
                    <code className="bg-white px-1 rounded">done</code> и датой собрания.
                  </p>
                )}
                {prelimTopics + prelimTasks === 0 && closeCount === 0 && (
                  <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">
                    Изменений в задачах и темах нет — собрание просто будет
                    переведено в статус{' '}
                    <code className="bg-white px-1 rounded">approved</code>,
                    откроется доступ к протоколу и резюме.
                  </p>
                )}
                <button
                  onClick={approveAll}
                  disabled={approving}
                  className="w-full px-6 py-3 bg-green-600 text-white rounded font-medium hover:bg-green-700 disabled:opacity-50"
                >
                  {approving ? 'Утверждение…' : '✅ Утвердить и провести по протоколу'}
                </button>
              </div>
            )}
          </section>
        )
      })()}

      {/* Секция 9: Протокол блоками */}
      {(() => {
        const isApproved = meeting.status === 'approved' || meeting.status === 'protocoled'
        const approvedTopics = topics.filter((t) => t.status === 'approved')
        const doneTasks = tasks.filter((t) => t.status === 'done' || t.status === 'closed')
        const openTasks = tasks.filter((t) => t.status === 'open' || t.status === 'in_progress')

        return (
          <section className={`bg-white border rounded shadow-sm p-5 ${!isApproved ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">9. Протокол</h2>
              {isApproved && (
                <div className="flex gap-2 items-center flex-wrap">
                  {meeting.published_at && (
                    <span
                      className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1"
                      title={`Первая публикация: ${formatDate(meeting.published_at)}`}
                    >
                      ✓ Опубликован
                    </span>
                  )}
                  <a
                    href={`/api/protocols/${id}/render?format=md`}
                    download
                    className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    ⬇ Скачать .md
                  </a>
                  <a
                    href={`/api/protocols/${id}/render?format=docx`}
                    download
                    className="text-sm px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >
                    📄 Скачать WORD
                  </a>
                  <button
                    onClick={openPublishModal}
                    disabled={publishLoading || !!meeting.published_at}
                    className="text-sm px-3 py-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={meeting.published_at
                      ? `Уже опубликован ${formatDate(meeting.published_at)}. Повторная публикация запрещена.`
                      : 'Отправить .docx-протокол в Telegram-чаты, привязанные к объектам собрания'}
                  >
                    📤 Опубликовать
                  </button>
                </div>
              )}
            </div>

            {!isApproved ? (
              <p className="text-sm text-gray-500">
                Доступно после утверждения протокола (Секция 8).
              </p>
            ) : (
              <div className="space-y-4">
                {/* Блок: Общая информация */}
                <div className="border border-gray-200 rounded p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                    Общая информация
                  </h3>
                  <dl className="grid grid-cols-[140px_1fr] gap-y-1 gap-x-3 text-sm">
                    <dt className="text-gray-500">Дата</dt>
                    <dd className="font-mono">{formatDate(meeting.meeting_date)}</dd>
                    <dt className="text-gray-500">Объекты</dt>
                    <dd>
                      {meeting.object_ids.length > 0
                        ? meeting.object_ids.map((oid) => objectShortName(oid)).join(', ')
                        : '—'}
                    </dd>
                    <dt className="text-gray-500">Предмет</dt>
                    <dd>{meeting.title}</dd>
                  </dl>
                </div>

                {/* Блок: Участники */}
                <div className="border border-gray-200 rounded p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                    Участники
                  </h3>
                  {meetingEntities.map((org, oi) => {
                    const orgContacts = (contactsByOrg[org.id] || []).filter((c) =>
                      selectedContactIds.has(c.id),
                    )
                    if (orgContacts.length === 0) return null
                    return (
                      <div key={org.id} className="mb-2">
                        <div className="text-sm font-medium text-gray-700">
                          {oi + 1}. {org.name}
                        </div>
                        <ul className="ml-4 space-y-0.5 text-sm text-gray-700">
                          {orgContacts.map((c, ci) => {
                            const fio = [c.last_name, c.first_name, c.middle_name]
                              .filter(Boolean)
                              .join(' ')
                            return (
                              <li key={c.id}>
                                {oi + 1}.{ci + 1} {fio}
                                {c.job_title && (
                                  <span className="text-gray-500"> — {c.job_title}</span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                </div>

                {/* Блок: ОБСУДИЛИ — темы без задач */}
                {approvedTopics.length > 0 && (
                  <div className="border border-gray-200 rounded p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                      ОБСУДИЛИ
                    </h3>
                    <ol className="space-y-2 text-sm">
                      {approvedTopics.map((t, i) => (
                        <li key={t.id} className="border-l-2 border-purple-300 pl-3">
                          <span className="font-medium">3.{i + 1} {t.title}</span>
                          {t.content && (
                            <div className="text-gray-700 mt-0.5">{t.content}</div>
                          )}
                          {t.raised_by_org && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              Поднял: {t.raised_by_org}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Блок: ПРИНЯЛИ КАК РЕШЁННЫЕ — задачи прошлых собраний, закрытые на этом */}
                {(previouslyClosed.length > 0 || doneTasks.length > 0) && (
                  <div className="border border-gray-200 rounded p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                      ПРИНЯЛИ КАК РЕШЁННЫЕ
                    </h3>
                    <ol className="space-y-2 text-sm">
                      {[...previouslyClosed, ...doneTasks].map((t, i) => (
                        <li key={t.id} className="border-l-2 border-green-300 pl-3">
                          <div>
                            <span className="font-medium">4.{i + 1} {t.title}</span>
                            <span className="ml-2 text-xs text-gray-400 font-mono">{t.code}</span>
                          </div>
                          {t.explanation && (
                            <div className="text-gray-700 mt-0.5">{t.explanation}</div>
                          )}
                          {t.done_note && (
                            <div className="text-xs text-gray-500 mt-0.5 italic">
                              {t.done_note}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Блок: РЕШИЛИ — открытые задачи этого собрания */}
                {openTasks.length > 0 && (
                  <div className="border border-gray-200 rounded p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                      РЕШИЛИ
                    </h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 border-b">
                          <th className="py-1 pr-2">№</th>
                          <th className="py-1 pr-2">Наименование / Пояснение</th>
                          <th className="py-1 pr-2">Ответственный</th>
                          <th className="py-1">Срок</th>
                        </tr>
                      </thead>
                      <tbody>
                        {openTasks.map((t, i) => (
                          <tr key={t.id} className="border-b border-gray-100 align-top">
                            <td className="py-1 pr-2 font-mono text-gray-500">5.{i + 1}</td>
                            <td className="py-1 pr-2">
                              <div className="font-medium">{t.title}</div>
                              {t.explanation && (
                                <div className="text-xs text-gray-600 mt-0.5">
                                  {t.explanation}
                                </div>
                              )}
                            </td>
                            <td className="py-1 pr-2 text-gray-700">{t.assignee_org || '—'}</td>
                            <td className="py-1 font-mono text-xs text-gray-600">
                              {t.due_date || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })()}

      {/* Секция 10: Резюме встречи */}
      {(() => {
        const isApproved = meeting.status === 'approved' || meeting.status === 'protocoled'
        return (
          <section className={`bg-white border rounded shadow-sm p-5 ${!isApproved ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">
                10. Резюме встречи
                {meeting.summary_md && (
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    ({summaryDirty ? 'не сохранено' : 'сохранено'})
                  </span>
                )}
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={generateSummary}
                  disabled={!isApproved || summaryGenerating}
                  className="text-sm px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:bg-gray-400"
                >
                  {summaryGenerating ? '⏳ Генерация…' : '✨ Сформировать резюме'}
                </button>
                {meeting.summary_md && (
                  <a
                    href={`/api/protocols/${id}/render?format=summary-docx`}
                    download
                    className={`text-sm px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 ${
                      summaryDirty ? 'pointer-events-none opacity-50' : ''
                    }`}
                    title={summaryDirty ? 'Сначала сохраните правки' : ''}
                  >
                    📄 Скачать WORD
                  </a>
                )}
              </div>
            </div>

            {summaryError && (
              <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                {summaryError}
              </div>
            )}

            {!isApproved ? (
              <p className="text-sm text-gray-500">
                Доступно после утверждения протокола (Секция 8).
              </p>
            ) : (
              <>
                {summaryDraft || meeting.summary_md ? (
                  <div data-color-mode="light" className="border border-gray-300 rounded overflow-hidden">
                    <MDEditor
                      value={summaryDraft}
                      onChange={(val) => {
                        const v = val ?? ''
                        setSummaryDraft(v)
                        setSummaryDirty(v !== (meeting.summary_md ?? ''))
                      }}
                      height={520}
                      preview="live"
                      visibleDragbar={false}
                    />
                  </div>
                ) : (
                  <div className="border border-dashed border-gray-300 rounded p-6 text-center text-sm text-gray-500">
                    Нажмите «✨ Сформировать резюме» — LLM создаст черновик по
                    утверждённым задачам и темам. Затем вы сможете отредактировать
                    его и сохранить.
                  </div>
                )}
                {summaryDirty && (
                  <div className="flex justify-end gap-2 mt-2">
                    <button
                      onClick={() => {
                        setSummaryDraft(meeting.summary_md ?? '')
                        setSummaryDirty(false)
                      }}
                      className="text-sm px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50"
                    >
                      Отменить
                    </button>
                    <button
                      onClick={saveSummary}
                      disabled={summarySaving}
                      className="text-sm px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400"
                    >
                      {summarySaving ? 'Сохранение…' : '💾 Сохранить'}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )
      })()}
    </div>
  )
}

// ─── Sub-components: лист и редакторы тем/задач ─────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    preliminary: { label: 'preliminary', cls: 'bg-yellow-100 text-yellow-800' },
    approved:    { label: 'approved',    cls: 'bg-green-100 text-green-700' },
    open:        { label: 'open',        cls: 'bg-blue-100 text-blue-700' },
    in_progress: { label: 'in_progress', cls: 'bg-purple-100 text-purple-700' },
    done:        { label: 'done',        cls: 'bg-gray-200 text-gray-700' },
    closed:      { label: 'closed',      cls: 'bg-gray-200 text-gray-500' },
    cancelled:   { label: 'cancelled',   cls: 'bg-red-100 text-red-700' },
    removed:     { label: 'removed',     cls: 'bg-gray-200 text-gray-500 line-through' },
  }
  const m = map[status] ?? { label: status, cls: 'bg-gray-100 text-gray-700' }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  )
}

function ChipsRow({
  ids, getCode, getName, onRemove,
}: {
  ids: string[]
  getCode: (id: string) => string
  getName: (id: string) => string
  onRemove?: (objectId: string) => void
}) {
  if (!ids || ids.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {ids.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs"
          title={getName(id)}
        >
          <span className="font-mono">{getCode(id) || id.slice(0, 8)}</span>
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(id) }}
              className="ml-0.5 leading-none text-blue-400 hover:text-red-500 hover:bg-red-50 rounded-full w-3.5 h-3.5 flex items-center justify-center"
              title={`Убрать объект ${getCode(id)}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

function TopicList({
  topics, canEdit, correctionMode, correctionDrafts, correctionRemovals,
  onEdit, onDelete, onToggleRemove, objectName, objectCode, onRemoveObject,
}: {
  topics: Topic[]
  canEdit: boolean
  correctionMode: boolean
  correctionDrafts: Record<string, Partial<Topic>>
  correctionRemovals: Set<string>
  onEdit: (t: Topic) => void
  onDelete: (t: Topic) => void
  onToggleRemove: (t: Topic) => void
  objectName: (id: string) => string
  objectCode: (id: string) => string
  onRemoveObject?: (topicId: string, objectId: string) => void
}) {
  const visible = topics.filter((t) => t.status !== 'removed')
  if (visible.length === 0) {
    return <p className="text-sm text-gray-400">Тем пока нет.</p>
  }
  return (
    <div className="space-y-2">
      {visible.map((t, idx) => {
        const hasDraft = !!correctionDrafts[t.id]
        const willRemove = correctionRemovals.has(t.id)
        const correctedAt = formatCorrectedAt(t.corrected_at)
        const lastRev = t.revisions?.[t.revisions.length - 1]
        const ordinal = t.seq && t.seq > 0 ? t.seq : idx + 1
        const cardCls = willRemove
          ? 'border border-red-400 bg-red-50/60 rounded p-3'
          : hasDraft
            ? 'border border-amber-400 bg-amber-50/50 rounded p-3'
            : 'border border-gray-200 rounded p-3 hover:bg-gray-50'
        return (
          <div key={t.id} className={cardCls}>
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 w-10 text-3xl font-bold text-gray-300 text-center leading-none pt-1 select-none"
                title={`Тема №${ordinal}`}
              >
                {ordinal}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs text-gray-400 font-mono">{t.code}</span>
                  <StatusBadge status={t.status} />
                  {correctedAt && !hasDraft && (
                    <span className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">
                      ✏ ПОПРАВЛЕНО {correctedAt}
                      {lastRev?.by_org_name ? ` (от ${lastRev.by_org_name})` : ''}
                    </span>
                  )}
                  {hasDraft && !willRemove && (
                    <span className="inline-block px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-medium">
                      ✎ Черновик правки
                    </span>
                  )}
                  {willRemove && (
                    <span className="inline-block px-2 py-0.5 rounded bg-red-200 text-red-900 text-xs font-medium">
                      ✕ К удалению
                    </span>
                  )}
                </div>
                <div className={`font-medium text-sm ${willRemove ? 'line-through text-gray-500' : ''}`}>{t.title}</div>
                {t.content && (
                  <div className={`text-sm mt-1 whitespace-pre-line ${willRemove ? 'line-through text-gray-400' : 'text-gray-600'}`}>
                    {t.content}
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-1">
                  {t.raised_by_org && (
                    <span>Поднял: <span className="text-gray-700">{t.raised_by_org}</span></span>
                  )}
                  {t.discussion_date && (
                    <span>Дата: <span className="text-gray-700 font-mono">{t.discussion_date}</span></span>
                  )}
                </div>
                <ChipsRow
                  ids={t.object_ids}
                  getCode={objectCode}
                  getName={objectName}
                  onRemove={(!willRemove && onRemoveObject) ? (oid) => onRemoveObject(t.id, oid) : undefined}
                />
                <QuotesPreview quotes={t.quotes} />
                <RevisionsHistory revisions={t.revisions} />
              </div>
              {canEdit && t.status === 'preliminary' ? (
                <div className="flex flex-col gap-1 shrink-0">
                  <button onClick={() => onEdit(t)} className="text-xs text-blue-600 hover:text-blue-800">
                    ✎ Изменить
                  </button>
                  <button onClick={() => onDelete(t)} className="text-xs text-red-600 hover:text-red-800">
                    🗑 Удалить
                  </button>
                </div>
              ) : correctionMode && t.status === 'approved' ? (
                <div className="flex flex-col shrink-0">
                  {!willRemove && (
                    <button
                      onClick={() => onEdit(t)}
                      className="text-xs text-amber-700 hover:text-amber-900"
                    >
                      ✎ Изменить (правка)
                    </button>
                  )}
                  <button
                    onClick={() => onToggleRemove(t)}
                    className={`text-xs mt-6 pt-1 border-t border-gray-200 ${willRemove ? 'text-gray-700 hover:text-gray-900' : 'text-red-700 hover:text-red-900'}`}
                  >
                    {willRemove ? '↩ Вернуть' : '🗑 Удалить (правка)'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function formatCorrectedAt(at: string | null): string | null {
  if (!at) return null
  // ISO timestamp → DD.MM.YYYY
  try {
    const d = new Date(at)
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`
  } catch {
    return at.slice(0, 10)
  }
}

function RevisionsHistory({ revisions }: { revisions: Revision[] | null | undefined }) {
  if (!revisions || revisions.length === 0) return null
  // Показываем в обратном порядке — свежие сверху
  const items = [...revisions].reverse()
  return (
    <details className="mt-2">
      <summary className="text-xs text-amber-700 cursor-pointer hover:text-amber-900 select-none">
        📜 История правок ({revisions.length})
      </summary>
      <div className="mt-1 space-y-2">
        {items.map((r, i) => {
          const at = formatCorrectedAt(r.at)
          const fields = Object.keys(r.before || {})
          return (
            <div key={i} className="border-l-2 border-amber-400 bg-amber-50/60 px-2 py-1 rounded-r">
              <div className="text-xs text-amber-900">
                <span className="font-semibold">{at}</span>
                {r.by_org_name ? ` · от ${r.by_org_name}` : ''}
                {r.source ? ` · ${r.source}` : ''}
              </div>
              {r.note && <div className="text-xs text-gray-600 mt-0.5 italic">«{r.note}»</div>}
              <div className="mt-1 space-y-1">
                {fields.map((f) => (
                  <div key={f} className="text-xs">
                    <div className="text-gray-500">
                      <strong>{f}:</strong>
                    </div>
                    <div className="text-red-700 line-through whitespace-pre-line">
                      {String(r.before[f] ?? '∅')}
                    </div>
                    <div className="text-green-700 whitespace-pre-line">
                      {String(r.after[f] ?? '∅')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function QuotesPreview({ quotes }: { quotes: Quote[] }) {
  if (!quotes || quotes.length === 0) return null
  return (
    <details className="mt-2">
      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700 select-none">
        💬 Цитаты ({quotes.length})
      </summary>
      <div className="mt-1 space-y-1">
        {quotes.map((q, i) => (
          <div
            key={i}
            className="border-l-2 border-amber-300 bg-amber-50 px-2 py-1 rounded-r"
          >
            {q.speaker_org && (
              <div className="text-xs font-semibold text-amber-800">
                {q.speaker_org}
              </div>
            )}
            <div className="text-xs text-gray-700 italic">«{q.text}»</div>
          </div>
        ))}
      </div>
    </details>
  )
}

function TaskList({
  tasks, canEdit, correctionMode, correctionDrafts, correctionRemovals,
  onEdit, onDelete, onToggleRemove, objectName, objectCode, onRemoveObject,
}: {
  tasks: Task[]
  canEdit: boolean
  correctionMode: boolean
  correctionDrafts: Record<string, Partial<Task>>
  correctionRemovals: Set<string>
  onEdit: (t: Task) => void
  onDelete: (t: Task) => void
  onToggleRemove: (t: Task) => void
  objectName: (id: string) => string
  objectCode: (id: string) => string
  onRemoveObject?: (taskId: string, objectId: string) => void
}) {
  // В режиме правки cancelled-задачи скрываем (они уже «удалённые», к показу не относятся).
  // В обычном режиме оставляем их видимыми (исторически отображались).
  const visible = correctionMode ? tasks.filter((t) => t.status !== 'cancelled') : tasks
  if (visible.length === 0) {
    return <p className="text-sm text-gray-400">Задач пока нет.</p>
  }
  const priorityColor: Record<string, string> = {
    high:   'bg-red-100 text-red-700',
    medium: 'bg-amber-100 text-amber-800',
    low:    'bg-gray-100 text-gray-600',
  }
  // Задача считается "относящейся к утверждённому протоколу" для целей правки,
  // если она не preliminary (т.е. open / in_progress / done / closed / cancelled).
  // В режиме правки мы правим только не-preliminary задачи.
  return (
    <div className="space-y-2">
      {visible.map((t, idx) => {
        const hasDraft = !!correctionDrafts[t.id]
        const willRemove = correctionRemovals.has(t.id)
        const correctedAt = formatCorrectedAt(t.corrected_at)
        const lastRev = t.revisions?.[t.revisions.length - 1]
        const codeSeq = Number(t.code.match(/-(\d+)$/)?.[1])
        const ordinal = Number.isFinite(codeSeq) && codeSeq > 0 ? codeSeq : idx + 1
        const cardCls = willRemove
          ? 'border border-red-400 bg-red-50/60 rounded p-3'
          : hasDraft
            ? 'border border-amber-400 bg-amber-50/50 rounded p-3'
            : 'border border-gray-200 rounded p-3 hover:bg-gray-50'
        return (
          <div key={t.id} className={cardCls}>
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 w-10 text-3xl font-bold text-gray-300 text-center leading-none pt-1 select-none"
                title={`Задача №${ordinal}`}
              >
                {ordinal}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs text-gray-400 font-mono">{t.code}</span>
                  <StatusBadge status={t.status} />
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${priorityColor[t.priority] ?? ''}`}>
                    {t.priority}
                  </span>
                  {correctedAt && !hasDraft && (
                    <span className="inline-block px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">
                      ✏ ПОПРАВЛЕНО {correctedAt}
                      {lastRev?.by_org_name ? ` (от ${lastRev.by_org_name})` : ''}
                    </span>
                  )}
                  {hasDraft && !willRemove && (
                    <span className="inline-block px-2 py-0.5 rounded bg-amber-200 text-amber-900 text-xs font-medium">
                      ✎ Черновик правки
                    </span>
                  )}
                  {willRemove && (
                    <span className="inline-block px-2 py-0.5 rounded bg-red-200 text-red-900 text-xs font-medium">
                      ✕ К удалению
                    </span>
                  )}
                </div>
                <div className={`font-medium text-sm ${willRemove ? 'line-through text-gray-500' : ''}`}>{t.title}</div>
                {t.explanation && (
                  <div className={`text-sm mt-1 whitespace-pre-line ${willRemove ? 'line-through text-gray-400' : 'text-gray-600'}`}>
                    {t.explanation}
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-2">
                  {t.assignee_org && <span>Исп.: <span className="text-gray-700">{t.assignee_org}</span></span>}
                  {t.due_date && <span>Срок: <span className="text-gray-700 font-mono">{t.due_date}</span></span>}
                </div>
                <ChipsRow
                  ids={t.object_ids}
                  getCode={objectCode}
                  getName={objectName}
                  onRemove={(!willRemove && onRemoveObject) ? (oid) => onRemoveObject(t.id, oid) : undefined}
                />
                <QuotesPreview quotes={t.quotes} />
                <RevisionsHistory revisions={t.revisions} />
              </div>
              {canEdit && t.status === 'preliminary' ? (
                <div className="flex flex-col gap-1 shrink-0">
                  <button onClick={() => onEdit(t)} className="text-xs text-blue-600 hover:text-blue-800">
                    ✎ Изменить
                  </button>
                  <button onClick={() => onDelete(t)} className="text-xs text-red-600 hover:text-red-800">
                    🗑 Удалить
                  </button>
                </div>
              ) : correctionMode && t.status !== 'preliminary' ? (
                <div className="flex flex-col shrink-0">
                  {!willRemove && (
                    <button
                      onClick={() => onEdit(t)}
                      className="text-xs text-amber-700 hover:text-amber-900"
                    >
                      ✎ Изменить (правка)
                    </button>
                  )}
                  <button
                    onClick={() => onToggleRemove(t)}
                    className={`text-xs mt-6 pt-1 border-t border-gray-200 ${willRemove ? 'text-gray-700 hover:text-gray-900' : 'text-red-700 hover:text-red-900'}`}
                  >
                    {willRemove ? '↩ Вернуть' : '🗑 Удалить (правка)'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function QuotesEditor({
  quotes,
  onChange,
}: {
  quotes: Quote[]
  onChange: (q: Quote[]) => void
}) {
  const [newSpeaker, setNewSpeaker] = useState('')
  const [newText, setNewText] = useState('')

  function addQuote() {
    const text = newText.trim()
    if (!text) return
    onChange([...quotes, { speaker_org: newSpeaker.trim() || '?', text }])
    setNewSpeaker('')
    setNewText('')
  }

  function removeQuote(idx: number) {
    onChange(quotes.filter((_, i) => i !== idx))
  }

  function updateQuote(idx: number, patch: Partial<Quote>) {
    onChange(quotes.map((q, i) => (i === idx ? { ...q, ...patch } : q)))
  }

  return (
    <div className="space-y-2">
      {quotes.length === 0 && (
        <p className="text-xs text-gray-400">Цитат нет</p>
      )}
      {quotes.map((q, i) => (
        <div
          key={i}
          className="border border-gray-200 rounded p-2 bg-amber-50 relative"
        >
          <button
            onClick={() => removeQuote(i)}
            className="absolute top-1 right-1 text-gray-400 hover:text-red-600 text-sm leading-none w-5 h-5 flex items-center justify-center"
            title="Удалить цитату"
          >
            ×
          </button>
          <input
            type="text"
            value={q.speaker_org}
            onChange={(e) => updateQuote(i, { speaker_org: e.target.value })}
            placeholder="Спикер / организация"
            className="w-full mb-1 px-2 py-1 border-0 bg-transparent text-xs font-semibold text-amber-800 focus:outline-none focus:bg-white focus:ring-1 focus:ring-amber-300 rounded"
          />
          <textarea
            value={q.text}
            onChange={(e) => updateQuote(i, { text: e.target.value })}
            rows={2}
            className="w-full px-2 py-1 border-0 bg-transparent text-xs text-gray-700 focus:outline-none focus:bg-white focus:ring-1 focus:ring-amber-300 rounded resize-y"
          />
        </div>
      ))}
      <div className="border border-dashed border-gray-300 rounded p-2 space-y-1">
        <input
          type="text"
          value={newSpeaker}
          onChange={(e) => setNewSpeaker(e.target.value)}
          placeholder="Спикер / организация"
          className="w-full px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        <textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="Текст цитаты"
          rows={2}
          className="w-full px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y"
        />
        <button
          onClick={addQuote}
          disabled={!newText.trim()}
          className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400"
        >
          + Добавить цитату
        </button>
      </div>
    </div>
  )
}

function ObjectChecklist({
  selected, all, onChange,
}: {
  selected: string[]    // массив object UUID
  all: ObjectInfo[]
  onChange: (ids: string[]) => void
}) {
  if (all.length === 0) return <p className="text-xs text-gray-400">Нет объектов</p>
  return (
    <div className="max-h-32 overflow-y-auto border border-gray-200 rounded p-2 bg-gray-50 space-y-0.5">
      {all.map((o) => {
        const checked = selected.includes(o.id)
        return (
          <label key={o.id} className="flex items-center gap-3 text-xs cursor-pointer hover:bg-white px-1 py-0.5 rounded">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => {
                if (checked) onChange(selected.filter((c) => c !== o.id))
                else onChange([...selected, o.id])
              }}
              className="rounded shrink-0"
            />
            <span className="font-mono text-gray-500 shrink-0 whitespace-nowrap">{o.code}</span>
            <span className="truncate">{o.current_name}</span>
          </label>
        )
      })}
    </div>
  )
}

function TopicEditor({
  topic, allObjects, allEntities, onSave, onCancel, onConvertToTask,
  mode = 'normal',
}: {
  topic: Topic
  allObjects: ObjectInfo[]
  allEntities: LegalEntity[]
  onSave: (t: Topic) => Promise<boolean>
  onCancel: () => void
  onConvertToTask?: (t: Topic) => void
  mode?: 'normal' | 'correction'
}) {
  const [form, setForm] = useState<Topic>(topic)
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenError, setRegenError] = useState('')
  const isCreate = !topic.id
  const isCorrection = mode === 'correction'

  async function submit() {
    if (!form.title.trim()) return
    setSaving(true)
    await onSave({ ...form, title: form.title.trim(), content: form.content.trim() })
    setSaving(false)
  }

  async function regenerateTitle() {
    if (!form.content.trim() || isCreate) return
    setRegenerating(true)
    setRegenError('')
    try {
      const res = await fetch(`/api/topics/${topic.id}/regenerate-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: form.content, raised_by_org: form.raised_by_org }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      if (data?.title) setForm({ ...form, title: data.title })
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : String(e))
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onCancel}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b">
          <h3 className="text-lg font-semibold">
            {isCreate ? 'Новая тема «Обсудили»' : `Тема — ${topic.code}`}
            {isCorrection && (
              <span className="ml-2 text-sm font-normal text-amber-700">(правка по замечанию)</span>
            )}
          </h3>
        </div>
        <div className="p-5 space-y-3">
          {isCorrection && (
            <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded p-2 text-xs">
              Правьте только формулировки тем. Изменения попадут в черновик; всё применится одной транзакцией кнопкой «Применить» в шапке секции.
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Заголовок темы *</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {!isCreate && !isCorrection && (
                <button
                  type="button"
                  onClick={regenerateTitle}
                  disabled={regenerating || !form.content.trim()}
                  title="Сгенерировать заголовок по содержанию"
                  className="px-3 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  {regenerating ? '…' : '⚡'}
                </button>
              )}
            </div>
            {regenError && <div className="text-xs text-red-600 mt-1">{regenError}</div>}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Содержание</label>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Поднявшая организация</label>
              <select
                value={form.raised_by_org ?? ''}
                onChange={(e) => setForm({ ...form, raised_by_org: e.target.value || null })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— не указано —</option>
                {allEntities.map((e) => (
                  <option key={e.id} value={e.name}>{e.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Дата обсуждения</label>
              <input
                type="date"
                value={form.discussion_date ?? ''}
                onChange={(e) => setForm({ ...form, discussion_date: e.target.value || null })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Объекты</label>
            <ObjectChecklist
              selected={form.object_ids}
              all={allObjects}
              onChange={(ids) => setForm({ ...form, object_ids: ids })}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Цитаты из транскрипции ({form.quotes.length})
            </label>
            <QuotesEditor
              quotes={form.quotes}
              onChange={(q) => setForm({ ...form, quotes: q })}
            />
          </div>
        </div>
        <div className="p-4 border-t bg-gray-50 flex justify-between gap-3">
          <div>
            {!isCreate && !isCorrection && onConvertToTask && (
              <button
                type="button"
                onClick={() => onConvertToTask(topic)}
                disabled={saving}
                className="px-3 py-2 bg-white border border-purple-300 text-purple-700 rounded hover:bg-purple-50 disabled:opacity-50 text-sm"
              >
                ↔ Перенести в задачу
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
            >
              Отмена
            </button>
            <button
              onClick={submit}
              disabled={saving || !form.title.trim()}
              className={`px-4 py-2 ${isCorrection ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'} text-white rounded disabled:opacity-50 text-sm`}
            >
              {saving ? 'Сохранение…' : (isCorrection ? 'В черновик правки' : 'Сохранить')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskEditor({
  task, allObjects, allEntities, onSave, onCancel, onConvertToTopic,
  mode = 'normal',
}: {
  task: Task
  allObjects: ObjectInfo[]
  allEntities: LegalEntity[]
  onSave: (t: Task) => Promise<boolean>
  onCancel: () => void
  onConvertToTopic?: (t: Task) => void
  mode?: 'normal' | 'correction'
}) {
  const [form, setForm] = useState<Task>({
    ...task,
    explanation: task.explanation ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenError, setRegenError] = useState('')
  const isCreate = !task.id
  const isCorrection = mode === 'correction'

  async function submit() {
    if (!form.title.trim()) return
    setSaving(true)
    await onSave({
      ...form,
      title: form.title.trim(),
      explanation: (form.explanation ?? '').trim() || null,
    })
    setSaving(false)
  }

  async function regenerateTitle() {
    const expl = (form.explanation ?? '').trim()
    if (!expl || isCreate) return
    setRegenerating(true)
    setRegenError('')
    try {
      const res = await fetch(`/api/tasks/${task.id}/regenerate-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ explanation: expl, assignee_org: form.assignee_org }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      if (data?.title) setForm({ ...form, title: data.title })
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : String(e))
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onCancel}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b">
          <h3 className="text-lg font-semibold">
            {isCreate ? 'Новая задача' : `Задача — ${task.code}`}
            {isCorrection && (
              <span className="ml-2 text-sm font-normal text-amber-700">(правка по замечанию)</span>
            )}
          </h3>
        </div>
        <div className="p-5 space-y-3">
          {isCorrection && (
            <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded p-2 text-xs">
              Правьте формулировки задачи. Изменения попадут в черновик; всё применится одной транзакцией кнопкой «Применить» в шапке секции.
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Название *</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Подготовить X..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {!isCreate && !isCorrection && (
                <button
                  type="button"
                  onClick={regenerateTitle}
                  disabled={regenerating || !(form.explanation ?? '').trim()}
                  title="Сгенерировать заголовок по описанию"
                  className="px-3 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  {regenerating ? '…' : '⚡'}
                </button>
              )}
            </div>
            {regenError && <div className="text-xs text-red-600 mt-1">{regenError}</div>}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Описание</label>
            <textarea
              value={form.explanation ?? ''}
              onChange={(e) => setForm({ ...form, explanation: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Ответственный</label>
              <select
                value={form.assignee_org ?? ''}
                onChange={(e) => setForm({ ...form, assignee_org: e.target.value || null })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— не указан —</option>
                {allEntities.map((e) => (
                  <option key={e.id} value={e.name}>{e.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Приоритет</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value as 'high' | 'medium' | 'low' })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Срок</label>
            <input
              type="date"
              value={form.due_date ?? ''}
              onChange={(e) => setForm({ ...form, due_date: e.target.value || null })}
              className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Объекты</label>
            <ObjectChecklist
              selected={form.object_ids}
              all={allObjects}
              onChange={(ids) => setForm({ ...form, object_ids: ids })}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Цитаты из транскрипции ({form.quotes.length})
            </label>
            <QuotesEditor
              quotes={form.quotes}
              onChange={(q) => setForm({ ...form, quotes: q })}
            />
          </div>
        </div>
        <div className="p-4 border-t bg-gray-50 flex justify-between gap-3">
          <div>
            {!isCreate && !isCorrection && onConvertToTopic && (
              <button
                type="button"
                onClick={() => onConvertToTopic(task)}
                disabled={saving}
                className="px-3 py-2 bg-white border border-purple-300 text-purple-700 rounded hover:bg-purple-50 disabled:opacity-50 text-sm"
              >
                ↔ Перенести в обсудили
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
            >
              Отмена
            </button>
            <button
              onClick={submit}
              disabled={saving || !form.title.trim()}
              className={`px-4 py-2 ${isCorrection ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'} text-white rounded disabled:opacity-50 text-sm`}
            >
              {saving ? 'Сохранение…' : (isCorrection ? 'В черновик правки' : 'Сохранить')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Convert modals (topic ↔ task) ──────────────────────────────────────

type TaskDraftFields = {
  title: string
  explanation: string
  assignee_org: string | null
  priority: 'high' | 'medium' | 'low'
  due_date: string | null
  object_ids: string[]
  quotes: Quote[]
}

function ConvertTopicToTaskModal({
  topic, allObjects, allEntities, onClose, onSuccess,
}: {
  topic: Topic
  allObjects: ObjectInfo[]
  allEntities: LegalEntity[]
  onClose: () => void
  onSuccess: () => void | Promise<void>
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<TaskDraftFields>({
    title: topic.title,
    explanation: topic.content,
    assignee_org: null,
    priority: 'medium',
    due_date: null,
    object_ids: topic.object_ids ?? [],
    quotes: topic.quotes ?? [],
  })

  async function fetchRephrase() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/topics/${topic.id}/rephrase-as-task`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setForm({
        title: (data.title ?? topic.title).toString(),
        explanation: (data.explanation ?? topic.content).toString(),
        assignee_org: data.assignee_org ?? null,
        priority: (['high', 'medium', 'low'] as const).includes(data.priority) ? data.priority : 'medium',
        due_date: data.due_date ?? null,
        object_ids: Array.isArray(data.object_ids) ? data.object_ids : (topic.object_ids ?? []),
        quotes: Array.isArray(data.quotes) ? data.quotes : (topic.quotes ?? []),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRephrase() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function commit() {
    if (!form.title.trim()) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/topics/${topic.id}/convert-to-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          explanation: form.explanation.trim() || null,
          assignee_org: form.assignee_org,
          priority: form.priority,
          due_date: form.due_date,
          object_ids: form.object_ids,
          quotes: form.quotes,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      await onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold">↔ Перенос темы в задачу</h3>
          <button
            type="button"
            onClick={fetchRephrase}
            disabled={loading || saving}
            title="Перегенерировать через LLM"
            className="px-3 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            ↻ Заново
          </button>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">⏳ LLM формулирует задачу…</div>
        ) : (
          <div className="p-5 space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Название *</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Подготовить X..."
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Описание</label>
              <textarea
                value={form.explanation}
                onChange={(e) => setForm({ ...form, explanation: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Ответственный</label>
                <select
                  value={form.assignee_org ?? ''}
                  onChange={(e) => setForm({ ...form, assignee_org: e.target.value || null })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">— не указан —</option>
                  {allEntities.map((e) => (
                    <option key={e.id} value={e.name}>{e.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Приоритет</label>
                <select
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value as 'high' | 'medium' | 'low' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Срок</label>
              <input
                type="date"
                value={form.due_date ?? ''}
                onChange={(e) => setForm({ ...form, due_date: e.target.value || null })}
                className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Объекты</label>
              <ObjectChecklist
                selected={form.object_ids}
                all={allObjects}
                onChange={(ids) => setForm({ ...form, object_ids: ids })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Цитаты ({form.quotes.length})
              </label>
              <QuotesEditor
                quotes={form.quotes}
                onChange={(q) => setForm({ ...form, quotes: q })}
              />
            </div>
            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                {error}
              </div>
            )}
          </div>
        )}
        <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Отмена
          </button>
          <button
            onClick={commit}
            disabled={saving || loading || !form.title.trim()}
            className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 text-sm"
          >
            {saving ? 'Создание…' : '✅ Создать задачу'}
          </button>
        </div>
      </div>
    </div>
  )
}

type TopicDraftFields = {
  title: string
  content: string
  raised_by_org: string | null
  object_ids: string[]
  quotes: Quote[]
  discussion_date: string | null
}

function ConvertTaskToTopicModal({
  task, allObjects, allEntities, meetingDate, onClose, onSuccess,
}: {
  task: Task
  allObjects: ObjectInfo[]
  allEntities: LegalEntity[]
  meetingDate: string
  onClose: () => void
  onSuccess: () => void | Promise<void>
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<TopicDraftFields>({
    title: task.title,
    content: task.explanation ?? '',
    raised_by_org: task.assignee_org,
    object_ids: task.object_ids ?? [],
    quotes: task.quotes ?? [],
    discussion_date: meetingDate,
  })

  async function fetchRephrase() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/tasks/${task.id}/rephrase-as-topic`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setForm({
        title: (data.title ?? task.title).toString(),
        content: (data.content ?? task.explanation ?? '').toString(),
        raised_by_org: data.raised_by_org ?? task.assignee_org ?? null,
        object_ids: Array.isArray(data.object_ids) ? data.object_ids : (task.object_ids ?? []),
        quotes: Array.isArray(data.quotes) ? data.quotes : (task.quotes ?? []),
        discussion_date: meetingDate,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchRephrase() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function commit() {
    if (!form.title.trim()) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/tasks/${task.id}/convert-to-topic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          content: form.content.trim(),
          raised_by_org: form.raised_by_org,
          object_ids: form.object_ids,
          quotes: form.quotes,
          discussion_date: form.discussion_date,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      await onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold">↔ Перенос задачи в обсудили</h3>
          <button
            type="button"
            onClick={fetchRephrase}
            disabled={loading || saving}
            title="Перегенерировать через LLM"
            className="px-3 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            ↻ Заново
          </button>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">⏳ LLM формулирует тему…</div>
        ) : (
          <div className="p-5 space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Заголовок темы *</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Содержание</label>
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Поднявшая организация</label>
                <select
                  value={form.raised_by_org ?? ''}
                  onChange={(e) => setForm({ ...form, raised_by_org: e.target.value || null })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">— не указано —</option>
                  {allEntities.map((e) => (
                    <option key={e.id} value={e.name}>{e.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Дата обсуждения</label>
                <input
                  type="date"
                  value={form.discussion_date ?? ''}
                  onChange={(e) => setForm({ ...form, discussion_date: e.target.value || null })}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Объекты</label>
              <ObjectChecklist
                selected={form.object_ids}
                all={allObjects}
                onChange={(ids) => setForm({ ...form, object_ids: ids })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Цитаты ({form.quotes.length})
              </label>
              <QuotesEditor
                quotes={form.quotes}
                onChange={(q) => setForm({ ...form, quotes: q })}
              />
            </div>
            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                {error}
              </div>
            )}
          </div>
        )}
        <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50 text-sm"
          >
            Отмена
          </button>
          <button
            onClick={commit}
            disabled={saving || loading || !form.title.trim()}
            className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 text-sm"
          >
            {saving ? 'Создание…' : '✅ Создать тему'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Шапка готовности ───────────────────────────────────────────────────
// Сводка состояния по 7 пунктам пайплайна (Метаданные / Объекты / Подрядчик /
// Участники / Транскрипция / LLM-обработка / Утверждено-Событие). Каждый
// пункт — ✓ (готово) / ⚠ (есть проблема) / ☐ (не сделано). Клик по строке
// — scrollIntoView к соответствующей секции.

type ReadinessLevel = 'done' | 'warn' | 'empty'

function ReadinessRow({
  level, label, detail, anchor,
}: {
  level: ReadinessLevel
  label: string
  detail: string
  anchor?: string
}) {
  const icon = level === 'done' ? '✓' : level === 'warn' ? '⚠' : '☐'
  const iconCls =
    level === 'done' ? 'text-green-700' :
    level === 'warn' ? 'text-amber-700' :
    'text-gray-400'
  const detailCls = level === 'empty' ? 'text-gray-400' : 'text-gray-700'
  const onClick = anchor
    ? () => {
        const el = document.getElementById(anchor)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    : undefined
  return (
    <div
      onClick={onClick}
      className={`flex items-baseline gap-2 px-2 py-1 rounded text-sm ${anchor ? 'cursor-pointer hover:bg-gray-100' : ''}`}
    >
      <span className={`font-mono font-bold w-4 shrink-0 ${iconCls}`}>{icon}</span>
      <span className="w-36 shrink-0 text-gray-800">{label}</span>
      <span className={`flex-1 ${detailCls}`}>{detail}</span>
    </div>
  )
}

function ReadinessPanel({
  meeting, meetingEntities, meetingEntityRoles,
  contactCount, prelimTopics, prelimTasks,
  topicsCount, tasksCount, meetingEventExists,
}: {
  meeting: { meeting_date: string; title: string; object_ids: string[]; status: string; transcription_path: string | null }
  meetingEntities: { id: string; name: string; aliases: string[] }[]
  meetingEntityRoles: Record<string, LegalEntityRole>
  contactCount: number
  prelimTopics: number
  prelimTasks: number
  topicsCount: number
  tasksCount: number
  meetingEventExists: boolean
}) {
  const hasTitle = Boolean(meeting.title?.trim())
  const hasDate = Boolean(meeting.meeting_date)
  const hasObjects = meeting.object_ids.length > 0
  const nLE = meetingEntities.length
  const contractorEntities = meetingEntities.filter((e) => meetingEntityRoles[e.id] === 'contractor')
  const hasContractor = contractorEntities.length > 0
  const hasTranscript = Boolean(meeting.transcription_path)
  const statusOrder: Record<string, number> = {
    planned: 0, transcript_uploaded: 1, processed: 2, approved: 3, protocoled: 4,
  }
  const sOrder = statusOrder[meeting.status] ?? 0
  const isProcessed = sOrder >= 2
  const isApproved = sOrder >= 3
  // Режим ручного ввода: status >= processed без файла транскрипции.
  // В этом режиме Секции 3 и 4 не применимы; темы и задачи добавляются вручную в Секции 6.
  const isManualEntry = !hasTranscript && isProcessed

  // 1. Метаданные (дата + название)
  const r1: ReadinessLevel = hasTitle && hasDate ? 'done' : 'empty'
  const r1Detail = hasTitle && hasDate
    ? `${meeting.meeting_date} · ${meeting.title}`
    : 'Заполните дату и название'

  // 2. Объекты
  const r2: ReadinessLevel = hasObjects ? 'done' : 'empty'
  const r2Detail = hasObjects
    ? `${meeting.object_ids.length} ${meeting.object_ids.length === 1 ? 'объект' : meeting.object_ids.length < 5 ? 'объекта' : 'объектов'} обсуждения`
    : 'Не выбраны — обязательны для approve и создания события'

  // 3. Юр.лица + подрядчик
  let r3: ReadinessLevel = 'empty'
  let r3Detail = 'Не выбрано ни одно юр.лицо'
  if (nLE > 0) {
    if (hasContractor) {
      r3 = 'done'
      const cNames = contractorEntities.map((e) => e.aliases[0] ?? e.name).join(', ')
      r3Detail = `${nLE} юр.лиц · подрядчик: ${cNames}`
    } else {
      r3 = 'warn'
      r3Detail = `${nLE} юр.лиц — ни у одного нет роли «Подрядчик» (customer-only собрание?)`
    }
  }

  // 4. Участники (контакты)
  let r4: ReadinessLevel = 'empty'
  let r4Detail = nLE === 0 ? 'Сначала выберите юр.лица' : 'Не выбран ни один контакт'
  if (contactCount > 0) {
    r4 = 'done'
    r4Detail = `${contactCount} ${contactCount === 1 ? 'контакт' : contactCount < 5 ? 'контакта' : 'контактов'} из ${nLE} юр.лиц`
  } else if (nLE > 0) {
    r4 = 'warn'
  }

  // 5. Транскрипция (или маркер «ручной ввод»)
  let r5: ReadinessLevel = 'empty'
  let r5Detail = 'Загрузите транскрипцию (.csv / .docx / .txt)'
  if (hasTranscript) {
    r5 = 'done'
    r5Detail = 'Файл загружен'
  } else if (isManualEntry) {
    r5 = 'done'
    r5Detail = '✍️ Ручной ввод (без транскрипции и LLM)'
  }

  // 6. LLM-обработка + ревью (либо ручной набор пунктов в режиме manual entry)
  let r6: ReadinessLevel = 'empty'
  let r6Detail = isManualEntry ? 'Добавьте темы и задачи в Секции 6' : 'Ждёт LLM-обработки'
  if (isProcessed) {
    const prelim = prelimTopics + prelimTasks
    const label = isManualEntry ? 'Ручной набор' : 'LLM-обработка'
    if (prelim > 0 && !isApproved) {
      r6 = 'warn'
      r6Detail = `${label}: ${topicsCount} тем · ${tasksCount} задач (${prelim} preliminary — нужно ревью)`
    } else if (isManualEntry && topicsCount === 0 && tasksCount === 0 && !isApproved) {
      r6 = 'warn'
      r6Detail = 'Ручной ввод — пунктов пока нет, добавьте в Секции 6'
    } else {
      r6 = 'done'
      r6Detail = `${label}: ${topicsCount} тем · ${tasksCount} задач`
    }
  }

  // 7. Утверждение + событие
  let r7: ReadinessLevel = 'empty'
  let r7Detail = 'Не утверждено'
  if (isApproved) {
    if (meetingEventExists) {
      r7 = 'done'
      r7Detail = meeting.status === 'protocoled' ? 'Утверждено и протокол скачан · событие в журнале' : 'Утверждено · событие в журнале'
    } else {
      r7 = 'warn'
      r7Detail = 'Утверждено, но событие в журнале не найдено (нет объектов или юр.лиц?)'
    }
  }

  return (
    <section className="bg-white border rounded shadow-sm p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-2 font-semibold">
        Готовность собрания
      </div>
      <div className="space-y-0.5">
        <ReadinessRow level={r1} label="Метаданные"    detail={r1Detail} anchor="section-1" />
        <ReadinessRow level={r2} label="Объекты"       detail={r2Detail} anchor="section-1" />
        <ReadinessRow level={r3} label="Юр.лица"       detail={r3Detail} anchor="section-1" />
        <ReadinessRow level={r4} label="Участники"     detail={r4Detail} anchor="section-2" />
        <ReadinessRow level={r5} label="Транскрипция"  detail={r5Detail} anchor="section-3" />
        <ReadinessRow level={r6} label="LLM-обработка" detail={r6Detail} anchor="section-6" />
        <ReadinessRow level={r7} label="Утверждение"   detail={r7Detail} anchor="section-8" />
      </div>
    </section>
  )
}
