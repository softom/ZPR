'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Event = {
  id: string
  event_type: string
  title: string | null
  date_end: string | null
  date_start: string | null
  date_computed: string | null
  event_time: string | null        // 'HH:MM:SS' или null
  object_ids: string[] | null
  object_codes: string[] | null   // DEPRECATED — оставлен для совместимости с legacy записями
  stage_name: string | null
  note: string | null
  fact_date: string | null
  is_planned: boolean | null
  created_at: string
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
type ObjectRef = { id: string; code: string; current_name: string }
type LegalEntity = { id: string; name: string; short_name: string | null }
type EntityLink = { from_id: string; to_type: string; to_id: string; link_type: string }
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
  onClose,
  onLinksChanged,
  onEventChanged,
  onDeleted,
}: {
  event: Event
  links: EntityLink[]
  clauseLinks: ClauseLink[]
  objects: ObjectRef[]
  entities: LegalEntity[]
  docs: DocRef[]
  subtypes: Subtype[]
  onClose: () => void
  onLinksChanged: () => void
  onEventChanged: () => void
  onDeleted: () => void
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

  const [addObject,  setAddObject]  = useState('')
  const [addDoc,     setAddDoc]     = useState('')
  const [addEntity,  setAddEntity]  = useState('')
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
      // Если событие фактическое — синхронизируем fact_date
      if (event.is_planned === false) update.fact_date = dateDraft
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
    const newIds = [...objectIdsFromEvent, oid]
    await supabase.from('events').update({ object_ids: newIds }).eq('id', event.id)
    setSaving(false)
    onEventChanged()
  }

  // Сменить тип события
  async function saveEventType(newType: string) {
    if (newType === event.event_type) return
    setSaving(true)
    await supabase.from('events').update({ event_type: newType }).eq('id', event.id)
    setSaving(false)
    onEventChanged()
  }

  // Переключатель План ↔ Факт
  async function togglePlanned(nextIsPlanned: boolean) {
    setSaving(true)
    const update: Record<string, unknown> = { is_planned: nextIsPlanned }
    // Факт → fact_date синхронизируется с date_end; План → fact_date обнуляется
    if (nextIsPlanned) {
      update.fact_date = null
    } else if (event.date_end) {
      update.fact_date = event.date_end
    }
    await supabase.from('events').update(update).eq('id', event.id)
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

  async function addLink(toType: string, toId: string) {
    if (!toId) return
    setSaving(true)
    await supabase.from('entity_links').insert({
      from_type: 'event',
      from_id:   event.id,
      to_type:   toType,
      to_id:     toId,
      link_type: 'belongs_to',
    })
    setSaving(false)
    onLinksChanged()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
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
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={deleteEvent}
                disabled={saving || regenerating}
                className="px-2 py-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-50"
                title="Удалить событие"
              >🗑</button>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-1"
              >×</button>
            </div>
          </div>
          {/* Дата + время + План/Факт — inline в шапке */}
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
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={event.is_planned === true}
                onChange={(e) => togglePlanned(e.target.checked)}
                disabled={saving}
                className="cursor-pointer"
              />
              <span className={event.is_planned ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}>
                {event.is_planned ? 'План' : 'Факт'}
              </span>
            </label>
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
                    <span key={oid} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                      {o?.current_name || oid}
                      <button onClick={() => removeObject(oid)} className="hover:text-blue-900 font-bold">×</button>
                    </span>
                  )
                })}
              </div>
              <div className="flex gap-1">
                <select
                  value={addObject}
                  onChange={(e) => setAddObject(e.target.value)}
                  className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-xs"
                >
                  <option value="">+ объект</option>
                  {objects
                    .filter((o) => !allObjectIds.includes(o.id))
                    .map((o) => (
                      <option key={o.id} value={o.id}>{o.code} — {o.current_name}</option>
                    ))}
                </select>
                <button
                  onClick={async () => { await addObjectToEvent(addObject); setAddObject('') }}
                  disabled={!addObject || saving}
                  className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded disabled:opacity-40 shrink-0"
                >+</button>
              </div>
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
              <div className="flex gap-1">
                <select
                  value={addEntity}
                  onChange={(e) => setAddEntity(e.target.value)}
                  className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-xs"
                >
                  <option value="">+ юр.лицо</option>
                  {entities.map((le) => (
                    <option key={le.id} value={le.id}>{le.short_name || le.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => { addLink('legal_entity', addEntity); setAddEntity('') }}
                  disabled={!addEntity || saving}
                  className="px-2 py-0.5 bg-amber-600 text-white text-xs rounded disabled:opacity-40 shrink-0"
                >+</button>
              </div>
            </section>
          </div>

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
            <div className="flex gap-1">
              <select
                value={addDoc}
                onChange={(e) => setAddDoc(e.target.value)}
                className="flex-1 min-w-0 px-1.5 py-0.5 border rounded text-xs"
              >
                <option value="">+ договор</option>
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
              <button
                onClick={() => { addLink('document', addDoc); setAddDoc('') }}
                disabled={!addDoc || saving}
                className="px-2 py-0.5 bg-violet-600 text-white text-xs rounded disabled:opacity-40 shrink-0"
              >+</button>
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}

// ─── Главная страница ────────────────────────────────────────────────────────

export default function EventsPage() {
  const [events,       setEvents]       = useState<Event[]>([])
  const [subtypes,     setSubtypes]     = useState<Subtype[]>([])
  const [objects,      setObjects]      = useState<ObjectRef[]>([])
  const [entities,     setEntities]     = useState<LegalEntity[]>([])
  const [docs,         setDocs]         = useState<DocRef[]>([])
  const [links,        setLinks]        = useState<EntityLink[]>([])
  const [clauseLinks,  setClauseLinks]  = useState<ClauseLink[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [editing,      setEditing]      = useState<Event | null>(null)

  // Фильтры
  // Фильтры: множественный выбор (пустой массив = «все»)
  const [filterCategories, setFilterCategories] = useState<string[]>([])
  const [filterObjects,    setFilterObjects]    = useState<string[]>([])
  const [filterEntities,   setFilterEntities]   = useState<string[]>([])
  // Тип создания (Природа): clause | document | letter | meeting | manual
  const [filterNatures,    setFilterNatures]    = useState<string[]>([])
  const [search,         setSearch]         = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    const [ev, ob, le, st, lk, dc, cl] = await Promise.all([
      supabase
        .from('events')
        .select('id,event_type,title,date_end,date_start,date_computed,event_time,fact_date,is_planned,object_ids,object_codes,stage_name,note,created_at')
        .not('event_type', 'in', '(contract_loaded)')
        // Внутри дня: сначала события без времени (по id), потом по времени ASC.
        // День → DESC (свежий месяц/день сверху).
        .order('date_computed', { ascending: false })
        .order('event_time',    { ascending: true, nullsFirst: true })
        .order('id',            { ascending: true })
        .limit(500),
      supabase.from('objects').select('id,code,current_name').eq('active', true),
      supabase.from('legal_entities').select('id,name,short_name').eq('is_active', true),
      supabase.from('event_subtypes').select('code,category,label,icon').order('sort_order'),
      supabase.from('entity_links').select('from_id,to_type,to_id,link_type').eq('from_type', 'event'),
      supabase.from('documents').select('id,title').eq('type', 'ДОГОВОРА').is('deleted_at', null).order('title'),
      supabase
        .from('clause_events')
        .select('event_id, clause_id, contract_clauses(id, order_index, description, document_id, documents(id, title))'),
    ])
    if (ev.error) setError(ev.error.message)
    setEvents((ev.data as Event[]) || [])
    setObjects((ob.data as ObjectRef[]) || [])
    setEntities((le.data as LegalEntity[]) || [])
    setSubtypes((st.data as Subtype[]) || [])
    setLinks((lk.data as EntityLink[]) || [])
    setDocs((dc.data as DocRef[]) || [])

    // Развернуть JOIN clause_events → contract_clauses → documents в плоский ClauseLink[]
    type ClauseRow = {
      event_id: string
      clause_id: string
      contract_clauses: {
        id: string
        order_index: number
        description: string
        document_id: string
        documents: { id: string; title: string } | null
      } | null
    }
    const flatClauseLinks: ClauseLink[] = []
    for (const row of (cl.data ?? []) as unknown as ClauseRow[]) {
      const cc = row.contract_clauses
      if (!cc) continue
      flatClauseLinks.push({
        event_id: row.event_id,
        clause_id: cc.id,
        order_index: cc.order_index,
        description: cc.description,
        document_id: cc.document_id,
        document_title: cc.documents?.title ?? '—',
      })
    }
    setClauseLinks(flatClauseLinks)

    setLoading(false)
  }

  async function reloadEvent(eventId: string) {
    const { data } = await supabase
      .from('events')
      .select('id,event_type,title,date_end,date_start,date_computed,event_time,fact_date,is_planned,object_ids,object_codes,stage_name,note,created_at')
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
    const r = await supabase.from('entity_links').select('from_id,to_type,to_id,link_type').eq('from_type', 'event')
    setLinks((r.data as EntityLink[]) || [])
  }

  const subtypeMap = useMemo(() => {
    const m: Record<string, Subtype> = {}
    for (const s of subtypes) m[s.code] = s
    return m
  }, [subtypes])

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
      if (filterNatures.length > 0) {
        const myLinks = linksByEvent[ev.id] || []
        const myClauses = clausesByEvent[ev.id] || []
        const hasClause   = myClauses.length > 0
        const hasDoc      = myLinks.some((l) => l.link_type === 'from_document' && l.to_type === 'document')
        const hasLetter   = myLinks.some((l) => l.link_type === 'from_letter')
        const hasMeeting  = myLinks.some((l) => l.link_type === 'from_meeting')
        const isManual    = !hasClause && !hasDoc && !hasLetter && !hasMeeting
        const matchesOne = (n: string) =>
          (n === 'clause'   && hasClause) ||
          (n === 'document' && hasDoc && !hasClause) ||
          (n === 'letter'   && hasLetter) ||
          (n === 'meeting'  && hasMeeting) ||
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
  }, [events, filterCategories, filterObjects, filterEntities, filterNatures, search, subtypeMap, linksByEvent, clausesByEvent])

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

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">События</h1>
          <button
            onClick={async () => {
              // Создаём минимальную заготовку и сразу открываем редактор
              const today = new Date().toISOString().slice(0, 10)
              const { data, error: e } = await supabase.from('events').insert({
                event_type: 'project_note',
                title: 'Новое событие',
                date_mode: 'absolute',
                date_start: today,
                date_end:   today,
                fact_date:  today,
                is_planned: false,
                object_ids: [],
              }).select('id,event_type,title,date_end,date_start,date_computed,event_time,fact_date,is_planned,object_ids,object_codes,stage_name,note,created_at').single()
              if (e) { setError(e.message); return }
              await load()
              setEditing(data as Event)
            }}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          >
            + Создать событие
          </button>
        </div>
        <div className="text-sm text-gray-600">
          Всего: <b>{stats.total}</b>
          {Object.entries(stats.cats).map(([cat, cnt]) => (
            <span key={cat}> · <span className={`px-1.5 py-0.5 rounded text-xs ${CATEGORY_BADGE[cat] || 'bg-gray-100 text-gray-600'}`}>{CATEGORY_LABELS[cat] || cat}: {cnt}</span></span>
          ))}
        </div>
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
                          <td className="px-2 py-2 text-base text-center align-top">{st?.icon || '◆'}</td>
                          <td className="px-2 py-2 text-xs text-gray-600 align-top">
                            {formatDate(ev.date_computed)}
                            {ev.event_time && (
                              <div className="text-gray-400">{ev.event_time.slice(0, 5)}</div>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${CATEGORY_BADGE[st?.category || ''] || 'bg-gray-100 text-gray-600'}`}>
                              {st?.label || ev.event_type}
                            </span>
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="font-medium text-gray-900 line-clamp-2 break-words">{ev.title || '—'}</div>
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
                            <NatureCell links={myLinks} clauses={myClauses} docs={docs} />
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="flex flex-wrap gap-1">
                              {/* основной канал: events.object_ids (UUID) */}
                              {ev.object_ids?.map((oid) => {
                                const o = objects.find((x) => x.id === oid)
                                return (
                                  <span key={oid} className="inline-block px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded break-words">
                                    {o?.current_name || oid}
                                  </span>
                                )
                              })}
                              {/* fallback на entity_links если object_ids пуст */}
                              {(!ev.object_ids || ev.object_ids.length === 0) && objLinks.map((l) => {
                                const o = objects.find((x) => x.id === l.to_id || x.code === l.to_id)
                                return (
                                  <span key={l.to_id} className="inline-block px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded break-words">
                                    {o?.current_name || l.to_id}
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
          onClose={() => setEditing(null)}
          onLinksChanged={() => reloadLinks()}
          onEventChanged={() => reloadEvent(editing.id)}
          onDeleted={async () => { setEditing(null); await load() }}
        />
      )}
    </div>
  )
}


// ─── Колонка «Природа события» ─────────────────────────────────────────────
// Источник истины — entity_links + clause_events. Показываем первый источник
// с иконкой и кратким описанием. По клику — переход на сущность-источник.
function NatureCell({
  links,
  clauses,
  docs,
}: {
  links: EntityLink[]
  clauses: ClauseLink[]
  docs: DocRef[]
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
