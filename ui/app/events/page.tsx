'use client'

import { useEffect, useMemo, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import MultiSelectPopover from '@/components/MultiSelectPopover'
import { EntityLinksBlock, type LinkPhase, type GenericLink } from '@/components/EntityLinksBlock'
import { EntityLinkPicker } from '@/components/EntityLinkPicker'
import { TasksOnEventBlock } from '@/components/TasksOnEventBlock'
import { CreateTaskFromEventModal } from '@/components/CreateTaskFromEventModal'
import type { EntityKind } from '@/lib/entityRef'

// Фазы жизненного цикла связей события — для общего EntityLinksBlock.
// «Источник» агрегирует 4 link_type (from_document/from_letter/from_meeting/from_protocol).
// «Связанные» — универсальная related_to связь.
// «Закрывает план» (fulfills) для calendar_entry — отложено: kind не поддержан в EntityKind.
const EVENT_LINK_PHASES: LinkPhase[] = [
  {
    linkType: ['from_document', 'from_letter', 'from_meeting', 'from_protocol'],
    defaultAddLinkType: 'from_document',
    icon: '📋', label: 'Источник',
    color: 'border-blue-400 bg-blue-50',
    addHint: 'Привязать источник: договор / письмо / собрание / протокол',
  },
  {
    linkType: 'related_to',
    icon: '🔄', label: 'Связанные действия',
    color: 'border-amber-400 bg-amber-50',
    addHint: 'Привязать связанную сущность (без причинно-следственного типа)',
  },
]
import { optionIconPrefix } from '@/lib/objects/iconLabel'

// События — это всегда фактовый журнал (project_note / meeting / protocol_correction).
// Плановые/договорные вехи живут в calendar_entries (см. WIKI 15_Календарь_объекта).
type Importance = 'low' | 'normal' | 'high' | 'critical'

type Event = {
  id: string
  event_type: string
  title: string | null
  date_end: string | null
  date_start: string | null
  date_computed: string | null
  event_time: string | null        // 'HH:MM:SS' или null
  object_ids: string[] | null
  stage_name: string | null
  note: string | null
  importance: Importance           // low|normal|high|critical, default normal
  created_at: string
  created_by: string | null                  // auth.users.id автора (заполняется триггером из auth.uid)
  derived_source: string | null              // manual | tg | mail | bitrix | contract | protocol
  classifier_template_code: string | null    // если из автомата — какой шаблон
  // С 2026-05-18: привязка к этапу договора (для любого event_type, не только contract_stage_change)
  contract_stage_id: string | null
  subject_document_id: string | null
}

type UserRef = { id: string; name: string; email: string }

type ContractStageRef = {
  id: string
  document_id: string
  stage_number: number
  stage_name: string
}

const IMPORTANCE_LABEL: Record<Importance, string> = {
  low: 'Низкая',
  normal: 'Обычная',
  high: 'Важная',
  critical: 'Критическая',
}

const IMPORTANCE_ICON: Record<Importance, string> = {
  low: '○',          // пустой кружок
  normal: '·',       // незаметная точка
  high: '★',         // звезда
  critical: '🔥',    // огонь
}

const IMPORTANCE_BADGE: Record<Importance, string> = {
  low:      'bg-gray-100 text-gray-500',
  normal:   'bg-transparent text-gray-400',
  high:     'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
}

type Attachment = {
  id: string
  event_id: string
  kind: string
  file_name: string
  file_path: string
  file_size: number | null
  mime_type: string | null
  summary: string | null
  summary_at: string | null
  indexed_at: string | null
  created_at: string
}

type ClauseLink = {
  event_id: string
  clause_id: string
  order_index: number
  description: string
  document_id: string
  document_title: string
}

type Subtype = { code: string; category: string; label: string; icon: string }
type ObjectRef = { id: string; code: string; current_name: string; color: string | null; icon: string | null; icon_small: string | null }
type LegalEntity = { id: string; name: string; short_name: string | null }
type EntityLink = { id: string; from_id: string; to_type: string; to_id: string; link_type: string; notes: string | null }

// Минимальный референс задачи для inverse-секции в карточке события
type TaskRef = {
  id: string
  code: string
  title: string
  status: string
  priority: string | null
  assignee_entity_id: string | null
  due_date: string | null
  object_ids: string[] | null
}

// task → event связь (raised_from / related_to / resolved_by)
type TaskToEventLink = {
  id: string
  from_id: string         // task.id
  to_id: string           // event.id
  link_type: 'raised_from' | 'related_to' | 'resolved_by'
  notes: string | null
}

const TASK_LINK_PHASE_META: Record<TaskToEventLink['link_type'], { icon: string; label: string; color: string }> = {
  raised_from: { icon: '📌', label: 'Поставлены на событии', color: 'border-blue-400 bg-blue-50' },
  related_to:  { icon: '🔄', label: 'Связанные с событием',  color: 'border-amber-400 bg-amber-50' },
  resolved_by: { icon: '✅', label: 'Закрыты этим событием', color: 'border-green-400 bg-green-50' },
}

const TASK_STATUS_BADGE: Record<string, string> = {
  preliminary: 'bg-gray-100 text-gray-600',
  open:        'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  done:        'bg-green-100 text-green-700',
  closed:      'bg-gray-200 text-gray-600',
  cancelled:   'bg-red-100 text-red-600',
}
type DocRef = { id: string; title: string }

const CATEGORY_LABELS: Record<string, string> = {
  fin: 'Финансы',
  work: 'Работы',
  appr: 'Согласование',
  exec: 'Исполнение',
  system: 'Системные',
}

const CATEGORY_BADGE: Record<string, string> = {
  fin:    'bg-emerald-100 text-emerald-700',
  work:   'bg-blue-100 text-blue-700',
  appr:   'bg-violet-100 text-violet-700',
  exec:   'bg-amber-100 text-amber-700',
  system: 'bg-gray-100 text-gray-600',
}

function formatDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function monthKey(s: string | null): string {
  if (!s) return '0000-00'
  return s.slice(0, 7)
}

function monthLabel(key: string): string {
  if (!key || key === '0000-00') return 'Без даты'
  const [y, m] = key.split('-')
  const months = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
  return `${months[parseInt(m) - 1]} ${y}`
}

// ─── EventLinkModal ──────────────────────────────────────────────────────────

function EventLinkModal({
  event,
  links,
  clauseLinks,
  objects,
  entities,
  docs,
  subtypes,
  contractStages,
  meetings,
  letters,
  allEvents,
  tasksRef,
  taskEventLinks,
  onClose,
  onLinksChanged,
  onEventChanged,
  onDeleted,
  onAddLink,
  onDeleteLink,
  onCreateTask,
  onLinkExistingTask,
  onUnlinkTask,
}: {
  event: Event
  links: EntityLink[]
  clauseLinks: ClauseLink[]
  objects: ObjectRef[]
  entities: LegalEntity[]
  docs: DocRef[]
  subtypes: Subtype[]
  contractStages: ContractStageRef[]
  /** Реестры для отображения имён в EntityLinksBlock (резолвинг to_id → имя). */
  meetings: Array<{ id: string; code: string | null; title: string | null; meeting_date: string; object_ids: string[] | null }>
  letters: Array<{ id: string; subject: string; date: string | null; direction: string | null }>
  allEvents: Event[]
  /** Реестр задач + inverse-связи для секции «Задачи на событии». */
  tasksRef: TaskRef[]
  taskEventLinks: TaskToEventLink[]
  onClose: () => void
  onLinksChanged: () => void
  onEventChanged: () => void
  onDeleted: () => void
  /** Открыть EntityLinkPicker для добавления связи указанного типа. */
  onAddLink: (linkType: string) => void
  /** Удалить связь по id. */
  onDeleteLink: (linkId: string) => void
  /** Открыть форму создания НОВОЙ задачи из события. */
  onCreateTask: () => void
  /** Открыть пикер привязки СУЩЕСТВУЮЩЕЙ задачи к событию в указанной фазе. */
  onLinkExistingTask: (linkType: 'raised_from' | 'related_to' | 'resolved_by') => void
  /** Открепить задачу от события (удаление task→event entity_link). */
  onUnlinkTask: (linkId: string) => Promise<void>
}) {
  const myLinks = links.filter((l) => l.from_id === event.id)
  const objLinks = myLinks.filter((l) => l.to_type === 'object')
  const docLinks = myLinks.filter((l) => l.to_type === 'document')
  const leLinks  = myLinks.filter((l) => l.to_type === 'legal_entity')
  const myClauses = clauseLinks.filter((l) => l.event_id === event.id)

  // Объекты — основной канал events.object_ids (UUID).
  // Дополнительно — legacy entity_links типа object (если есть «осиротевшие» связи).
  const objectIdsFromEvent: string[] = event.object_ids ?? []
  const objectIdsFromLinks: string[] = objLinks
    .map((l) => l.to_id)
    .filter((id) => !objectIdsFromEvent.includes(id))
  const allObjectIds = [...objectIdsFromEvent, ...objectIdsFromLinks]

  const [saving,     setSaving]     = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [titleDraft, setTitleDraft] = useState(event.title ?? '')
  const [noteDraft,  setNoteDraft]  = useState(event.note ?? '')
  const [dateDraft,  setDateDraft]  = useState(event.date_end ?? '')
  const [timeDraft,  setTimeDraft]  = useState((event.event_time ?? '').slice(0, 5))
  const [typeDraft,  setTypeDraft]  = useState(event.event_type)

  async function saveTitle() {
    const newTitle = titleDraft.trim()
    if ((event.title ?? '') === newTitle) return
    if (!newTitle) { setTitleDraft(event.title ?? ''); return }  // пустой — откатываем
    setSaving(true)
    // Публикация в news — через триггер events_publish_on_title_change
    // (срабатывает на UPDATE OF title, когда заменили placeholder 'Новое событие').
    await supabase.from('events').update({ title: newTitle }).eq('id', event.id)
    setSaving(false)
    onEventChanged()
  }

  async function saveNote() {
    if ((event.note ?? '') === noteDraft) return
    setSaving(true)
    await supabase.from('events').update({ note: noteDraft || null }).eq('id', event.id)
    setSaving(false)
    onEventChanged()
  }

  async function saveDateTime() {
    const dateChanged = dateDraft !== (event.date_end ?? '')
    const newTime = timeDraft || null  // пустая строка → null
    const oldTime = (event.event_time ?? '').slice(0, 5) || null
    const timeChanged = newTime !== oldTime
    if (!dateChanged && !timeChanged) return
    if (!dateDraft) return  // пустая дата запрещена
    setSaving(true)
    const update: Record<string, unknown> = {}
    if (dateChanged) {
      update.date_end = dateDraft
      update.date_start = dateDraft
      // date_computed обновится триггером trg_events_simple_compute_date
    }
    if (timeChanged) update.event_time = newTime
    await supabase.from('events').update(update).eq('id', event.id)
    setSaving(false)
    onEventChanged()
  }

  async function removeLink(l: EntityLink) {
    await supabase
      .from('entity_links')
      .delete()
      .match({ from_type: 'event', from_id: event.id, to_type: l.to_type, to_id: l.to_id, link_type: l.link_type })
    onLinksChanged()
  }

  // Удалить объект из события: сначала из events.object_ids,
  // и заодно убрать legacy-запись из entity_links (если есть).
  async function removeObject(oid: string) {
    setSaving(true)
    if (objectIdsFromEvent.includes(oid)) {
      const newIds = objectIdsFromEvent.filter((x) => x !== oid)
      await supabase.from('events').update({ object_ids: newIds }).eq('id', event.id)
    }
    const legacy = objLinks.find((l) => l.to_id === oid)
    if (legacy) {
      await supabase
        .from('entity_links')
        .delete()
        .match({ from_type: 'event', from_id: event.id, to_type: 'object', to_id: oid, link_type: legacy.link_type })
    }
    setSaving(false)
    onEventChanged()
    onLinksChanged()
  }

  // Добавить объект к событию — пишем в канонический канал events.object_ids
  async function addObjectToEvent(oid: string) {
    if (!oid) return
    if (objectIdsFromEvent.includes(oid)) return
    setSaving(true)
    try {
      const newIds = [...objectIdsFromEvent, oid]
      const { error } = await supabase.from('events').update({ object_ids: newIds }).eq('id', event.id)
      if (error) { alert(`Не удалось добавить объект: ${error.message}`); return }
      onEventChanged()
    } finally {
      setSaving(false)
    }
  }

  // ─── Batch-apply для multi-select popover'ов ─────────────────────────────
  // Получают новый список selected, вычисляют diff и применяют изменения.

  async function applyObjects(newList: string[]) {
    const toAdd    = newList.filter((x) => !allObjectIds.includes(x))
    const toRemove = allObjectIds.filter((x) => !newList.includes(x))
    if (toAdd.length === 0 && toRemove.length === 0) return
    setSaving(true)
    try {
      // 1) Обновляем events.object_ids одним UPDATE — добавление + удаление текущих
      const fromEvent = objectIdsFromEvent
      const finalIds = [
        ...fromEvent.filter((x) => !toRemove.includes(x)),
        ...toAdd,
      ]
      const { error } = await supabase.from('events').update({ object_ids: finalIds }).eq('id', event.id)
      if (error) { alert(`Не удалось сохранить объекты: ${error.message}`); return }
      // 2) Чистим legacy entity_links для удалённых (если были)
      for (const oid of toRemove) {
        const legacy = objLinks.find((l) => l.to_id === oid)
        if (legacy) {
          await supabase
            .from('entity_links')
            .delete()
            .match({ from_type: 'event', from_id: event.id, to_type: 'object', to_id: oid, link_type: legacy.link_type })
        }
      }
    } finally {
      setSaving(false)
      onEventChanged()
      onLinksChanged()
    }
  }

  async function applyEntities(newList: string[]) {
    const cur = leLinks.map((l) => l.to_id)
    const toAdd    = newList.filter((x) => !cur.includes(x))
    const toRemove = cur.filter((x) => !newList.includes(x))
    if (toAdd.length === 0 && toRemove.length === 0) return
    setSaving(true)
    try {
      for (const id of toAdd) {
        await supabase.from('entity_links').insert({
          from_type: 'event', from_id: event.id,
          to_type: 'legal_entity', to_id: id,
          link_type: 'belongs_to',
        })
      }
      for (const id of toRemove) {
        const l = leLinks.find((x) => x.to_id === id)
        if (l) {
          await supabase
            .from('entity_links')
            .delete()
            .match({ from_type: 'event', from_id: event.id, to_type: l.to_type, to_id: l.to_id, link_type: l.link_type })
        }
      }
    } finally {
      setSaving(false)
      onLinksChanged()
    }
  }

  async function applyDocs(newList: string[]) {
    const cur = docLinks.map((l) => l.to_id)
    const toAdd    = newList.filter((x) => !cur.includes(x))
    const toRemove = cur.filter((x) => !newList.includes(x))
    if (toAdd.length === 0 && toRemove.length === 0) return
    setSaving(true)
    try {
      for (const id of toAdd) {
        await supabase.from('entity_links').insert({
          from_type: 'event', from_id: event.id,
          to_type: 'document', to_id: id,
          link_type: 'belongs_to',
        })
      }
      for (const id of toRemove) {
        const l = docLinks.find((x) => x.to_id === id)
        if (l) {
          await supabase
            .from('entity_links')
            .delete()
            .match({ from_type: 'event', from_id: event.id, to_type: l.to_type, to_id: l.to_id, link_type: l.link_type })
        }
      }
    } finally {
      setSaving(false)
      onLinksChanged()
    }
  }

  // Сменить важность события
  async function saveImportance(newVal: Importance) {
    if (newVal === event.importance) return
    setSaving(true)
    try {
      const { error } = await supabase.from('events').update({ importance: newVal }).eq('id', event.id)
      if (error) { alert(`Не удалось сохранить важность: ${error.message}`); return }
      onEventChanged()
    } finally {
      setSaving(false)
    }
  }

  // ─── Сохранение и закрытие ───────────────────────────────────────────────
  // Все поля сохраняются по onBlur — здесь мы только дожимаем «висящие» drafts
  // (если пользователь нажал «Сохранить» не уйдя из textarea).
  function hasPendingChanges(): boolean {
    return (
      titleDraft.trim() !== (event.title ?? '') ||
      noteDraft !== (event.note ?? '') ||
      dateDraft !== (event.date_end ?? '') ||
      (timeDraft || null) !== ((event.event_time ?? '').slice(0, 5) || null)
    )
  }

  async function flushDrafts(): Promise<void> {
    // Последовательно сохраняем то, что ещё не зафиксировано onBlur
    if (titleDraft.trim() !== (event.title ?? '') && titleDraft.trim()) await saveTitle()
    if (noteDraft !== (event.note ?? '')) await saveNote()
    if (
      dateDraft !== (event.date_end ?? '') ||
      (timeDraft || null) !== ((event.event_time ?? '').slice(0, 5) || null)
    ) {
      await saveDateTime()
    }
  }

  async function saveAndClose() {
    await flushDrafts()
    onClose()
  }

  // Кастомный confirm с 3 кнопками: Сохранить / Не сохранять / Вернуться
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  // Share-link: копирование URL события в clipboard + toast «Скопировано»
  const [shareToast, setShareToast] = useState(false)
  async function shareLink() {
    if (typeof window === 'undefined') return
    const url = `${window.location.origin}/events/${event.id}`
    try {
      await navigator.clipboard.writeText(url)
      setShareToast(true)
      setTimeout(() => setShareToast(false), 2200)
    } catch {
      // fallback для старых браузеров / небезопасного контекста
      prompt('Скопируйте ссылку вручную:', url)
    }
  }

  function tryClose() {
    if (!hasPendingChanges()) {
      onClose()
      return
    }
    setShowCloseConfirm(true)
  }

  // Запрос LLM-оценки важности
  const [classifying, setClassifying] = useState(false)
  async function classifyImportance() {
    if (classifying) return
    setClassifying(true)
    try {
      const res = await fetch(`/api/events/${event.id}/classify-importance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onEventChanged()
      alert(`LLM-оценка: ${data.importance.toUpperCase()}\n\n${data.reason}`)
    } catch (e) {
      alert(`Ошибка LLM-оценки: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setClassifying(false)
    }
  }

  // Сменить тип события
  async function saveEventType(newType: string) {
    if (newType === event.event_type) return
    setSaving(true)
    await supabase.from('events').update({ event_type: newType }).eq('id', event.id)
    setSaving(false)
    onEventChanged()
  }

  // Удаление события целиком (cascade: event_attachments через FK; entity_links — вручную)
  async function deleteEvent() {
    if (!confirm(`Удалить событие «${event.title || event.event_type}» безвозвратно?`)) return
    setSaving(true)
    // 1) entity_links (полиморфные, без FK)
    await supabase.from('entity_links').delete().match({ from_type: 'event', from_id: event.id })
    await supabase.from('entity_links').delete().match({ to_type: 'event', to_id: event.id })
    // 2) clause_events (если связано с пунктом договора)
    await supabase.from('clause_events').delete().eq('event_id', event.id)
    // 3) сам event (event_attachments удалятся каскадом по FK)
    const { error } = await supabase.from('events').delete().eq('id', event.id)
    setSaving(false)
    if (error) { alert(`Ошибка удаления: ${error.message}`); return }
    onDeleted()
  }

  // addLink удалена — заменена на applyObjects/applyEntities/applyDocs через MultiSelectPopover

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={tryClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: тип + заголовок + дата/время в одну строку */}
        <div className="p-4 border-b sticky top-0 bg-white z-10">
          <div className="flex justify-between items-start gap-3">
            <div className="flex-1 min-w-0">
              <select
                value={typeDraft}
                onChange={(e) => { setTypeDraft(e.target.value); saveEventType(e.target.value) }}
                disabled={saving || regenerating}
                className="text-xs text-gray-500 font-mono bg-transparent border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-white rounded px-1 py-0.5 outline-none cursor-pointer"
                title="Тип события"
              >
                {subtypes.map((s) => (
                  <option key={s.code} value={s.code}>{s.icon} {s.label}</option>
                ))}
              </select>
              <textarea
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                rows={1}
                placeholder={event.event_type}
                className="w-full mt-0.5 text-lg font-semibold bg-transparent border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-white rounded px-1.5 py-0.5 resize-y outline-none"
                disabled={saving || regenerating}
                title="Кликните, чтобы отредактировать заголовок"
              />
            </div>
            <div className="relative flex items-center gap-1 shrink-0">
              <button
                onClick={shareLink}
                className="px-2 py-1 text-gray-600 hover:text-blue-700 hover:bg-blue-50 rounded text-sm"
                title="Скопировать ссылку на событие"
              >🔗</button>
              <button
                onClick={saveAndClose}
                disabled={saving || regenerating}
                className="px-2.5 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
                title="Сохранить все изменения и закрыть"
              >✔ Сохранить</button>
              <button
                onClick={deleteEvent}
                disabled={saving || regenerating}
                className="px-2 py-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-50"
                title="Удалить событие"
              >🗑</button>
              <button
                onClick={tryClose}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-1"
                title="Закрыть"
              >×</button>
              {/* Toast «Ссылка скопирована» */}
              {shareToast && (
                <span className="absolute -bottom-9 right-0 whitespace-nowrap px-3 py-1 bg-emerald-600 text-white text-xs rounded shadow-lg z-10">
                  ✓ Ссылка скопирована
                </span>
              )}
            </div>
          </div>
          {/* Дата + время + Важность + План/Факт — inline в шапке */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-xs text-gray-500">📅</span>
            <input
              type="date"
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              onBlur={saveDateTime}
              className="px-2 py-1 border rounded text-sm"
              title="Дата события"
            />
            <input
              type="time"
              value={timeDraft}
              onChange={(e) => setTimeDraft(e.target.value)}
              onBlur={saveDateTime}
              className="px-2 py-1 border rounded text-sm"
              title="Время (опц.) — для упорядочивания внутри дня"
            />
            {/* Шкала важности */}
            <label className="inline-flex items-center gap-1 text-xs text-gray-500" title="Важность события (для быстрых отчётов)">
              <span>★</span>
              <select
                value={event.importance ?? 'normal'}
                onChange={(e) => saveImportance(e.target.value as Importance)}
                disabled={saving || regenerating || classifying}
                className={`px-1.5 py-1 border rounded text-xs cursor-pointer ${IMPORTANCE_BADGE[event.importance ?? 'normal']}`}
              >
                {(['low','normal','high','critical'] as const).map((v) => (
                  <option key={v} value={v}>{IMPORTANCE_ICON[v]} {IMPORTANCE_LABEL[v]}</option>
                ))}
              </select>
            </label>
            <button
              onClick={classifyImportance}
              disabled={saving || regenerating || classifying}
              className="px-2 py-1 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
              title="LLM оценит важность по содержанию"
            >
              {classifying ? '⏳' : '🤖 Оценить'}
            </button>
            {/* Событие = всегда факт. Плановые вехи живут в /calendar (calendar_entries). */}
            <span className="ml-auto text-xs text-emerald-700 font-medium" title="События — журнал фактов. Плановые вехи договора — в /calendar.">
              Факт
            </span>
          </div>
        </div>

        <div className="p-4 space-y-3">

          {/* Комментарий (events.note) */}
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Комментарий</h3>
              <button
                onClick={async () => {
                  if (regenerating) return
                  setRegenerating(true)
                  try {
                    const res = await fetch(`/api/events/${event.id}/regenerate-note`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ save: true }),
                    })
                    const data = await res.json()
                    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
                    setNoteDraft(data.note)
                    if (data.title) setTitleDraft(data.title)
                    // title тоже обновился — перезагружаем events
                    onEventChanged()
                  } catch (e) {
                    alert(`Ошибка регенерации: ${e instanceof Error ? e.message : String(e)}`)
                  } finally {
                    setRegenerating(false)
                  }
                }}
                disabled={regenerating || saving}
                className="px-2 py-0.5 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
                title="LLM перепишет заголовок + текст с именами объектов и подрядчика"
              >
                {regenerating ? '⏳ …' : '✨ Перефразировать'}
              </button>
            </div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={saveNote}
              placeholder="Свободный текст: контекст, цитата, пояснения…"
              rows={4}
              className="w-full px-2 py-1.5 border rounded text-sm font-mono resize-y"
              disabled={saving || regenerating}
            />
          </section>

          {/* Файлы — выделены цветовым акцентом */}
          <section className="bg-emerald-50/60 border border-emerald-200 rounded p-3">
            <FilesSection event={event} />
          </section>

          {/* Пункты договора — показываем только если есть */}
          {myClauses.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                Пункты договора
              </h3>
              <ul className="space-y-1">
                {myClauses.map((cl) => (
                  <li key={cl.clause_id} className="text-sm">
                    <Link
                      href={`/contracts/${cl.document_id}`}
                      className="inline-flex items-center gap-2 px-2 py-0.5 bg-green-50 text-green-800 rounded hover:bg-green-100"
                    >
                      <span className="text-xs font-semibold">→ {cl.document_title}</span>
                      <span className="text-xs text-green-600">п.{cl.order_index}</span>
                    </Link>
                    <div className="text-xs text-gray-500 ml-2 mt-0.5">{cl.description}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Связи: Объекты + Юр.лица в две колонки */}
          <div className="grid grid-cols-2 gap-3">
            {/* Объекты — канонический канал: events.object_ids (+ legacy entity_links) */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Объекты</h3>
              <div className="flex flex-wrap gap-1 mb-1.5 min-h-[1.5rem]">
                {allObjectIds.length === 0 && <span className="text-xs text-gray-400">—</span>}
                {allObjectIds.map((oid) => {
                  const o = objects.find((x) => x.id === oid || x.code === oid)
                  return (
                    <span
                      key={oid}
                      title={o?.current_name ?? ''}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-mono rounded border-l-2"
                      style={{ borderLeftColor: o?.color ?? '#cbd5e1' }}
                    >
                      {o?.icon && (o.icon.startsWith('data:image/') || /^https?:\/\//.test(o.icon)
                        ? <img src={o.icon} alt="" className="w-4 h-4 object-contain" />
                        : <span aria-hidden>{o.icon}</span>)}
                      {o?.code ?? oid}
                      <button onClick={() => removeObject(oid)} className="hover:text-blue-900 font-bold">×</button>
                    </span>
                  )
                })}
              </div>
              <MultiSelectPopover
                label="+ Объект"
                options={objects.map((o) => ({
                  value: o.id,
                  label: o.code,
                  sublabel: o.current_name,
                  icon: o.icon,
                }))}
                selected={allObjectIds}
                onApply={applyObjects}
                triggerClassName="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs hover:bg-blue-100"
                disabled={saving}
              />
            </section>

            {/* Юр.лица */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Юр.лица</h3>
              <div className="flex flex-wrap gap-1 mb-1.5 min-h-[1.5rem]">
                {leLinks.length === 0 && <span className="text-xs text-gray-400">—</span>}
                {leLinks.map((l) => {
                  const le = entities.find((x) => x.id === l.to_id)
                  return (
                    <span key={l.to_id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded">
                      {le?.short_name || le?.name || l.to_id.slice(0, 8)}
                      <button onClick={() => removeLink(l)} className="hover:text-amber-900 font-bold">×</button>
                    </span>
                  )
                })}
              </div>
              <MultiSelectPopover
                label="+ Юр.лицо"
                options={entities.map((le) => ({
                  value: le.id,
                  label: le.short_name || le.name,
                  sublabel: le.short_name ? le.name : undefined,
                }))}
                selected={leLinks.map((l) => l.to_id)}
                onApply={applyEntities}
                triggerClassName="px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded text-xs hover:bg-amber-100"
                disabled={saving}
              />
            </section>
          </div>

          {/* Этап договора (с 2026-05-18) — общая привязка для любого event_type.
              Список этапов фильтруется по документам, связанным с событием:
              subject_document_id + entity_links{event→document}. */}
          {(() => {
            const linkedDocIds = new Set<string>()
            if (event.subject_document_id) linkedDocIds.add(event.subject_document_id)
            for (const l of docLinks) linkedDocIds.add(l.to_id)
            const candidateStages = linkedDocIds.size > 0
              ? contractStages.filter(s => linkedDocIds.has(s.document_id))
              : []
            const currentStage = event.contract_stage_id
              ? contractStages.find(s => s.id === event.contract_stage_id) ?? null
              : null

            async function saveContractStage(newId: string | null) {
              setSaving(true)
              const { error } = await supabase
                .from('events')
                .update({ contract_stage_id: newId })
                .eq('id', event.id)
              setSaving(false)
              if (error) { alert(error.message); return }
              onEventChanged()
            }

            return (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                  Этап договора
                </h3>
                {linkedDocIds.size === 0 ? (
                  <div className="text-xs text-gray-400 italic">
                    Сначала добавьте договор ниже — тогда появится список этапов.
                  </div>
                ) : candidateStages.length === 0 ? (
                  <div className="text-xs text-gray-400 italic">
                    У выбранных договоров не выделены этапы.
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <select
                      value={event.contract_stage_id ?? ''}
                      onChange={(e) => saveContractStage(e.target.value || null)}
                      disabled={saving}
                      className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-xs"
                    >
                      <option value="">— без этапа —</option>
                      {candidateStages.map(s => (
                        <option key={s.id} value={s.id}>
                          Этап {s.stage_number} · {s.stage_name}
                        </option>
                      ))}
                    </select>
                    {currentStage && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-violet-100 text-violet-700 text-xs rounded whitespace-nowrap"
                        title={`Этап ${currentStage.stage_number}: ${currentStage.stage_name}`}
                      >
                        🎯 Этап {currentStage.stage_number}
                      </span>
                    )}
                  </div>
                )}
              </section>
            )
          })()}

          {/* Договора — отдельной строкой (часто пусто, длинные названия) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Договора</h3>
            <div className="flex flex-wrap gap-1 mb-1.5 min-h-[1.5rem]">
              {docLinks.length === 0 && <span className="text-xs text-gray-400">—</span>}
              {docLinks.map((l) => {
                const d = docs.find((x) => x.id === l.to_id)
                return (
                  <span key={l.to_id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-100 text-violet-700 text-xs rounded">
                    {d?.title || l.to_id.slice(0, 8)}
                    <button onClick={() => removeLink(l)} className="hover:text-violet-900 font-bold">×</button>
                  </span>
                )
              })}
            </div>
            <MultiSelectPopover
              label="+ Договор"
              options={docs.map((d) => ({ value: d.id, label: d.title }))}
              selected={docLinks.map((l) => l.to_id)}
              onApply={applyDocs}
              triggerClassName="px-2 py-0.5 bg-violet-50 text-violet-700 border border-violet-200 rounded text-xs hover:bg-violet-100"
              disabled={saving}
            />
          </section>

          {/* Универсальный блок связей события — фазы: Источник + Связанные.
              Старые секции «Объекты»/«Юр.лица»/«Договора» выше — для belongs_to-связей,
              этот блок — для phase-link типов (from_*, related_to). */}
          <EntityLinksBlock
            title="Источник и связи"
            links={myLinks.filter((l) =>
              ['from_document','from_letter','from_meeting','from_protocol','related_to'].includes(l.link_type)
            ) as unknown as GenericLink[]}
            phases={EVENT_LINK_PHASES}
            registry={{
              meetings,
              events: allEvents.filter((e) => e.id !== event.id).map((e) => ({
                id: e.id, title: e.title, event_type: e.event_type,
                date_end: e.date_end, date_computed: e.date_computed, object_ids: e.object_ids,
              })),
              documents: docs.map((d) => ({ id: d.id, title: d.title, doc_number: null, signed_date: null })),
              letters,
              objects,
              entities: entities.map((le) => ({ id: le.id, name: le.name, short_name: le.short_name })),
            }}
            onAdd={(linkType) => onAddLink(linkType)}
            onDelete={(linkId) => onDeleteLink(linkId)}
          />

          {/* Inverse-секция: задачи, ссылающиеся на это событие. */}
          <TasksOnEventBlock
            eventId={event.id}
            links={taskEventLinks}
            tasks={tasksRef}
            entityNameById={new Map(entities.map((e) => [e.id, e.short_name || e.name]))}
            onCreate={onCreateTask}
            onLinkExisting={onLinkExistingTask}
            onUnlink={(linkId) => { onUnlinkTask(linkId) }}
          />

        </div>
      </div>

      {/* Диалог подтверждения закрытия с несохранёнными изменениями */}
      {showCloseConfirm && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[60]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2">Несохранённые изменения</h3>
            <p className="text-sm text-gray-600 mb-5">
              В событии есть изменения, которые ещё не записаны в базу. Что сделать?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={async () => { setShowCloseConfirm(false); await saveAndClose() }}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium text-sm"
              >✔ Сохранить и закрыть</button>
              <button
                onClick={() => { setShowCloseConfirm(false); onClose() }}
                className="w-full px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded hover:bg-red-100 text-sm"
              >✕ Не сохранять, закрыть</button>
              <button
                onClick={() => setShowCloseConfirm(false)}
                className="w-full px-4 py-2 bg-white border border-gray-300 rounded hover:bg-gray-50 text-sm text-gray-700"
              >↶ Вернуться к редактированию</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Главная страница ────────────────────────────────────────────────────────

function EventsPageInner() {
  const { isAdmin } = useRole()
  const [events,       setEvents]       = useState<Event[]>([])
  const [subtypes,     setSubtypes]     = useState<Subtype[]>([])
  const [objects,      setObjects]      = useState<ObjectRef[]>([])
  const [entities,     setEntities]     = useState<LegalEntity[]>([])
  const [docs,         setDocs]         = useState<DocRef[]>([])
  const [links,        setLinks]        = useState<EntityLink[]>([])
  const [clauseLinks,  setClauseLinks]  = useState<ClauseLink[]>([])
  // С 2026-05-18: справочник этапов договоров для отображения и редактирования attached events
  const [contractStages, setContractStages] = useState<ContractStageRef[]>([])
  const [users,        setUsers]        = useState<UserRef[]>([])
  // Реестры для EntityLinkPicker (источники: meetings, documents, letters; основной справочник docs уже грузится для секции «Договора»)
  const [meetings, setMeetings] = useState<Array<{ id: string; code: string | null; title: string | null; meeting_date: string; object_ids: string[] | null }>>([])
  const [letters,  setLetters]  = useState<Array<{ id: string; subject: string; date: string | null; direction: string | null }>>([])
  // Inverse-связи task→event: показываем задачи в карточке события
  const [tasksRef,      setTasksRef]      = useState<TaskRef[]>([])
  const [taskEventLinks, setTaskEventLinks] = useState<TaskToEventLink[]>([])
  // Состояние модалки «+ Добавить связь» из EventLinkModal
  const [addLinkTarget, setAddLinkTarget] = useState<{ eventId: string; eventTitle: string; linkType: string } | null>(null)
  // Inverse-связь task → event: пользователь выбирает СУЩЕСТВУЮЩУЮ задачу
  // и привязывает её как raised_from / related_to / resolved_by к этому событию.
  // INSERT direction: from_type='task', to_type='event' (не наоборот).
  const [linkTaskTarget, setLinkTaskTarget] = useState<{
    eventId: string;
    eventTitle: string;
    linkType: 'raised_from' | 'related_to' | 'resolved_by';
  } | null>(null)
  // Состояние модалки «+ Поставить задачу из события»
  const [createTaskFor, setCreateTaskFor] = useState<Event | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [editing,      setEditing]      = useState<Event | null>(null)
  const [prelimCount,  setPrelimCount]  = useState(0)
  const [refreshing,   setRefreshing]   = useState(false)
  const [refreshMsg,   setRefreshMsg]   = useState<string>('')

  // Фильтры
  // Фильтры: множественный выбор (пустой массив = «все»)
  const [filterCategories, setFilterCategories] = useState<string[]>([])
  const [filterObjects,    setFilterObjects]    = useState<string[]>([])
  const [filterImportance, setFilterImportance] = useState<string[]>([])  // ['high','critical'] → quick-отчёт
  const [filterEntities,   setFilterEntities]   = useState<string[]>([])
  // Тип создания (Природа): clause | document | letter | meeting | manual
  const [filterNatures,    setFilterNatures]    = useState<string[]>([])
  const [search,         setSearch]         = useState('')

  useEffect(() => { load() }, [])

  // Открытие события из shareable URL: /events?open={id} (редирект из /events/[id])
  const searchParams = useSearchParams()
  const router = useRouter()
  const openId = searchParams?.get('open') ?? null
  useEffect(() => {
    if (!openId || loading || editing?.id === openId) return
    const found = events.find((e) => e.id === openId)
    if (found) {
      setEditing(found)
      router.replace('/events', { scroll: false })
      return
    }
    // Fallback: события нет в списке (возможно preliminary, или вне фильтра).
    // Подгружаем напрямую и открываем модал — EventLinkModal умеет
    // редактировать любые события, включая preliminary.
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('events')
        .select('id,event_type,title,date_end,date_start,date_computed,event_time,object_ids,stage_name,note,importance,created_at,created_by,derived_source,classifier_template_code,contract_stage_id,subject_document_id,is_preliminary')
        .eq('id', openId)
        .maybeSingle()
      if (cancelled) return
      if (error || !data) {
        alert(`Событие не найдено: ${openId}${error ? `\n${error.message}` : ''}`)
        router.replace('/events', { scroll: false })
        return
      }
      setEditing(data as typeof editing)
      router.replace('/events', { scroll: false })
    })()
    return () => { cancelled = true }
  }, [openId, loading, events, editing, router])

  async function load() {
    setLoading(true)
    setError('')
    const [ev, ob, le, st, cs, lk, dc, pc, us, mt, lt, tlk, tsk] = await Promise.all([
      supabase
        .from('events')
        .select('id,event_type,title,date_end,date_start,date_computed,event_time,object_ids,stage_name,note,importance,created_at,created_by,derived_source,classifier_template_code,contract_stage_id,subject_document_id')
        // Preliminary события — отдельно в /events/preliminary, тут не показываем
        .eq('is_preliminary', false)
        // Сортировка: сверху самый свежий день, внутри дня — позднее время первым,
        // события без времени уезжают в конец дня.
        .order('date_computed', { ascending: false })
        .order('event_time',    { ascending: false, nullsFirst: false })
        .order('id',            { ascending: false })
        .limit(500),
      supabase.from('objects').select('id,code,current_name,color,icon,icon_small').eq('active', true).order('code'),
      supabase.from('legal_entities').select('id,name,short_name').eq('is_active', true).order('short_name', { nullsFirst: false }).order('name'),
      supabase.from('event_subtypes').select('code,category,label,icon').order('sort_order'),
      supabase.from('contract_stages').select('id,document_id,stage_number,stage_name').order('sort_order'),
      supabase.from('entity_links').select('id,from_id,to_type,to_id,link_type,notes').eq('from_type', 'event'),
      supabase.from('documents').select('id,title').eq('type', 'ДОГОВОРА').is('deleted_at', null).order('title'),
      supabase.from('events').select('id', { count: 'exact', head: true }).eq('is_preliminary', true),
      supabase.from('user_names').select('id,name,email'),
      supabase.from('meetings').select('id,code,title,meeting_date,object_ids').order('meeting_date', { ascending: false }).limit(200),
      supabase.from('letters').select('id,subject,date,direction').order('date', { ascending: false, nullsFirst: false }).limit(200),
      // Inverse: task → event связи (raised_from/related_to/resolved_by) для секции «Задачи» в карточке события
      supabase.from('entity_links').select('id,from_id,to_id,link_type,notes')
        .eq('from_type', 'task').eq('to_type', 'event'),
      // Сами задачи (минимальный набор полей для отображения)
      supabase.from('tasks').select('id,code,title,status,priority,assignee_entity_id,due_date,object_ids'),
    ])
    setPrelimCount(pc.count || 0)
    if (ev.error) setError(ev.error.message)
    setEvents((ev.data as Event[]) || [])
    setObjects((ob.data as ObjectRef[]) || [])
    setEntities((le.data as LegalEntity[]) || [])
    setSubtypes((st.data as Subtype[]) || [])
    setContractStages((cs.data as ContractStageRef[]) || [])
    setLinks((lk.data as EntityLink[]) || [])
    setDocs((dc.data as DocRef[]) || [])
    setUsers((us.data as UserRef[]) || [])
    setMeetings((mt.data as Array<{ id: string; code: string | null; title: string | null; meeting_date: string; object_ids: string[] | null }>) || [])
    setLetters((lt.data as Array<{ id: string; subject: string; date: string | null; direction: string | null }>) || [])
    setTaskEventLinks((tlk.data as TaskToEventLink[]) || [])
    setTasksRef((tsk.data as TaskRef[]) || [])

    // clause_events удалена в миграции 20260508000003 (см. WIKI 14 v6.0).
    // Связь события с пунктом договора — через entity_links link_type='from_document'.
    setClauseLinks([])

    setLoading(false)
  }

  async function reloadEvent(eventId: string) {
    const { data } = await supabase
      .from('events')
      .select('id,event_type,title,date_end,date_start,date_computed,event_time,object_ids,stage_name,note,importance,created_at,created_by,derived_source,classifier_template_code,contract_stage_id,subject_document_id')
      .eq('id', eventId)
      .maybeSingle()
    if (data) {
      setEvents(prev => prev.map(e => e.id === eventId ? (data as Event) : e))
      // Если эта же запись открыта в модалке — обновим и её snapshot,
      // иначе модалка будет показывать стейт на момент открытия (object_ids и пр.)
      setEditing(prev => prev && prev.id === eventId ? (data as Event) : prev)
    }
  }

  async function reloadLinks() {
    const r = await supabase.from('entity_links').select('id,from_id,to_type,to_id,link_type,notes').eq('from_type', 'event')
    setLinks((r.data as EntityLink[]) || [])
  }

  // Создать новую связь event → {meeting|event|document|letter|object|legal_entity|task}.
  // Возвращает строку с ошибкой или null при успехе. См. WIKI 09_Правило_связей.
  async function addEventLink(args: {
    eventId: string
    linkType: string
    toType: string
    toId: string
    notes: string | null
  }): Promise<string | null> {
    const { eventId, linkType, toType, toId, notes } = args
    const { error } = await supabase.from('entity_links').insert({
      from_type: 'event',
      from_id:   eventId,
      to_type:   toType,
      to_id:     toId,
      link_type: linkType,
      notes:     notes || null,
    })
    if (error) return error.message
    await reloadLinks()
    return null
  }

  // Удалить связь по id.
  async function deleteEventLink(linkId: string): Promise<void> {
    if (!confirm('Удалить связь?')) return
    const { error } = await supabase.from('entity_links').delete().eq('id', linkId)
    if (error) { alert(error.message); return }
    await reloadLinks()
  }

  // Перезагрузка task-side связей и реестра задач (для inverse-секции в карточке события)
  async function reloadTasksAndLinks() {
    const [tlk, tsk] = await Promise.all([
      supabase.from('entity_links').select('id,from_id,to_id,link_type,notes')
        .eq('from_type', 'task').eq('to_type', 'event'),
      supabase.from('tasks').select('id,code,title,status,priority,assignee_entity_id,due_date,object_ids'),
    ])
    setTaskEventLinks((tlk.data as TaskToEventLink[]) || [])
    setTasksRef((tsk.data as TaskRef[]) || [])
  }

  // Создание задачи из события: INSERT в tasks + entity_link (raised_from) + task_object_status
  // для каждого object_id события. Возвращает строку с ошибкой или null.
  async function createTaskFromEvent(args: {
    event: Event
    title: string
    explanation: string | null
    priority: 'high' | 'medium' | 'low'
    assignee_entity_id: string | null
    start_date: string | null
    due_date: string | null
    object_ids: string[]
  }): Promise<string | null> {
    const { event, title, explanation, priority, assignee_entity_id, start_date, due_date, object_ids } = args
    // Генерация code: «СОБЫТ-{event_id_short}-ЗАД-{seq}»
    const eventShort = event.id.slice(0, 8)
    const existingForEvent = taskEventLinks.filter(
      (l) => l.to_id === event.id && l.link_type === 'raised_from'
    ).length
    const seq = String(existingForEvent + 1).padStart(2, '0')
    const code = `СОБЫТ-${eventShort}-ЗАД-${seq}`

    // 1) INSERT tasks
    const taskInsert = await supabase.from('tasks').insert({
      code,
      title:    title.trim(),
      explanation: explanation?.trim() || null,
      status:   'open',
      priority,
      assignee_entity_id: assignee_entity_id || null,
      start_date: start_date || null,
      due_date: due_date || null,
      object_ids,
    }).select('id').single()
    if (taskInsert.error || !taskInsert.data) {
      return taskInsert.error?.message ?? 'Не удалось создать задачу'
    }
    const taskId = taskInsert.data.id as string

    // 2) entity_link: task ← raised_from → event (триггер sync обновит tasks.meeting_id если применимо)
    const linkInsert = await supabase.from('entity_links').insert({
      from_type: 'task', from_id: taskId,
      to_type:   'event', to_id: event.id,
      link_type: 'raised_from',
      notes:     null,
    })
    if (linkInsert.error) {
      // Откатываем задачу — иначе она будет «висеть» без связи с событием-источником
      await supabase.from('tasks').delete().eq('id', taskId)
      return `Связь не создана: ${linkInsert.error.message}`
    }

    // 3) task_object_status — open для каждого object_id
    if (object_ids.length > 0) {
      const rows = object_ids.map((oid) => ({
        task_id: taskId,
        object_id: oid,
        status: 'open',
      }))
      const tosInsert = await supabase.from('task_object_status').insert(rows)
      if (tosInsert.error) {
        // Не блокируем — задача создана, статусы можно поправить через /tasks
        console.error('task_object_status insert failed:', tosInsert.error.message)
      }
    }

    await reloadTasksAndLinks()
    return null
  }

  const subtypeMap = useMemo(() => {
    const m: Record<string, Subtype> = {}
    for (const s of subtypes) m[s.code] = s
    return m
  }, [subtypes])

  const userById = useMemo(() => {
    const m = new Map<string, UserRef>()
    for (const u of users) m.set(u.id, u)
    return m
  }, [users])

  // Lookup: entity_id ↔ object/document (legacy single link from events table itself)
  // + entity_links for multi-attach

  const linksByEvent = useMemo(() => {
    const m: Record<string, EntityLink[]> = {}
    for (const l of links) {
      if (!m[l.from_id]) m[l.from_id] = []
      m[l.from_id].push(l)
    }
    return m
  }, [links])

  const clausesByEvent = useMemo(() => {
    const m: Record<string, ClauseLink[]> = {}
    for (const cl of clauseLinks) {
      if (!m[cl.event_id]) m[cl.event_id] = []
      m[cl.event_id].push(cl)
    }
    return m
  }, [clauseLinks])

  // Фильтрация (multi-select: пустой массив = все)
  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (filterCategories.length > 0) {
        const st = subtypeMap[ev.event_type]
        if (!st || !filterCategories.includes(st.category)) return false
      }
      if (filterObjects.length > 0) {
        const myLinks = linksByEvent[ev.id] || []
        const hasMatch = filterObjects.some((oid) =>
          ev.object_ids?.includes(oid) ||
          myLinks.some((l) => l.to_type === 'object' && l.to_id === oid)
        )
        if (!hasMatch) return false
      }
      if (filterEntities.length > 0) {
        const myLinks = linksByEvent[ev.id] || []
        const hasMatch = filterEntities.some((eid) =>
          myLinks.some((l) => l.to_type === 'legal_entity' && l.to_id === eid)
        )
        if (!hasMatch) return false
      }
      if (filterImportance.length > 0) {
        if (!filterImportance.includes(ev.importance ?? 'normal')) return false
      }
      if (filterNatures.length > 0) {
        const myLinks = linksByEvent[ev.id] || []
        const myClauses = clausesByEvent[ev.id] || []
        const hasClause   = myClauses.length > 0
        const hasDoc      = myLinks.some((l) => l.link_type === 'from_document' && l.to_type === 'document')
        const hasLetter   = myLinks.some((l) => l.link_type === 'from_letter')
        const hasMeeting  = myLinks.some((l) => l.link_type === 'from_meeting')
        const ds          = ev.derived_source
        const isTg        = ds === 'tg'
        const isMail      = ds === 'mail'
        const isBitrix    = ds === 'bitrix'
        const isManual    = !hasClause && !hasDoc && !hasLetter && !hasMeeting
                            && !isTg && !isMail && !isBitrix
        const matchesOne = (n: string) =>
          (n === 'clause'   && hasClause) ||
          (n === 'document' && hasDoc && !hasClause) ||
          (n === 'letter'   && hasLetter) ||
          (n === 'meeting'  && hasMeeting) ||
          (n === 'tg'       && isTg) ||
          (n === 'mail'     && isMail) ||
          (n === 'bitrix'   && isBitrix) ||
          (n === 'manual'   && isManual)
        if (!filterNatures.some(matchesOne)) return false
      }
      if (search) {
        const q = search.toLowerCase()
        const hay = ((ev.title || '') + ' ' + ev.event_type + ' ' + (ev.stage_name || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [events, filterCategories, filterObjects, filterEntities, filterNatures, filterImportance, search, subtypeMap, linksByEvent, clausesByEvent])

  // Группировка по месяцу
  const grouped = useMemo(() => {
    const map = new Map<string, Event[]>()
    for (const ev of filtered) {
      const key = monthKey(ev.date_computed)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(ev)
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered])

  const stats = useMemo(() => {
    const cats: Record<string, number> = {}
    for (const ev of events) {
      const st = subtypeMap[ev.event_type]
      const cat = st?.category || 'other'
      cats[cat] = (cats[cat] || 0) + 1
    }
    return { total: events.length, cats }
  }, [events, subtypeMap])

  const [batchClassifying, setBatchClassifying] = useState(false)
  async function runBatchClassify() {
    if (!confirm('Запустить LLM-оценку важности для всех событий с importance=normal? Это может занять несколько минут.')) return
    setBatchClassifying(true)
    try {
      const res = await fetch('/api/events/classify-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ only_normal: true, limit: 200 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      alert(
        `Обработано: ${data.processed}\n` +
        `Сохранено изменений: ${data.changes_saved}\n` +
        `Ошибок: ${data.errors}\n\n` +
        `Распределение:\n` +
        `🔥 critical: ${data.distribution.critical}\n` +
        `★ high: ${data.distribution.high}\n` +
        `· normal: ${data.distribution.normal}\n` +
        `○ low: ${data.distribution.low}`
      )
      await load()
    } catch (e) {
      alert(`Ошибка: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBatchClassifying(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-4">
        {/* Заголовок + основные действия */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">События</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={runBatchClassify}
              disabled={batchClassifying}
              className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50"
              title="LLM оценит важность для всех событий с обычной важностью"
            >
              {batchClassifying ? '⏳ Оценка…' : '🤖 Оценить важность всех'}
            </button>
            <button
              onClick={async () => {
                // Создаём минимальную заготовку и сразу открываем редактор
                const today = new Date().toISOString().slice(0, 10)
                const { data, error: e } = await supabase.from('events').insert({
                  event_type: 'project_note',
                  title: 'Новое событие',  // placeholder — заменится при первом сохранении title
                  date_start: today,
                  date_end:   today,
                  object_ids: [],
                  // is_preliminary=false (default) — событие сразу видно на /events.
                  // Защита от мусорных news: триггер auto_create_news_from_event
                  // пропускает title='Новое событие'; публикация — при первой правке title
                  // (триггер events_publish_on_title_change, миграция 20260515000001).
                }).select('id,event_type,title,date_end,date_start,date_computed,event_time,object_ids,stage_name,note,importance,created_at,created_by,derived_source,classifier_template_code,contract_stage_id,subject_document_id').single()
                if (e) { setError(e.message); return }
                await load()
                setEditing(data as Event)
              }}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
            >
              + Создать событие
            </button>
          </div>
        </div>

        {/* Подпункты: видны только администратору (sub-nav под заголовком) */}
        {isAdmin && (
          <div className="mt-2 flex items-center gap-3 text-sm text-gray-500 border-t pt-2 flex-wrap">
            <span className="uppercase tracking-wider text-xs font-semibold">Раздел:</span>
            <span className="text-gray-900 font-medium">Все подтверждённые</span>
            <Link
              href="/events/preliminary"
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded ${
                prelimCount > 0
                  ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
              title="Очередь preliminary событий из tg_classifier — ждут ревью (только для admin)"
            >
              ↳ На ревью
              {prelimCount > 0 && (
                <span className="px-1.5 py-0.5 bg-amber-200 rounded text-xs font-semibold">{prelimCount}</span>
              )}
            </Link>
            <button
              onClick={async () => {
                if (refreshing) return
                setRefreshing(true)
                setRefreshMsg('⏳ Классификация TG-сообщений…')
                try {
                  const res = await fetch('/api/events/refresh-tg', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ days: 3 }),
                  })
                  const data = await res.json()
                  if (data.success) {
                    setRefreshMsg(
                      `✓ +${data.classifier_new} preliminary` +
                      (data.classifier_merged ? ` (${data.classifier_merged} слито)` : '') +
                      `, ${data.messages_scanned ?? '?'} сообщ. проверено, ${data.duration_seconds}c`
                    )
                    await load()  // перечитать events + prelimCount
                  } else {
                    setRefreshMsg(`✗ Ошибка: ${data.error || 'неизвестно'}`)
                  }
                } catch (e) {
                  setRefreshMsg(`✗ Сеть/таймаут: ${e instanceof Error ? e.message : String(e)}`)
                } finally {
                  setRefreshing(false)
                  setTimeout(() => setRefreshMsg(''), 15000)
                }
              }}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-sky-100 text-sky-800 hover:bg-sky-200 disabled:opacity-50"
              title="Классификатор TG: rule-based анализ сообщений за 3 дня → создание preliminary событий. ~1-5 сек."
            >
              {refreshing ? '⏳ Догоняю…' : '↻ Считать из TG'}
            </button>
            <a
              href="http://95.181.173.95:8080"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 hover:bg-indigo-200 text-xs"
              title="Web-админка TG-листенера: дашборд, клиенты, доступ к чатам"
            >
              💬 TG Admin
            </a>
            {refreshMsg && (
              <span className={`text-xs ${refreshMsg.startsWith('✓') ? 'text-emerald-700' : refreshMsg.startsWith('✗') ? 'text-red-700' : 'text-gray-600'}`}>
                {refreshMsg}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="mb-4 text-sm text-gray-600 text-right">
        Всего: <b>{stats.total}</b>
        {Object.entries(stats.cats).map(([cat, cnt]) => (
          <span key={cat}> · <span className={`px-1.5 py-0.5 rounded text-xs ${CATEGORY_BADGE[cat] || 'bg-gray-100 text-gray-600'}`}>{CATEGORY_LABELS[cat] || cat}: {cnt}</span></span>
        ))}
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {/* Фильтры — чекбоксы (chips) */}
      <div className="bg-white rounded shadow p-4 mb-4 space-y-3">
        <FilterRow
          label="Категория"
          options={Object.entries(CATEGORY_LABELS).map(([k, v]) => ({ value: k, label: v, badge: CATEGORY_BADGE[k] }))}
          selected={filterCategories}
          onToggle={(v) => setFilterCategories((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
          onClear={() => setFilterCategories([])}
        />
        <FilterRow
          label="Природа"
          options={[
            { value: 'clause',   label: '📋 Из пункта договора' },
            { value: 'document', label: '📄 Из договора' },
            { value: 'letter',   label: '✉️ Из письма' },
            { value: 'meeting',  label: '🤝 Из собрания' },
            { value: 'tg',       label: '💬 Из Telegram' },
            { value: 'mail',     label: '📧 Из email' },
            { value: 'bitrix',   label: '🏢 Из Bitrix' },
            { value: 'manual',   label: '📝 Вручную' },
          ]}
          selected={filterNatures}
          onToggle={(v) => setFilterNatures((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
          onClear={() => setFilterNatures([])}
        />
        <FilterRow
          label="Объекты"
          options={objects.map((o) => ({ value: o.id, label: `${o.code.split('_')[0]} ${o.current_name.slice(0, 30)}` }))}
          selected={filterObjects}
          onToggle={(v) => setFilterObjects((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
          onClear={() => setFilterObjects([])}
        />
        <FilterRow
          label="Юр.лица"
          options={entities.map((le) => ({ value: le.id, label: le.short_name || le.name }))}
          selected={filterEntities}
          onToggle={(v) => setFilterEntities((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
          onClear={() => setFilterEntities([])}
        />
        <FilterRow
          label="Важность"
          options={[
            { value: 'critical', label: '🔥 Критическая', badge: IMPORTANCE_BADGE.critical },
            { value: 'high',     label: '★ Важная',      badge: IMPORTANCE_BADGE.high },
            { value: 'normal',   label: '· Обычная' },
            { value: 'low',      label: '○ Низкая',     badge: IMPORTANCE_BADGE.low },
          ]}
          selected={filterImportance}
          onToggle={(v) => setFilterImportance((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])}
          onClear={() => setFilterImportance([])}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold w-20 shrink-0">Поиск</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="по названию / типу / этапу…"
            className="flex-1 px-3 py-1.5 border rounded text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-gray-400 py-8 text-center">Загрузка…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded shadow p-6 text-center text-gray-400">
          Нет событий по выбранным фильтрам
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([monthK, evs]) => (
            <div key={monthK}>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 px-1">
                {monthLabel(monthK)} <span className="text-gray-400 font-normal normal-case">({evs.length})</span>
              </h2>
              <div className="bg-white rounded shadow overflow-hidden">
                <table className="w-full text-sm table-fixed">
                  <colgroup>
                    <col className="w-7" />     {/* важность */}
                    <col className="w-9" />     {/* иконка */}
                    <col className="w-20" />    {/* дата */}
                    <col className="w-24" />    {/* тип */}
                    <col />                     {/* название/этап — забирает остаток */}
                    <col className="w-32" />    {/* природа */}
                    <col className="w-40" />    {/* объекты */}
                    <col className="w-28" />    {/* юр.лицо */}
                  </colgroup>
                  <thead className="bg-gray-50 border-b text-left">
                    <tr>
                      <th className="px-1 py-2" title="Важность">★</th>
                      <th className="px-2 py-2"> </th>
                      <th className="px-2 py-2">Дата</th>
                      <th className="px-2 py-2">Тип</th>
                      <th className="px-2 py-2">Название / этап</th>
                      <th className="px-2 py-2">Природа</th>
                      <th className="px-2 py-2">Объекты</th>
                      <th className="px-2 py-2">Юр.лицо</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evs.map((ev) => {
                      const st = subtypeMap[ev.event_type]
                      const myLinks = linksByEvent[ev.id] || []
                      const objLinks = myLinks.filter((l) => l.to_type === 'object')
                      const leLinks  = myLinks.filter((l) => l.to_type === 'legal_entity')
                      const myClauses = clausesByEvent[ev.id] || []
                      return (
                        <tr
                          key={ev.id}
                          className="border-b hover:bg-gray-50 cursor-pointer"
                          onClick={() => setEditing(ev)}
                        >
                          <td className="px-1 py-2 text-center align-top">
                            {(() => {
                              const imp = ev.importance ?? 'normal'
                              if (imp === 'normal') return <span className="text-gray-300">·</span>
                              return (
                                <span
                                  className={`inline-block px-1 rounded text-xs ${IMPORTANCE_BADGE[imp]}`}
                                  title={IMPORTANCE_LABEL[imp]}
                                >{IMPORTANCE_ICON[imp]}</span>
                              )
                            })()}
                          </td>
                          <td className="px-2 py-2 text-base text-center align-top">{st?.icon || '◆'}</td>
                          <td className="px-2 py-2 text-xs text-gray-600 align-top">
                            {formatDate(ev.date_computed)}
                            {ev.event_time && (
                              <div className="text-gray-400">{ev.event_time.slice(0, 5)}</div>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium leading-tight break-words ${CATEGORY_BADGE[st?.category || ''] || 'bg-gray-100 text-gray-600'}`}>
                              {st?.label || ev.event_type}
                            </span>
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="font-medium text-gray-900 line-clamp-2 break-words">{ev.title || '—'}</div>
                            {/* С 2026-05-18: явный бейдж этапа договора (если привязан) */}
                            {ev.contract_stage_id && (() => {
                              const st = contractStages.find(s => s.id === ev.contract_stage_id)
                              if (!st) return null
                              return (
                                <div
                                  className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-violet-100 text-violet-700 border border-violet-200 rounded"
                                  title={`Этап договора ${st.stage_number}: ${st.stage_name}`}
                                >
                                  <span>🎯</span>
                                  <span>Этап {st.stage_number} · {st.stage_name}</span>
                                </div>
                              )
                            })()}
                            {ev.stage_name && (
                              <div className="text-xs text-gray-400 line-clamp-1">{ev.stage_name}</div>
                            )}
                            {ev.note && (
                              <div className="text-xs text-gray-500 italic line-clamp-3 mt-0.5 whitespace-pre-line break-words">{ev.note}</div>
                            )}
                            {myClauses.map((cl) => (
                              <Link
                                key={cl.clause_id}
                                href={`/contracts/${cl.document_id}`}
                                className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-xs hover:bg-green-100"
                                title={cl.description}
                              >
                                → {cl.document_title} / п.{cl.order_index}
                              </Link>
                            ))}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <NatureCell ev={ev} links={myLinks} clauses={myClauses} docs={docs} userById={userById} />
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="flex flex-wrap gap-1">
                              {/* основной канал: events.object_ids (UUID) */}
                              {ev.object_ids?.map((oid) => {
                                const o = objects.find((x) => x.id === oid)
                                return (
                                  <span
                                    key={oid}
                                    title={o?.current_name ?? ''}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs font-mono rounded whitespace-nowrap border-l-2"
                                    style={{ borderLeftColor: o?.color ?? '#cbd5e1' }}
                                  >
                                    {o?.icon_small
                                      ? <img src={o.icon_small} alt="" className="w-3.5 h-3.5 object-contain" />
                                      : o?.icon && (o.icon.startsWith('data:image/') || /^https?:\/\//.test(o.icon)
                                        ? <img src={o.icon} alt="" className="w-3.5 h-3.5 object-contain" />
                                        : <span aria-hidden>{o.icon}</span>)}
                                    {o?.code ?? oid.slice(0, 8)}
                                  </span>
                                )
                              })}
                              {/* fallback на entity_links если object_ids пуст */}
                              {(!ev.object_ids || ev.object_ids.length === 0) && objLinks.map((l) => {
                                const o = objects.find((x) => x.id === l.to_id || x.code === l.to_id)
                                return (
                                  <span
                                    key={l.to_id}
                                    title={o?.current_name ?? ''}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs font-mono rounded whitespace-nowrap border-l-2"
                                    style={{ borderLeftColor: o?.color ?? '#cbd5e1' }}
                                  >
                                    {o?.icon_small
                                      ? <img src={o.icon_small} alt="" className="w-3.5 h-3.5 object-contain" />
                                      : o?.icon && (o.icon.startsWith('data:image/') || /^https?:\/\//.test(o.icon)
                                        ? <img src={o.icon} alt="" className="w-3.5 h-3.5 object-contain" />
                                        : <span aria-hidden>{o.icon}</span>)}
                                    {o?.code ?? l.to_id}
                                  </span>
                                )
                              })}
                            </div>
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="flex flex-wrap gap-1">
                              {leLinks.map((l) => {
                                const le = entities.find((x) => x.id === l.to_id)
                                return (
                                  <span key={l.to_id} className="inline-block px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs rounded break-words">
                                    {le?.short_name || le?.name || '…'}
                                  </span>
                                )
                              })}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EventLinkModal
          event={editing}
          links={links}
          clauseLinks={clauseLinks}
          objects={objects}
          entities={entities}
          docs={docs}
          subtypes={subtypes}
          contractStages={contractStages}
          meetings={meetings}
          letters={letters}
          allEvents={events}
          tasksRef={tasksRef}
          taskEventLinks={taskEventLinks}
          onClose={() => setEditing(null)}
          onLinksChanged={() => reloadLinks()}
          onEventChanged={() => reloadEvent(editing.id)}
          onDeleted={async () => { setEditing(null); await load() }}
          onAddLink={(linkType) => setAddLinkTarget({
            eventId: editing.id,
            eventTitle: editing.title ?? editing.event_type,
            linkType,
          })}
          onDeleteLink={(linkId) => deleteEventLink(linkId)}
          onCreateTask={() => setCreateTaskFor(editing)}
          onLinkExistingTask={(linkType) => setLinkTaskTarget({
            eventId: editing.id,
            eventTitle: editing.title ?? editing.event_type,
            linkType,
          })}
          onUnlinkTask={async (linkId) => {
            if (!confirm('Открепить задачу от события? Сама задача останется.')) return
            const { error } = await supabase.from('entity_links').delete().eq('id', linkId)
            if (error) { alert(error.message); return }
            await reloadTasksAndLinks()
          }}
        />
      )}

      {/* Форма создания задачи из события — открывается по клику «+ Поставить задачу» в карточке */}
      {createTaskFor && (
        <CreateTaskFromEventModal
          eventTitle={createTaskFor.title ?? createTaskFor.event_type}
          eventCode={createTaskFor.id}
          eventDate={createTaskFor.date_computed ?? createTaskFor.date_end ?? ''}
          defaultObjectIds={createTaskFor.object_ids ?? []}
          entities={entities.map((le) => ({ id: le.id, name: le.name, short_name: le.short_name }))}
          objects={objects.map((o) => ({ id: o.id, code: o.code, current_name: o.current_name }))}
          onClose={() => setCreateTaskFor(null)}
          onSubmit={async (args) => {
            const err = await createTaskFromEvent({
              event: createTaskFor,
              title:              args.title,
              explanation:        args.explanation,
              priority:           args.priority,
              assignee_entity_id: args.assignee_entity_id,
              start_date:         args.start_date,
              due_date:           args.due_date,
              object_ids:         args.object_ids,
            })
            if (err) return err
            setCreateTaskFor(null)
            return null
          }}
        />
      )}

      {/* Универсальная модалка «+ Добавить связь» — Picker.
          Caller (EventLinkModal) кликает «+ Добавить» в фазе → этот state открывает Picker. */}
      {addLinkTarget && (() => {
        const phaseMeta = EVENT_LINK_PHASES.find((p) =>
          (Array.isArray(p.linkType) ? p.linkType : [p.linkType]).includes(addLinkTarget.linkType)
        )
        // Какие типы цели разрешены — зависит от фазы.
        const allowedToTypes: EntityKind[] = phaseMeta?.linkType === 'related_to'
          ? ['meeting', 'event', 'document', 'letter', 'object', 'legal_entity', 'task']
          : ['meeting', 'document', 'letter', 'event']  // источники
        return (
          <EntityLinkPicker
            title={`Привязать к событию — ${phaseMeta?.label ?? addLinkTarget.linkType}`}
            fromEntity={{ code: addLinkTarget.linkType, title: addLinkTarget.eventTitle }}
            allowedToTypes={allowedToTypes}
            registry={{
              meetings,
              events: events.filter((e) => e.id !== addLinkTarget.eventId).map((e) => ({
                id: e.id, title: e.title, event_type: e.event_type,
                date_end: e.date_end, date_computed: e.date_computed, object_ids: e.object_ids,
              })),
              documents: docs.map((d) => ({ id: d.id, title: d.title, doc_number: null, signed_date: null })),
              letters,
              objects,
              entities: entities.map((le) => ({ id: le.id, name: le.name, short_name: le.short_name })),
            }}
            onClose={() => setAddLinkTarget(null)}
            onSubmit={async ({ toType, toIds, notes }) => {
              // Multi-select: пакетно создаём связи. На первой ошибке прекращаем.
              for (const toId of toIds) {
                const err = await addEventLink({
                  eventId:  addLinkTarget.eventId,
                  linkType: addLinkTarget.linkType,
                  toType,
                  toId,
                  notes,
                })
                if (err) return err
              }
              setAddLinkTarget(null)
              return null
            }}
          />
        )
      })()}

      {/* Inverse-связь: выбрать СУЩЕСТВУЮЩУЮ задачу и привязать её к событию.
          Направление INSERT'а: from_type='task', to_type='event' (см. WIKI 09
          раздел про направления связей задачи). */}
      {linkTaskTarget && (() => {
        const phaseLabel = TASK_LINK_PHASE_META[linkTaskTarget.linkType].label
        const phaseIcon = TASK_LINK_PHASE_META[linkTaskTarget.linkType].icon
        const targetEvent = events.find((e) => e.id === linkTaskTarget.eventId)
        const eventObjIds: string[] = targetEvent?.object_ids ?? []
        // Юр.лица события — из entity_links (from_type='event', to_type='legal_entity')
        const eventEntityIds: string[] = links
          .filter((l) => l.from_id === linkTaskTarget.eventId && l.to_type === 'legal_entity')
          .map((l) => l.to_id)
        // Правило фильтрации задач в пикере:
        // 1. Если у задачи И у события есть объекты → фильтр ТОЛЬКО по объектам
        //    (юр.лицо игнорируем — «если указан объект, лицо не фильтровать»)
        // 2. Иначе (нет объектных данных) → фоллбэк по юр.лицу:
        //    assignee задачи совпадает с юр.лицами события
        // 3. Нет данных для фильтра → включаем всё
        // + для resolved_by: только активные задачи (open/in_progress)
        const filteredTasks = tasksRef.filter((t) => {
          if (linkTaskTarget.linkType === 'resolved_by') {
            if (t.status !== 'open' && t.status !== 'in_progress') return false
          }
          const taskObjIds: string[] = t.object_ids ?? []
          if (taskObjIds.length > 0 && eventObjIds.length > 0) {
            // Оба имеют объекты — фильтруем только по объектному пересечению
            return taskObjIds.some((oid) => eventObjIds.includes(oid))
          }
          // Нет объектных данных — фоллбэк по юр.лицу assignee задачи
          if (eventEntityIds.length > 0 && t.assignee_entity_id) {
            return eventEntityIds.includes(t.assignee_entity_id)
          }
          // Нет данных для фильтрации — включаем
          return true
        })
        return (
          <EntityLinkPicker
            title="Привязать существующую задачу"
            subtitle={`фаза «${phaseIcon} ${phaseLabel}»`}
            fromEntity={{ code: linkTaskTarget.linkType, title: linkTaskTarget.eventTitle }}
            allowedToTypes={['task']}
            registry={{
              tasks: filteredTasks.map((t) => ({ id: t.id, code: t.code, title: t.title })),
            }}
            submitColor={linkTaskTarget.linkType === 'resolved_by' ? 'emerald' : 'blue'}
            hint={
              linkTaskTarget.linkType === 'resolved_by' ? (
                <div className="text-[11px] text-emerald-700 bg-emerald-50 rounded p-2">
                  ✓ Каскад: для каждой выбранной задачи статус на пересекающихся
                  объектах (между task.object_ids и event.object_ids) автоматически
                  переведётся в «Выполнено» (только для активных строк, финальные
                  cancelled/done не трогаем).
                </div>
              ) : null
            }
            onClose={() => setLinkTaskTarget(null)}
            onSubmit={async ({ toIds, notes }) => {
              // INSERT direction: from=task, to=event (обратно к обычным forward-связям).
              for (const taskId of toIds) {
                const insRes = await supabase.from('entity_links').insert({
                  from_type: 'task',
                  from_id:   taskId,
                  to_type:   'event',
                  to_id:     linkTaskTarget.eventId,
                  link_type: linkTaskTarget.linkType,
                  notes:     notes || null,
                }).select('id').single()
                if (insRes.error || !insRes.data) {
                  return insRes.error?.message ?? 'Не удалось создать связь'
                }
                const linkId = insRes.data.id as string

                // Каскад resolved_by → закрытие task_object_status на
                // пересекающихся объектах (по аналогии с tasks/page.tsx).
                if (linkTaskTarget.linkType === 'resolved_by') {
                  const ev = events.find((e) => e.id === linkTaskTarget.eventId)
                  const task = tasksRef.find((t) => t.id === taskId)
                  if (ev && task) {
                    const eventObjectIds = ev.object_ids ?? []
                    const taskObjectIds = task.object_ids ?? []
                    // Пересечение, либо все объекты задачи если у события нет object_ids
                    const targets = eventObjectIds.length > 0
                      ? taskObjectIds.filter((oid) => eventObjectIds.includes(oid))
                      : taskObjectIds
                    const resolveDate = ev.date_end ?? ev.date_computed ?? new Date().toISOString().slice(0, 10)
                    if (targets.length > 0) {
                      const updRes = await supabase
                        .from('task_object_status')
                        .update({
                          status: 'done',
                          done_date: resolveDate,
                          done_note: notes || null,
                          resolved_via_link_id: linkId,
                        })
                        .eq('task_id', taskId)
                        .in('object_id', targets)
                        .in('status', ['open', 'in_progress'])
                      if (updRes.error) {
                        console.error('cascade resolve_by failed:', updRes.error.message)
                      }
                    }
                  }
                }
              }
              await reloadTasksAndLinks()
              setLinkTaskTarget(null)
              return null
            }}
          />
        )
      })()}
    </div>
  )
}


// ─── Колонка «Природа события» ─────────────────────────────────────────────
// Источник истины — entity_links + clause_events + events.derived_source.
// Приоритет: clause > document > letter > meeting > tg/mail/bitrix (auto) > manual.
function NatureCell({
  ev,
  links,
  clauses,
  docs,
  userById,
}: {
  ev: Event
  links: EntityLink[]
  clauses: ClauseLink[]
  docs: DocRef[]
  userById: Map<string, UserRef>
}) {
  // Приоритет: clause > document > letter > meeting (от частного к общему)
  if (clauses.length > 0) {
    const cl = clauses[0]
    return (
      <Link
        href={`/contracts/${cl.document_id}`}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-xs hover:bg-green-100"
        title={cl.description}
      >
        📋 п.{cl.order_index} {cl.document_title}
      </Link>
    )
  }

  const docLink = links.find((l) => l.link_type === 'from_document' && l.to_type === 'document')
  if (docLink) {
    const doc = docs.find((d) => d.id === docLink.to_id)
    return (
      <Link
        href={`/contracts/${docLink.to_id}`}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs hover:bg-blue-100"
        title={doc?.title || ''}
      >
        📄 {doc?.title?.slice(0, 30) || 'Договор'}
      </Link>
    )
  }

  const letterLink = links.find((l) => l.link_type === 'from_letter')
  if (letterLink) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded text-xs">
        ✉️ Письмо
      </span>
    )
  }

  const meetingLink = links.find((l) => l.link_type === 'from_meeting')
  if (meetingLink) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-xs">
        🤝 Собрание
      </span>
    )
  }

  // Источник из автомата-классификатора (tg / mail / bitrix)
  const ds = ev.derived_source
  if (ds === 'tg') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-sky-50 text-sky-700 rounded text-xs"
        title={ev.classifier_template_code ? `Автомат: ${ev.classifier_template_code}` : 'Из Telegram-классификатора'}
      >
        💬 Telegram
      </span>
    )
  }
  if (ds === 'mail') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-orange-50 text-orange-700 rounded text-xs"
            title="Из email-классификатора">
        📧 Email
      </span>
    )
  }
  if (ds === 'bitrix') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-cyan-50 text-cyan-700 rounded text-xs"
            title="Из Bitrix-классификатора">
        🏢 Bitrix
      </span>
    )
  }

  // Вручную: если есть автор — показываем имя, иначе просто «вручную»
  if (ev.created_by) {
    const u = userById.get(ev.created_by)
    const name = u?.name || u?.email || ev.created_by.slice(0, 8)
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-700 rounded text-xs"
        title={`Создал вручную: ${u?.email ?? name}`}
      >
        📝 {name}
      </span>
    )
  }
  return <span className="text-xs text-gray-400">📝 вручную</span>
}

// ─── FilesSection ─────────────────────────────────────────────────────────
// Загрузка/просмотр/удаление файлов события + LLM-реферирование.
function FilesSection({ event }: { event: Event }) {
  const [items, setItems]   = useState<Attachment[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [referring, setReferring] = useState<string | null>(null)
  const [error, setError] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)

  async function load() {
    setLoading(true)
    const r = await fetch(`/api/events/${event.id}/attachments`)
    const data = await r.json()
    if (r.ok) setItems(data.attachments || [])
    setLoading(false)
  }

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function uploadFile(file: File) {
    setUploading(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/events/${event.id}/attachments`, { method: 'POST', body: fd })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setItems((prev) => [data.attachment, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    for (const f of arr) {
      await uploadFile(f)
    }
  }

  async function refer(att: Attachment, appendToNote: boolean) {
    setReferring(att.id)
    setError('')
    try {
      const r = await fetch(`/api/events/${event.id}/attachments/${att.id}/refer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ append_to_note: appendToNote }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setItems((prev) => prev.map((x) =>
        x.id === att.id ? { ...x, summary: data.summary, summary_at: new Date().toISOString() } : x
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReferring(null)
    }
  }

  async function remove(att: Attachment) {
    if (!confirm(`Удалить файл «${att.file_name}»?`)) return
    const r = await fetch(`/api/events/${event.id}/attachments/${att.id}`, { method: 'DELETE' })
    if (r.ok) {
      setItems((prev) => prev.filter((x) => x.id !== att.id))
    } else {
      const data = await r.json().catch(() => ({}))
      setError(data.error || `HTTP ${r.status}`)
    }
  }

  function fmtSize(n: number | null): string {
    if (!n) return ''
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  const KIND_ICON: Record<string, string> = {
    document: '📄', image: '🖼️', archive: '🗜️',
    video: '🎥', audio: '🎵', other: '📎',
  }

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
        Файлы <span className="text-gray-400 font-normal normal-case">({items.length})</span>
      </h3>

      {error && <div className="p-2 mb-2 bg-red-50 text-red-700 text-xs rounded">{error}</div>}

      {/* Список */}
      {loading ? (
        <div className="text-sm text-gray-400">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-gray-400">— файлов нет —</div>
      ) : (
        <ul className="space-y-2">
          {items.map((att) => (
            <li key={att.id} className="border rounded p-2.5 text-sm">
              <div className="flex items-start gap-2">
                <span className="text-base">{KIND_ICON[att.kind] || '📎'}</span>
                <div className="flex-1 min-w-0">
                  <a
                    href={`/api/events/${event.id}/attachments/${att.id}`}
                    target="_blank" rel="noreferrer"
                    className="text-blue-700 hover:underline break-all"
                  >
                    {att.file_name}
                  </a>
                  <div className="text-xs text-gray-400">
                    {att.kind} · {fmtSize(att.file_size)}
                    {att.summary_at && (
                      <> · ✨ выжимка от {new Date(att.summary_at).toLocaleDateString('ru-RU')}</>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => refer(att, false)}
                    disabled={referring === att.id || uploading}
                    className="px-2 py-0.5 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
                    title="LLM-выжимка"
                  >
                    {referring === att.id ? '⏳' : '✨'}
                  </button>
                  <button
                    onClick={() => refer(att, true)}
                    disabled={referring === att.id || uploading}
                    className="px-2 py-0.5 bg-emerald-700 text-white text-xs rounded hover:bg-emerald-800 disabled:opacity-50"
                    title="LLM-выжимка + добавить в комментарий"
                  >
                    ✨+📝
                  </button>
                  <button
                    onClick={() => remove(att)}
                    disabled={uploading}
                    className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded hover:bg-red-200 disabled:opacity-50"
                    title="Удалить"
                  >
                    🗑
                  </button>
                </div>
              </div>
              {att.summary && (
                <div className="mt-2 ml-6 text-xs text-gray-700 bg-emerald-50 border-l-2 border-emerald-300 px-2 py-1 rounded">
                  <span className="font-semibold text-emerald-700">Выжимка:</span> {att.summary}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Загрузка — drag & drop + клик */}
      <label
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true) }}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={(e) => {
          // важно: dragLeave срабатывает и при наведении на детей. Сбрасываем только если ушли за пределы.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDragOver(false)
        }}
        onDrop={async (e) => {
          e.preventDefault()
          setDragOver(false)
          if (uploading) return
          const files = e.dataTransfer.files
          if (files && files.length > 0) await uploadFiles(files)
        }}
        className={`mt-3 flex flex-col items-center justify-center gap-1 px-4 py-4 border-2 border-dashed rounded cursor-pointer transition-colors ${
          dragOver
            ? 'border-emerald-500 bg-emerald-100'
            : 'border-emerald-300 bg-white hover:border-emerald-500 hover:bg-emerald-50'
        } ${uploading ? 'opacity-60 cursor-wait' : ''}`}
      >
        <input
          type="file"
          multiple
          onChange={async (e) => {
            const files = e.target.files
            if (files && files.length > 0) {
              await uploadFiles(files)
              e.target.value = ''
            }
          }}
          disabled={uploading}
          className="hidden"
        />
        {uploading ? (
          <span className="text-sm text-emerald-700">⏳ Загрузка…</span>
        ) : (
          <>
            <span className="text-2xl leading-none">📎</span>
            <span className="text-sm text-emerald-700 font-medium">
              Перетащите файл сюда или кликните
            </span>
            <span className="text-xs text-gray-500">PDF, DOCX, TXT, изображения и др.</span>
          </>
        )}
      </label>
    </section>
  )
}

// ─── FilterRow ────────────────────────────────────────────────────────────
// Ряд чипов-чекбоксов с заголовком и кнопкой очистки
function FilterRow({
  label, options, selected, onToggle, onClear,
}: {
  label: string
  options: { value: string; label: string; badge?: string }[]
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold w-20 shrink-0 pt-1.5">{label}</span>
      <div className="flex flex-wrap gap-1.5 flex-1">
        {options.map((opt) => {
          const active = selected.includes(opt.value)
          const base = 'inline-flex items-center px-2 py-0.5 rounded text-xs cursor-pointer border transition-colors'
          const cls = active
            ? `${opt.badge || 'bg-blue-600 text-white border-blue-600'} ring-2 ring-offset-1 ring-blue-300`
            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
          return (
            <button key={opt.value} onClick={() => onToggle(opt.value)} className={`${base} ${cls}`}>
              {opt.label}
            </button>
          )
        })}
        {selected.length > 0 && (
          <button
            onClick={onClear}
            className="inline-flex items-center px-2 py-0.5 rounded text-xs cursor-pointer border border-red-300 text-red-600 bg-white hover:bg-red-50"
          >
            ✕ Сбросить ({selected.length})
          </button>
        )}
      </div>
    </div>
  )
}

export default function EventsPage() {
  return (
    <Suspense fallback={null}>
      <EventsPageInner />
    </Suspense>
  )
}
