'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Task = {
  id: string
  code: string
  title: string
  explanation: string | null
  status: 'preliminary' | 'open' | 'in_progress' | 'done' | 'closed' | 'cancelled'
  priority: 'high' | 'medium' | 'low' | null
  assignee_org: string | null
  assignee_entity_id: string | null
  object_codes: string[]
  due_date: string | null
  done_date: string | null
  done_note: string | null
  source_protocol: string | null
  source_meeting_date: string | null
  source_meeting_path: string | null
  quotes: { speaker_org?: string; text: string }[]
  created_at: string
  updated_at: string
}

type LegalEntity = { id: string; name: string }
type ObjectRef = { code: string; current_name: string }

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
  const [entities, setEntities] = useState<LegalEntity[]>([])
  const [objects, setObjects] = useState<ObjectRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opened, setOpened] = useState<Task | null>(null)

  // Фильтры
  const [filterStatus, setFilterStatus] = useState<string>('active') // active | preliminary | done | all | <status>
  const [filterEntity, setFilterEntity] = useState<string>('')
  const [filterObject, setFilterObject] = useState<string>('')
  const [filterPriority, setFilterPriority] = useState<string>('')
  const [filterOverdue, setFilterOverdue] = useState<boolean>(false)
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState<'none' | 'entity' | 'object'>('object')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    const [t, e, o] = await Promise.all([
      supabase.from('tasks').select('*').order('priority').order('due_date', { nullsFirst: false }),
      supabase.from('legal_entities').select('id, name').order('name'),
      supabase.from('objects').select('code, current_name').order('code'),
    ])
    if (t.error) setError(t.error.message)
    setTasks((t.data as Task[]) || [])
    setEntities((e.data as LegalEntity[]) || [])
    setObjects((o.data as ObjectRef[]) || [])
    setLoading(false)
  }

  async function changeStatus(task: Task, newStatus: Task['status']) {
    const update: Partial<Task> = { status: newStatus }
    if (newStatus === 'done' && !task.done_date) {
      update.done_date = new Date().toISOString().slice(0, 10)
    }
    const { error: e } = await supabase.from('tasks').update(update).eq('id', task.id)
    if (e) {
      alert(e.message)
      return
    }
    setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, ...update } : x)))
    if (opened?.id === task.id) {
      setOpened({ ...opened, ...update })
    }
  }

  // Фильтрация
  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (filterStatus === 'active' && !['open', 'in_progress'].includes(t.status)) return false
      if (filterStatus === 'preliminary' && t.status !== 'preliminary') return false
      if (filterStatus === 'done' && !['done', 'closed'].includes(t.status)) return false
      if (filterStatus !== 'active' && filterStatus !== 'all'
          && filterStatus !== 'preliminary' && filterStatus !== 'done'
          && filterStatus !== '' && t.status !== filterStatus) return false
      if (filterEntity && t.assignee_entity_id !== filterEntity) return false
      if (filterObject && !t.object_codes.includes(filterObject)) return false
      if (filterPriority && t.priority !== filterPriority) return false
      if (filterOverdue && !isOverdue(t)) return false
      if (search) {
        const q = search.toLowerCase()
        const hay = (t.code + ' ' + t.title + ' ' + (t.explanation || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [tasks, filterStatus, filterEntity, filterObject, filterPriority, filterOverdue, search])

  // Сортировка задач внутри группы:
  // 1. Не выполненные (open/in_progress/preliminary) — впереди
  // 2. Среди не выполненных — самые старые сверху (по created_at ASC)
  // 3. Выполненные — после, новые сверху
  function sortTasks(arr: Task[]): Task[] {
    return [...arr].sort((a, b) => {
      const aActive = ['open', 'in_progress', 'preliminary'].includes(a.status) ? 0 : 1
      const bActive = ['open', 'in_progress', 'preliminary'].includes(b.status) ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      const aDate = new Date(a.created_at).getTime()
      const bDate = new Date(b.created_at).getTime()
      // не выполненные — старые сверху; выполненные — свежие сверху
      return aActive === 0 ? aDate - bDate : bDate - aDate
    })
  }

  // Статистика по группе
  function groupStats(items: Task[]) {
    return {
      total: items.length,
      done: items.filter((t) => t.status === 'done' || t.status === 'closed').length,
      open: items.filter((t) => t.status === 'open' || t.status === 'in_progress').length,
      preliminary: items.filter((t) => t.status === 'preliminary').length,
      overdue: items.filter(isOverdue).length,
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
        if (t.object_codes.length === 0) {
          if (!map.has('none')) map.set('none', [])
          map.get('none')!.push(t)
        } else {
          for (const oc of t.object_codes) {
            if (!map.has(oc)) map.set(oc, [])
            map.get(oc)!.push(t)
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
    const map = new Map<string, Task[]>()
    for (const t of filtered) {
      if (t.object_codes.length === 0) {
        if (!map.has('none')) map.set('none', [])
        map.get('none')!.push(t)
      } else {
        for (const oc of t.object_codes) {
          if (!map.has(oc)) map.set(oc, [])
          map.get(oc)!.push(t)
        }
      }
    }
    return [...map.entries()].map(([key, items]) => {
      const o = objects.find((x) => x.code === key)
      const label = o?.current_name
        ? `${o.code} — ${o.current_name}`
        : (key === 'none' ? 'Без объекта' : key)
      return { key, label, items: sortTasks(items) }
    }).sort((a, b) => a.key.localeCompare(b.key))
  }, [filtered, groupBy, entities, objects])

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
            href="/tasks/stats"
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
            <option key={o.code} value={o.code}>{o.code} — {o.current_name}</option>
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
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as 'none' | 'entity' | 'object')}
          className="px-2 py-1.5 border rounded text-sm"
        >
          <option value="entity">Группировать: по юр.лицу</option>
          <option value="object">Группировать: по объекту</option>
          <option value="none">Без группировки</option>
        </select>
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
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded shadow p-6 text-center text-gray-400">
          Нет задач по выбранным фильтрам
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => {
            // Статистика — по ВСЕМ задачам группы (не по filtered)
            const allItems = allByGroup.get(g.key) || g.items
            const gs = groupStats(allItems)
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
                      <th className="px-3 py-2">Задача</th>
                      <th className="px-3 py-2 w-32">Объекты</th>
                      <th className="px-3 py-2 w-24">Приоритет</th>
                      <th className="px-3 py-2 w-24">Срок</th>
                      <th className="px-3 py-2 w-28">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b hover:bg-gray-50 cursor-pointer"
                        onClick={() => setOpened(t)}
                      >
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{t.code}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-900 line-clamp-1">{t.title}</div>
                          {t.explanation && (
                            <div className="text-xs text-gray-500 line-clamp-1 mt-0.5">
                              {t.explanation}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {t.object_codes.slice(0, 2).map((oc) => {
                              const o = objects.find((x) => x.code === oc)
                              const label = o?.current_name || oc
                              return (
                                <span
                                  key={oc}
                                  title={oc}
                                  className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-700 text-xs rounded"
                                >
                                  {label}
                                </span>
                              )
                            })}
                            {t.object_codes.length > 2 && (
                              <span className="text-xs text-gray-400">+{t.object_codes.length - 2}</span>
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
                        <td className={`px-3 py-2 text-xs ${isOverdue(t) ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                          {formatDate(t.due_date)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              STATUS_BADGE[t.status]
                            }`}
                          >
                            {STATUS_LABELS[t.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
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
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Статус</h3>
                  <select
                    value={opened.status}
                    onChange={(e) => changeStatus(opened, e.target.value as Task['status'])}
                    className="w-full px-2 py-1 border rounded"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Приоритет</h3>
                  <p>{opened.priority ? PRIORITY_LABEL[opened.priority] : '—'}</p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Ответственный</h3>
                  <p>
                    {entities.find((e) => e.id === opened.assignee_entity_id)?.name || opened.assignee_org || '—'}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Срок</h3>
                  <p className={isOverdue(opened) ? 'text-red-600 font-semibold' : ''}>
                    {formatDate(opened.due_date)}
                  </p>
                </div>
                <div className="col-span-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Объекты</h3>
                  <div className="flex flex-wrap gap-1">
                    {opened.object_codes.map((oc) => {
                      const o = objects.find((x) => x.code === oc)
                      return (
                        <span key={oc} className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded">
                          {oc}{o ? ` — ${o.current_name}` : ''}
                        </span>
                      )
                    })}
                    {opened.object_codes.length === 0 && <span className="text-gray-400">—</span>}
                  </div>
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

              <section className="text-xs text-gray-500 pt-3 border-t">
                Источник: <span className="font-mono">{opened.source_protocol || '—'}</span>
                {opened.source_meeting_date && <> · собрание {formatDate(opened.source_meeting_date)}</>}
                {opened.done_date && <> · выполнено {formatDate(opened.done_date)}</>}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
