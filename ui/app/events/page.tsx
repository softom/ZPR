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
  entity_id: string | null
  entity_type: string | null
  object_codes: string[] | null
  stage_name: string | null
  note: string | null
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
type ObjectRef = { code: string; current_name: string }
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
  onClose,
  onLinksChanged,
  onEventChanged,
}: {
  event: Event
  links: EntityLink[]
  clauseLinks: ClauseLink[]
  objects: ObjectRef[]
  entities: LegalEntity[]
  docs: DocRef[]
  onClose: () => void
  onLinksChanged: () => void
  onEventChanged: () => void
}) {
  const myLinks = links.filter((l) => l.from_id === event.id)
  const objLinks = myLinks.filter((l) => l.to_type === 'object')
  const docLinks = myLinks.filter((l) => l.to_type === 'document')
  const leLinks  = myLinks.filter((l) => l.to_type === 'legal_entity')
  const myClauses = clauseLinks.filter((l) => l.event_id === event.id)

  const [addObject,  setAddObject]  = useState('')
  const [addDoc,     setAddDoc]     = useState('')
  const [addEntity,  setAddEntity]  = useState('')
  const [saving,     setSaving]     = useState(false)
  const [noteDraft,  setNoteDraft]  = useState(event.note ?? '')

  async function saveNote() {
    if ((event.note ?? '') === noteDraft) return
    setSaving(true)
    await supabase.from('events').update({ note: noteDraft || null }).eq('id', event.id)
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

  const subtype = null // subtypes are passed separately when needed

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b sticky top-0 bg-white z-10 flex justify-between items-start">
          <div>
            <p className="text-xs text-gray-500 font-mono">{event.event_type}</p>
            <h2 className="text-lg font-semibold mt-0.5">{event.title || event.event_type}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{formatDate(event.date_computed)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-5">

          {/* Комментарий (events.note) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Комментарий</h3>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={saveNote}
              placeholder="Свободный текст: контекст, цитата из документа, пояснения..."
              rows={4}
              className="w-full px-2 py-1.5 border rounded text-sm font-mono resize-y"
              disabled={saving}
            />
          </section>

          {/* Пункты договора (clause_events, read-only) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
              Пункты договора <span className="text-gray-400 font-normal normal-case">(источник события)</span>
            </h3>
            {myClauses.length === 0 ? (
              <span className="text-sm text-gray-400">— событие не связано с пунктом договора (модуль C / Этап 3)</span>
            ) : (
              <ul className="space-y-1.5">
                {myClauses.map((cl) => (
                  <li key={cl.clause_id} className="text-sm">
                    <Link
                      href={`/contracts/${cl.document_id}`}
                      className="inline-flex items-center gap-2 px-2 py-1 bg-green-50 text-green-800 rounded hover:bg-green-100"
                    >
                      <span className="text-xs font-semibold">→ {cl.document_title}</span>
                      <span className="text-xs text-green-600">п.{cl.order_index}</span>
                    </Link>
                    <div className="text-xs text-gray-500 ml-2 mt-0.5">{cl.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Объекты */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Объекты</h3>
            <div className="flex flex-wrap gap-1 mb-2">
              {objLinks.length === 0 && <span className="text-sm text-gray-400">—</span>}
              {objLinks.map((l) => {
                const o = objects.find((x) => x.code === l.to_id)
                return (
                  <span key={l.to_id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                    {o?.current_name || l.to_id}
                    <button onClick={() => removeLink(l)} className="hover:text-blue-900 font-bold">×</button>
                  </span>
                )
              })}
            </div>
            <div className="flex gap-2">
              <select
                value={addObject}
                onChange={(e) => setAddObject(e.target.value)}
                className="flex-1 px-2 py-1 border rounded text-sm"
              >
                <option value="">— добавить объект —</option>
                {objects.map((o) => (
                  <option key={o.code} value={o.code}>{o.code} — {o.current_name}</option>
                ))}
              </select>
              <button
                onClick={() => { addLink('object', addObject); setAddObject('') }}
                disabled={!addObject || saving}
                className="px-3 py-1 bg-blue-600 text-white text-sm rounded disabled:opacity-40"
              >+</button>
            </div>
          </section>

          {/* Договора */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Договора</h3>
            <div className="flex flex-wrap gap-1 mb-2">
              {docLinks.length === 0 && <span className="text-sm text-gray-400">—</span>}
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
            <div className="flex gap-2">
              <select
                value={addDoc}
                onChange={(e) => setAddDoc(e.target.value)}
                className="flex-1 px-2 py-1 border rounded text-sm"
              >
                <option value="">— добавить договор —</option>
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
              <button
                onClick={() => { addLink('document', addDoc); setAddDoc('') }}
                disabled={!addDoc || saving}
                className="px-3 py-1 bg-violet-600 text-white text-sm rounded disabled:opacity-40"
              >+</button>
            </div>
          </section>

          {/* Юр.лица */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Юр.лица</h3>
            <div className="flex flex-wrap gap-1 mb-2">
              {leLinks.length === 0 && <span className="text-sm text-gray-400">—</span>}
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
            <div className="flex gap-2">
              <select
                value={addEntity}
                onChange={(e) => setAddEntity(e.target.value)}
                className="flex-1 px-2 py-1 border rounded text-sm"
              >
                <option value="">— добавить юр.лицо —</option>
                {entities.map((le) => (
                  <option key={le.id} value={le.id}>{le.short_name || le.name}</option>
                ))}
              </select>
              <button
                onClick={() => { addLink('legal_entity', addEntity); setAddEntity('') }}
                disabled={!addEntity || saving}
                className="px-3 py-1 bg-amber-600 text-white text-sm rounded disabled:opacity-40"
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
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [filterObject,   setFilterObject]   = useState<string>('')
  const [filterEntity,   setFilterEntity]   = useState<string>('')
  const [search,         setSearch]         = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    const [ev, ob, le, st, lk, dc, cl] = await Promise.all([
      supabase
        .from('events')
        .select('id,event_type,title,date_end,date_start,date_computed,entity_id,entity_type,object_codes,stage_name,note,created_at')
        .not('event_type', 'in', '(contract_loaded)')
        .order('date_computed', { ascending: false })
        .limit(500),
      supabase.from('objects').select('code,current_name').eq('active', true),
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
      .select('id,event_type,title,date_end,date_start,date_computed,entity_id,entity_type,object_codes,stage_name,note,created_at')
      .eq('id', eventId)
      .maybeSingle()
    if (data) setEvents(prev => prev.map(e => e.id === eventId ? (data as Event) : e))
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

  // Фильтрация
  const filtered = useMemo(() => {
    return events.filter((ev) => {
      if (filterCategory !== 'all') {
        const st = subtypeMap[ev.event_type]
        if (!st || st.category !== filterCategory) return false
      }
      if (filterObject) {
        const myLinks = linksByEvent[ev.id] || []
        const hasObj = myLinks.some((l) => l.to_type === 'object' && l.to_id === filterObject)
        const hasObjCodes = ev.object_codes?.includes(filterObject)
        if (!hasObj && !hasObjCodes) return false
      }
      if (filterEntity) {
        const myLinks = linksByEvent[ev.id] || []
        if (!myLinks.some((l) => l.to_type === 'legal_entity' && l.to_id === filterEntity)) return false
      }
      if (search) {
        const q = search.toLowerCase()
        const hay = ((ev.title || '') + ' ' + ev.event_type + ' ' + (ev.stage_name || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [events, filterCategory, filterObject, filterEntity, search, subtypeMap, linksByEvent])

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
        <h1 className="text-2xl font-bold">События</h1>
        <div className="text-sm text-gray-600">
          Всего: <b>{stats.total}</b>
          {Object.entries(stats.cats).map(([cat, cnt]) => (
            <span key={cat}> · <span className={`px-1.5 py-0.5 rounded text-xs ${CATEGORY_BADGE[cat] || 'bg-gray-100 text-gray-600'}`}>{CATEGORY_LABELS[cat] || cat}: {cnt}</span></span>
          ))}
        </div>
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {/* Фильтры */}
      <div className="bg-white rounded shadow p-4 mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="all">Все категории</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select
          value={filterObject}
          onChange={(e) => setFilterObject(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="">Все объекты</option>
          {objects.map((o) => (
            <option key={o.code} value={o.code}>{o.code} — {o.current_name}</option>
          ))}
        </select>
        <select
          value={filterEntity}
          onChange={(e) => setFilterEntity(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="">Все юр.лица</option>
          {entities.map((le) => (
            <option key={le.id} value={le.id}>{le.short_name || le.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по названию…"
          className="px-3 py-1.5 border rounded text-sm"
        />
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
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b text-left">
                    <tr>
                      <th className="px-3 py-2 w-10">  </th>
                      <th className="px-3 py-2 w-28">Дата</th>
                      <th className="px-3 py-2 w-28">Тип</th>
                      <th className="px-3 py-2">Название / этап</th>
                      <th className="px-3 py-2 w-48">Объекты</th>
                      <th className="px-3 py-2 w-36">Юр.лицо</th>
                      <th className="px-3 py-2 w-10"></th>
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
                        <tr key={ev.id} className="border-b hover:bg-gray-50">
                          <td className="px-3 py-2 text-base text-center align-top">{st?.icon || '◆'}</td>
                          <td className="px-3 py-2 text-xs text-gray-600 align-top">{formatDate(ev.date_computed)}</td>
                          <td className="px-3 py-2 align-top">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${CATEGORY_BADGE[st?.category || ''] || 'bg-gray-100 text-gray-600'}`}>
                              {st?.label || ev.event_type}
                            </span>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-gray-900 line-clamp-1">{ev.title || '—'}</div>
                            {ev.stage_name && (
                              <div className="text-xs text-gray-400 line-clamp-1">{ev.stage_name}</div>
                            )}
                            {ev.note && (
                              <div className="text-xs text-gray-500 italic line-clamp-2 mt-0.5 whitespace-pre-line">{ev.note}</div>
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
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {/* из entity_links */}
                              {objLinks.slice(0, 3).map((l) => {
                                const o = objects.find((x) => x.code === l.to_id)
                                return (
                                  <span key={l.to_id} className="inline-block px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                                    {o?.current_name || l.to_id}
                                  </span>
                                )
                              })}
                              {/* legacy object_codes */}
                              {objLinks.length === 0 && ev.object_codes?.slice(0, 2).map((oc) => {
                                const o = objects.find((x) => x.code === oc)
                                return (
                                  <span key={oc} className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                                    {o?.current_name || oc}
                                  </span>
                                )
                              })}
                              {objLinks.length > 3 && (
                                <span className="text-xs text-gray-400">+{objLinks.length - 3}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {leLinks.slice(0, 2).map((l) => {
                                const le = entities.find((x) => x.id === l.to_id)
                                return (
                                  <span key={l.to_id} className="inline-block px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs rounded">
                                    {le?.short_name || le?.name || '…'}
                                  </span>
                                )
                              })}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => setEditing(ev)}
                              className="text-gray-400 hover:text-gray-700 text-sm"
                              title="Редактировать привязки"
                            >✎</button>
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
          onClose={() => setEditing(null)}
          onLinksChanged={() => reloadLinks()}
          onEventChanged={() => reloadEvent(editing.id)}
        />
      )}
    </div>
  )
}
