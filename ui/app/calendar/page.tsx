'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ObjectBadge } from '@/components/ObjectBadge'
import { isImageUrl, optionIconPrefix } from '@/lib/objects/iconLabel'

// ─── Типы ─────────────────────────────────────────────────────────────────
type CalendarEntry = {
  id: string
  entry_type: string
  title: string | null
  title_original: string | null
  object_ids: string[]
  date_mode: 'absolute' | 'relative'
  date_start: string | null
  date_end: string | null
  date_ref_entry_id: string | null
  date_ref_offset: number
  date_ref_offset_type: 'calendar' | 'working'
  date_computed: string | null
  duration_note: string | null
  exec_days: number | null
  exec_type: 'calendar' | 'working' | null
  is_manual: boolean
  stage_name: string | null
  // MSPDI-метаданные
  mspdi_uid: number | null
  mspdi_id: number | null
  outline_level: number | null
  outline_number: string | null
  is_summary: boolean
  is_project_wide: boolean
  percent_complete: number | null
  task_mode: 'auto' | 'manual'
  mspdi_notes: string | null
  schedule_raw_text: string | null
}

type ObjectStatusRow = {
  calendar_id: string
  object_id: string
  is_planned: boolean
  fact_date: string | null
  fact_note: string | null
}

type ObjectRef = { id: string; code: string; current_name: string; color: string | null; icon: string | null }
type DocRef = { id: string; title: string }

// ─── Константы ────────────────────────────────────────────────────────────
const ENTRY_TYPE_ICON: Record<string, string> = {
  fin_advance: '💰', fin_interim: '💸', fin_final: '✅', fin_loan: '🏦',
  work_start: '▶', work_end: '⬛', work_stage: '◆',
  appr_submission: '📤', appr_review: '🔍', appr_sign: '📝',
  exec_work: '🔨', contract_signed: '📋', contract_loaded: '📥',
}

const ENTRY_TYPE_LABEL: Record<string, string> = {
  fin_advance: 'Аванс',
  fin_interim: 'Промежуточная оплата',
  fin_final: 'Окончательный расчёт',
  fin_loan: 'Заём',
  work_start: 'Начало работ',
  work_end: 'Завершение работ',
  work_stage: 'Этап работ',
  appr_submission: 'Подача на согласование',
  appr_review: 'Рассмотрение',
  appr_sign: 'Подписание',
  exec_work: 'Исполнение работ',
  contract_signed: 'Договор подписан',
  contract_loaded: 'Договор загружен',
}

const CATEGORY: Record<string, string> = {
  fin_advance: 'fin', fin_interim: 'fin', fin_final: 'fin', fin_loan: 'fin',
  work_start: 'work', work_end: 'work', work_stage: 'work',
  appr_sign: 'appr', appr_submission: 'appr', appr_review: 'appr',
  exec_work: 'exec',
  contract_signed: 'contract', contract_loaded: 'contract',
}

const CATEGORY_LABELS: Record<string, string> = {
  fin: 'Финансы', work: 'Работы', appr: 'Согласования', exec: 'Исполнение', contract: 'Договор',
}

const CATEGORY_BADGE: Record<string, string> = {
  fin:      'bg-emerald-100 text-emerald-700',
  work:     'bg-blue-100 text-blue-700',
  appr:     'bg-violet-100 text-violet-700',
  exec:     'bg-amber-100 text-amber-700',
  contract: 'bg-slate-200 text-slate-700',
}

// ─── Хелперы ──────────────────────────────────────────────────────────────
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

type VersionRow = { id: string; version_name: string | null; notes: string | null; imported_at: string; is_active: boolean; entry_count: number }

// ─── Главная страница ────────────────────────────────────────────────────
export default function CalendarPage() {
  const [entries,  setEntries]  = useState<CalendarEntry[]>([])
  const [statuses, setStatuses] = useState<ObjectStatusRow[]>([])
  const [objects,  setObjects]  = useState<ObjectRef[]>([])
  const [docs,     setDocs]     = useState<DocRef[]>([])
  const [docLinks, setDocLinks] = useState<Map<string, string>>(new Map()) // calendar_id → document_id
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const [versions,        setVersions]        = useState<VersionRow[]>([])
  const [selectedVersion, setSelectedVersion] = useState<string>('') // '' = активная

  const [filterCategories, setFilterCategories] = useState<string[]>([])
  const [filterObjects,    setFilterObjects]    = useState<string[]>([])
  const [filterPlanFact,   setFilterPlanFact]   = useState<'' | 'plan' | 'fact'>('')
  const [search,           setSearch]           = useState('')

  // Режим отображения и текущий просматриваемый месяц (только для view='calendar')
  const [viewMode,    setViewMode]    = useState<'list' | 'calendar'>('calendar')
  const [viewMonth,   setViewMonth]   = useState<{ y: number; m: number }>(() => {
    const d = new Date()
    return { y: d.getFullYear(), m: d.getMonth() }
  })

  async function loadVersions(): Promise<VersionRow[]> {
    const res = await fetch('/api/schedule/versions')
    const vers: VersionRow[] = res.ok ? await res.json() : []
    setVersions(vers)
    return vers
  }

  useEffect(() => {
    async function init() {
      const vers = await loadVersions()
      const active = vers.find(v => v.is_active)
      const initId = active?.id ?? (vers[0]?.id ?? '')
      setSelectedVersion(initId)
      await load(initId)
    }
    init()
  }, [])

  async function load(versionId: string) {
    setLoading(true)
    setError('')
    let entriesQuery = supabase.from('calendar_entries').select('*').order('date_computed', { ascending: true, nullsFirst: false })
    if (versionId) {
      entriesQuery = entriesQuery.eq('schedule_version_id', versionId)
    }
    const [eRes, sRes, oRes, dRes, lRes] = await Promise.all([
      entriesQuery,
      supabase.from('calendar_object_status').select('*'),
      supabase.from('objects').select('id,code,current_name,color,icon').eq('active', true),
      supabase.from('documents').select('id,title').eq('type', 'ДОГОВОРА').is('deleted_at', null),
      supabase.from('entity_links').select('from_id,to_id').eq('from_type', 'calendar_entry').eq('to_type', 'document'),
    ])
    if (eRes.error) setError(eRes.error.message)
    setEntries((eRes.data ?? []) as CalendarEntry[])
    setStatuses((sRes.data ?? []) as ObjectStatusRow[])
    setObjects((oRes.data ?? []) as ObjectRef[])
    setDocs((dRes.data ?? []) as DocRef[])
    const map = new Map<string, string>()
    for (const l of (lRes.data ?? []) as { from_id: string; to_id: string }[]) {
      map.set(l.from_id, l.to_id)
    }
    setDocLinks(map)
    setLoading(false)
  }

  async function handleVersionChange(versionId: string) {
    setSelectedVersion(versionId)
    setLoading(true)
    // Выбор версии в селекторе делает её активной (рабочей) — звезда переезжает,
    // экспорт и просмотр идут из неё, F5 сохраняет выбор.
    const res = await fetch(`/api/schedule/versions/${versionId}/activate`, { method: 'POST' })
    if (!res.ok) {
      setError('Не удалось активировать версию')
      setLoading(false)
      return
    }
    await loadVersions()       // обновляем флаги is_active (звезда)
    await load(versionId)      // грузим данные выбранной версии
  }

  const statusByEntry = useMemo(() => {
    const m = new Map<string, ObjectStatusRow[]>()
    for (const s of statuses) {
      if (!m.has(s.calendar_id)) m.set(s.calendar_id, [])
      m.get(s.calendar_id)!.push(s)
    }
    return m
  }, [statuses])

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (filterCategories.length > 0) {
        const cat = CATEGORY[e.entry_type] ?? 'other'
        if (!filterCategories.includes(cat)) return false
      }
      if (filterObjects.length > 0) {
        if (!filterObjects.some((oid) => e.object_ids.includes(oid))) return false
      }
      if (filterPlanFact) {
        const ss = statusByEntry.get(e.id) ?? []
        const hasPlan = ss.some((s) => s.is_planned)
        const allFact = ss.length > 0 && ss.every((s) => !s.is_planned)
        if (filterPlanFact === 'plan' && !hasPlan) return false
        if (filterPlanFact === 'fact' && !allFact) return false
      }
      if (search) {
        const q = search.toLowerCase()
        const hay = ((e.title ?? '') + ' ' + e.entry_type + ' ' + (e.stage_name ?? '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [entries, filterCategories, filterObjects, filterPlanFact, search, statusByEntry])

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const e of filtered) {
      const k = monthKey(e.date_computed)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(e)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const stats = useMemo(() => {
    const cats: Record<string, number> = {}
    for (const e of entries) {
      const cat = CATEGORY[e.entry_type] ?? 'other'
      cats[cat] = (cats[cat] || 0) + 1
    }
    return { total: entries.length, cats }
  }, [entries])

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Календарь объекта</h1>
          <span className="text-sm text-gray-400">плановые и фактические вехи договоров</span>
          {/* Переключатель режима отображения */}
          <div className="inline-flex border rounded overflow-hidden ml-2">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1 text-sm ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`}
            >☰ Список</button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1 text-sm border-l ${viewMode === 'calendar' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`}
            >📅 Календарь</button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-600">
            Всего: <b>{stats.total}</b>
            {Object.entries(stats.cats).map(([cat, cnt]) => (
              <span key={cat}> · <span className={`px-1.5 py-0.5 rounded text-xs ${CATEGORY_BADGE[cat] || 'bg-gray-100 text-gray-600'}`}>{CATEGORY_LABELS[cat] || cat}: {cnt}</span></span>
            ))}
          </div>
          <div className="inline-flex items-center gap-2">
            {versions.length > 0 && (
              <select
                value={selectedVersion}
                onChange={e => handleVersionChange(e.target.value)}
                className="text-sm border rounded px-2 py-1.5 bg-white text-gray-700 max-w-[420px]"
                title="Версия плана из MS Project"
              >
                {versions.map(v => {
                  const dt = new Date(v.imported_at).toLocaleString('ru', {
                    day: '2-digit', month: '2-digit', year: '2-digit',
                    hour: '2-digit', minute: '2-digit',
                  })
                  const name = v.version_name?.trim() || v.notes?.trim() || '(без названия)'
                  return (
                    <option key={v.id} value={v.id}>
                      {v.is_active ? '★ ' : ''}{name} · {dt} · {v.entry_count} задач
                    </option>
                  )
                })}
              </select>
            )}
            <Link
              href="/schedule"
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              title="Загрузить MS Project XML (MSPDI)"
            >📥 Импорт XML</Link>
            <a
              href={`/api/schedule/export${selectedVersion ? `?versionId=${selectedVersion}` : ''}`}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              title="Скачать график в MSPDI XML"
            >📤 Экспорт XML</a>
          </div>
        </div>
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {/* Фильтры */}
      <div className="bg-white rounded shadow p-4 mb-4 space-y-3">
        <FilterRow
          label="Категория"
          options={Object.entries(CATEGORY_LABELS).map(([k, v]) => ({ value: k, label: v, badge: CATEGORY_BADGE[k] }))}
          selected={filterCategories}
          onToggle={(v) => setFilterCategories((p) => p.includes(v) ? p.filter((x) => x !== v) : [...p, v])}
          onClear={() => setFilterCategories([])}
        />
        <FilterRow
          label="Объекты"
          options={objects.map((o) => ({ value: o.id, label: `${o.code.split('_')[0]} ${o.current_name.slice(0, 30)}` }))}
          selected={filterObjects}
          onToggle={(v) => setFilterObjects((p) => p.includes(v) ? p.filter((x) => x !== v) : [...p, v])}
          onClear={() => setFilterObjects([])}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold w-20 shrink-0">Статус</span>
          <select
            value={filterPlanFact}
            onChange={(e) => setFilterPlanFact(e.target.value as '' | 'plan' | 'fact')}
            className="px-3 py-1.5 border rounded text-sm"
          >
            <option value="">все</option>
            <option value="plan">только план (есть незакрытые объекты)</option>
            <option value="fact">только факт (все объекты закрыты)</option>
          </select>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="поиск по названию / типу / этапу…"
            className="flex-1 px-3 py-1.5 border rounded text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-gray-400 py-8 text-center">Загрузка…</div>
      ) : viewMode === 'calendar' ? (
        <CalendarGrid
          year={viewMonth.y}
          month={viewMonth.m}
          entries={filtered}
          objects={objects}
          statusByEntry={statusByEntry}
          onPrev={() => setViewMonth(({ y, m }) => m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })}
          onNext={() => setViewMonth(({ y, m }) => m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 })}
          onToday={() => { const d = new Date(); setViewMonth({ y: d.getFullYear(), m: d.getMonth() }) }}
        />
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded shadow p-6 text-center text-gray-400">Нет вех по фильтрам</div>
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
                    <col className="w-9" />
                    <col className="w-24" />
                    <col className="w-32" />
                    <col />
                    <col className="w-44" />
                    <col className="w-28" />
                    <col className="w-20" />
                  </colgroup>
                  <thead className="bg-gray-50 border-b text-left">
                    <tr>
                      <th className="px-2 py-2"> </th>
                      <th className="px-2 py-2">Дата (план)</th>
                      <th className="px-2 py-2">Тип</th>
                      <th className="px-2 py-2">Название</th>
                      <th className="px-2 py-2">Объекты</th>
                      <th className="px-2 py-2">Договор</th>
                      <th className="px-2 py-2">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evs.map((e) => {
                      const cat = CATEGORY[e.entry_type] ?? 'other'
                      const ss = statusByEntry.get(e.id) ?? []
                      const planned = ss.filter((s) => s.is_planned).length
                      const fact    = ss.filter((s) => !s.is_planned).length
                      const docId = docLinks.get(e.id)
                      const doc = docId ? docs.find((d) => d.id === docId) : null
                      // Цвет по первому объекту — для левой границы строки
                      const firstObj = e.object_ids[0] ? objects.find((x) => x.id === e.object_ids[0]) : null
                      const rowAccent = firstObj?.color ?? (e.is_project_wide ? '#475569' : '#cbd5e1')
                      // Расширенный tooltip — multi-line через \n работает в нативном title
                      const tooltipParts: string[] = []
                      if (e.title_original && e.title_original !== e.title)
                        tooltipParts.push(`Оригинал: ${e.title_original}`)
                      if (e.mspdi_id !== null)
                        tooltipParts.push(`MS Project ID: ${e.mspdi_id} (UID: ${e.mspdi_uid})`)
                      if (e.outline_number) tooltipParts.push(`WBS: ${e.outline_number}  L${e.outline_level}`)
                      if (e.percent_complete !== null && e.percent_complete > 0)
                        tooltipParts.push(`Выполнено: ${e.percent_complete}%`)
                      if (e.is_summary) tooltipParts.push('Сводная задача')
                      if (e.is_project_wide) tooltipParts.push('Общая для всего проекта ЗПР')
                      if (e.task_mode === 'manual') tooltipParts.push('Режим планирования: ручной')
                      if (e.schedule_raw_text) tooltipParts.push(`Привязка в Project: ${e.schedule_raw_text}`)
                      if (e.mspdi_notes) tooltipParts.push(`Notes: ${e.mspdi_notes.slice(0, 240)}${e.mspdi_notes.length > 240 ? '…' : ''}`)
                      const tooltip = tooltipParts.join('\n')
                      return (
                        <tr
                          key={e.id}
                          className="border-b hover:bg-gray-50"
                          style={{ borderLeft: `4px solid ${rowAccent}` }}
                          title={tooltip || undefined}
                        >
                          <td className="px-2 py-2 text-base text-center align-top">{ENTRY_TYPE_ICON[e.entry_type] || '◆'}</td>
                          <td className="px-2 py-2 text-xs text-gray-600 align-top">
                            {formatDate(e.date_computed)}
                            {e.date_mode === 'relative' && (
                              <div className="text-gray-400 text-[10px]">формула</div>
                            )}
                            {e.percent_complete !== null && e.percent_complete > 0 && (
                              <div className="text-emerald-600 text-[10px] font-medium">{e.percent_complete}%</div>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${CATEGORY_BADGE[cat] || 'bg-gray-100 text-gray-600'}`}>
                              {ENTRY_TYPE_LABEL[e.entry_type] ?? e.entry_type}
                            </span>
                            {e.is_summary && <div className="mt-1 text-[10px] text-gray-400">сводная</div>}
                            {e.is_project_wide && <div className="mt-1 text-[10px] text-slate-500">📊 ЗПР</div>}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="font-medium text-gray-900 line-clamp-2 break-words">{e.title || '—'}</div>
                            {e.outline_number && (
                              <div className="text-[10px] text-gray-400 font-mono">WBS {e.outline_number}</div>
                            )}
                            {e.stage_name && (
                              <div className="text-xs text-gray-400 line-clamp-1">{e.stage_name}</div>
                            )}
                            {e.duration_note && (
                              <div className="text-xs text-gray-500 italic line-clamp-1">{e.duration_note}</div>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <div className="flex flex-wrap gap-1">
                              {e.object_ids.map((oid) => {
                                const o = objects.find((x) => x.id === oid)
                                if (!o) return (
                                  <span key={oid} className="text-xs text-gray-400">{oid.slice(0, 8)}</span>
                                )
                                return <ObjectBadge key={oid} object={o} variant="compact" />
                              })}
                              {e.is_project_wide && (
                                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                                  📊 ЗПР
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2 align-top text-xs text-gray-600">
                            {doc ? (
                              <Link href={`/contracts/${doc.id}`} className="text-blue-700 hover:underline line-clamp-2 break-words">
                                {doc.title}
                              </Link>
                            ) : '—'}
                          </td>
                          <td className="px-2 py-2 align-top text-xs">
                            {ss.length === 0 ? (
                              <span className="text-gray-400">—</span>
                            ) : planned === 0 ? (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Факт</span>
                            ) : fact > 0 ? (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{fact}/{ss.length}</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">План</span>
                            )}
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
    </div>
  )
}

// ─── CalendarGrid: визуальная сетка месяца ─────────────────────────────────
function CalendarGrid({
  year, month, entries, objects, statusByEntry,
  onPrev, onNext, onToday,
}: {
  year: number
  month: number  // 0..11
  entries: CalendarEntry[]
  objects: ObjectRef[]
  statusByEntry: Map<string, ObjectStatusRow[]>
  onPrev: () => void
  onNext: () => void
  onToday: () => void
}) {
  const objectMap = useMemo(() => {
    const m = new Map<string, ObjectRef>()
    for (const o of objects) m.set(o.id, o)
    return m
  }, [objects])
  const months = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
  const wdays = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']

  // Первый день месяца + смещение до понедельника (Mon=1, Sun=0 → 7)
  const firstOfMonth = new Date(year, month, 1)
  const firstDow = firstOfMonth.getDay() || 7   // Mon=1..Sun=7
  const lead = firstDow - 1                       // сколько ячеек до 1-го
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7

  const todayISO = new Date().toISOString().slice(0, 10)
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`

  // Группировка вех по ISO-дате
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarEntry[]>()
    for (const e of entries) {
      const d = e.date_computed
      if (!d || !d.startsWith(monthPrefix)) continue
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(e)
    }
    return m
  }, [entries, monthPrefix])

  // Цвет по факт/план
  function badgeFor(e: CalendarEntry): string {
    const ss = statusByEntry.get(e.id) ?? []
    if (ss.length === 0) {
      // Нет junction (не разворачивалась) — считаем планом по дефолту
      return 'bg-gray-100 text-gray-700 border-gray-300'
    }
    const planned = ss.filter((s) => s.is_planned).length
    if (planned === 0) return 'bg-emerald-100 text-emerald-700 border-emerald-300'
    if (planned < ss.length) return 'bg-amber-100 text-amber-700 border-amber-300'
    const cat = CATEGORY[e.entry_type] ?? 'other'
    return CATEGORY_BADGE[cat] || 'bg-gray-100 text-gray-700 border-gray-300'
  }

  return (
    <div className="bg-white rounded shadow">
      {/* Шапка с навигацией */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <button onClick={onPrev} className="px-2 py-1 text-sm border rounded hover:bg-gray-50">‹</button>
          <button onClick={onToday} className="px-3 py-1 text-sm border rounded hover:bg-gray-50">Сегодня</button>
          <button onClick={onNext} className="px-2 py-1 text-sm border rounded hover:bg-gray-50">›</button>
        </div>
        <h2 className="text-lg font-semibold">{months[month]} {year}</h2>
        <div className="text-xs text-gray-500">
          вех в месяце: <b>{[...byDate.values()].reduce((a, x) => a + x.length, 0)}</b>
        </div>
      </div>

      {/* Заголовок дней недели */}
      <div className="grid grid-cols-7 border-b bg-gray-50">
        {wdays.map((w) => (
          <div key={w} className={`px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 text-center ${w === 'Сб' || w === 'Вс' ? 'text-red-500' : ''}`}>
            {w}
          </div>
        ))}
      </div>

      {/* Сетка дней */}
      <div className="grid grid-cols-7 border-l">
        {Array.from({ length: totalCells }).map((_, idx) => {
          const dayNum = idx - lead + 1
          const inMonth = dayNum >= 1 && dayNum <= daysInMonth
          const dayDate = inMonth ? new Date(year, month, dayNum) : null
          const dateISO = dayDate ? dayDate.toISOString().slice(0, 10) : ''
          const isToday = dateISO === todayISO
          const isWeekend = inMonth && dayDate && (dayDate.getDay() === 0 || dayDate.getDay() === 6)
          const items = byDate.get(dateISO) ?? []

          return (
            <div
              key={idx}
              className={`min-h-[110px] border-r border-b p-1 ${
                !inMonth ? 'bg-gray-50/50' : isWeekend ? 'bg-red-50/30' : 'bg-white'
              } ${isToday ? 'ring-2 ring-inset ring-blue-400' : ''}`}
            >
              {inMonth && (
                <>
                  <div className={`text-xs ${isToday ? 'text-blue-700 font-bold' : isWeekend ? 'text-red-500' : 'text-gray-500'} mb-0.5`}>
                    {dayNum}
                  </div>
                  <div className="space-y-0.5">
                    {items.slice(0, 4).map((e) => {
                      const firstObj = e.object_ids[0] ? objectMap.get(e.object_ids[0]) : null
                      const accent = firstObj?.color ?? (e.is_project_wide ? '#475569' : '#cbd5e1')
                      // Расширенный multi-line tooltip
                      const ttParts = [
                        `${ENTRY_TYPE_LABEL[e.entry_type] ?? e.entry_type}`,
                        e.title || '',
                        firstObj ? `Объект: ${optionIconPrefix(firstObj.icon)}${firstObj.code}` : (e.is_project_wide ? '📊 ЗПР' : ''),
                        e.title_original && e.title_original !== e.title ? `Оригинал: ${e.title_original}` : '',
                        e.mspdi_id !== null ? `MS Project ID: ${e.mspdi_id} (UID ${e.mspdi_uid})` : '',
                        e.outline_number ? `WBS: ${e.outline_number}` : '',
                        e.percent_complete !== null && e.percent_complete > 0 ? `Выполнено: ${e.percent_complete}%` : '',
                        e.is_summary ? 'Сводная задача' : '',
                        e.task_mode === 'manual' ? 'Режим: ручной' : '',
                        e.schedule_raw_text ? `Привязка: ${e.schedule_raw_text}` : '',
                        e.mspdi_notes ? `Notes: ${e.mspdi_notes.slice(0, 240)}` : '',
                      ].filter(Boolean)
                      return (
                        <div
                          key={e.id}
                          className={`text-[10px] leading-tight px-1 py-0.5 rounded border truncate ${badgeFor(e)}`}
                          style={{ borderLeft: `3px solid ${accent}` }}
                          title={ttParts.join('\n')}
                        >
                          <span className="mr-0.5">
                            {firstObj?.icon && isImageUrl(firstObj.icon)
                              ? <img src={firstObj.icon} alt="" className="inline-block w-3 h-3 object-contain align-text-bottom" />
                              : (firstObj?.icon ?? ENTRY_TYPE_ICON[e.entry_type] ?? '◆')}
                          </span>
                          <span className="truncate">{e.title ?? e.entry_type}</span>
                          {e.percent_complete !== null && e.percent_complete > 0 && (
                            <span className="ml-1 text-emerald-600 font-medium">{e.percent_complete}%</span>
                          )}
                        </div>
                      )
                    })}
                    {items.length > 4 && (
                      <div className="text-[10px] text-gray-500 px-1">+{items.length - 4}</div>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── FilterRow (копия из /events) ──────────────────────────────────────────
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
