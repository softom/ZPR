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
  object_ids: string[]               // UUID — основная связь (см. WIKI 20_Правило_связей)
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
type ObjectRef = { id: string; code: string; current_name: string }

type ObjectStatusRow = {
  task_id: string
  object_id: string
  status: 'open' | 'in_progress' | 'done' | 'closed' | 'cancelled'
  done_date: string | null
}

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
    const [t, tos, e, o] = await Promise.all([
      supabase.from('tasks').select('*').order('priority').order('due_date', { nullsFirst: false }),
      supabase.from('task_object_status').select('task_id, object_id, status, done_date'),
      supabase.from('legal_entities').select('id, name').order('name'),
      supabase.from('objects').select('id, code, current_name').order('code'),
    ])
    if (t.error) setError(t.error.message)
    setTasks((t.data as Task[]) || [])
    setObjectStatus((tos.data as ObjectStatusRow[]) || [])
    setEntities((e.data as LegalEntity[]) || [])
    setObjects((o.data as ObjectRef[]) || [])
    setLoading(false)
  }

  // Карта (task_id, object_id) → ObjectStatusRow для быстрого чтения per-object статуса
  const objStatusMap = useMemo(() => {
    const m = new Map<string, ObjectStatusRow>()
    for (const r of objectStatus) m.set(`${r.task_id}|${r.object_id}`, r)
    return m
  }, [objectStatus])

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
  async function saveTaskDate(task: Task, field: 'due_date' | 'done_date', value: string) {
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

  // Fast-path: применить статус ко всем объектам задачи + к самой задаче (для legacy без object_ids).
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

    // Преliminary → не задействуем junction (preliminary живёт на уровне tasks.status)
    if (newStatus === 'preliminary') {
      const { error } = await supabase.from('tasks').update({ status: 'preliminary' }).eq('id', task.id)
      if (error) { alert(error.message); return }
      await load()
      return
    }

    // Все объекты задачи получают новый статус через junction
    const rows = task.object_ids.map((oid) => ({
      task_id: task.id,
      object_id: oid,
      status: newStatus,
      done_date: ['done','closed'].includes(newStatus) ? today : null,
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
      if (filterObject && !t.object_ids.includes(filterObject)) return false
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
    const map = new Map<string, Task[]>()
    for (const t of filtered) {
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
            <option key={o.id} value={o.id}>{o.code} — {o.current_name}</option>
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
                            {(t.object_ids ?? []).slice(0, 2).map((oid) => {
                              const o = objects.find((x) => x.id === oid)
                              const label = o?.current_name || oid.slice(0, 8)
                              return (
                                <span
                                  key={oid}
                                  title={o?.code ?? oid}
                                  className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-700 text-xs rounded"
                                >
                                  {label}
                                </span>
                              )
                            })}
                            {(t.object_ids ?? []).length > 2 && (
                              <span className="text-xs text-gray-400">+{(t.object_ids ?? []).length - 2}</span>
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
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Ответственный</h3>
                  <p>
                    {entities.find((e) => e.id === opened.assignee_entity_id)?.name || opened.assignee_org || '—'}
                  </p>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Срок</h3>
                  <input
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
                Источник: <span className="font-mono">{opened.source_protocol || '—'}</span>
                {opened.source_meeting_date && <> · собрание {formatDate(opened.source_meeting_date)}</>}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
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
                <label key={o.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-white px-1 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setDraft((d) => checked ? d.filter((x) => x !== o.id) : [...d, o.id])
                    }}
                  />
                  <span className="font-mono text-gray-500 w-24 shrink-0">{o.code}</span>
                  <span>{o.current_name}</span>
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
              <div key={oid} className="flex items-center gap-2 px-2 py-1 bg-gray-50 rounded text-xs">
                <span className="font-mono text-gray-500 w-24 shrink-0">{o?.code ?? oid.slice(0, 8)}</span>
                <span className="flex-1 truncate text-gray-700">{o?.current_name ?? '—'}</span>
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
