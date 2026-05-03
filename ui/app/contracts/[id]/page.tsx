'use client'

/**
 * /contracts/[id] — карточка договора + редактор пунктов (модуль B).
 *
 * Содержит:
 *   - Заголовок: title, customer/contractor, objects, folder_path.
 *   - Стадия проекта (селект → PATCH).
 *   - Таблица пунктов: inline-правка, ↑/↓ для reorder, добавление, удаление.
 *   - Колонка «Связанные события» — события, порождённые из пункта (через clause_events). Этап 3.
 *   - Кнопка «архивировать» (soft delete с погашением событий).
 */

import { useEffect, useState, useCallback, useMemo, type CSSProperties } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { TermBase } from '@/lib/parser/extractClauses'
import { computeAllClauseDates, type ClauseDateResult } from '@/lib/contracts/computeClauseDates'
import {
  DndContext, type DragEndEvent, closestCenter,
  PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove,
  verticalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

type ClauseCategory = 'fin' | 'work' | 'appr' | 'legal'

const CATEGORY_OPTIONS: { value: ClauseCategory; label: string; short: string; badge: string }[] = [
  { value: 'fin',   short: 'ФИН',  label: 'Финансовый',       badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { value: 'work',  short: 'РАБ',  label: 'Производственный', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'appr',  short: 'СОГЛ', label: 'Согласование',     badge: 'bg-violet-100 text-violet-700 border-violet-200' },
  { value: 'legal', short: 'ЮР',   label: 'Юридический',      badge: 'bg-amber-100 text-amber-700 border-amber-200' },
]
const CATEGORY_BADGE_CLASS: Record<ClauseCategory, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map(o => [o.value, o.badge])
) as Record<ClauseCategory, string>
const CATEGORY_SHORT: Record<ClauseCategory, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map(o => [o.value, o.short])
) as Record<ClauseCategory, string>

interface LegalEntity {
  id: string
  name: string
  inn: string
  kpp: string | null
  address_legal: string | null
  signatory_name: string | null
  signatory_position: string | null
}

interface Clause {
  id: string
  document_id: string
  order_index: number
  clause_date: string | null
  description: string
  note: string | null
  source_page: number | null
  source_quote: string | null
  term_days: number | null
  term_type: 'working' | 'calendar' | null
  term_base: TermBase | null
  term_text: string | null
  term_ref_clause_id: string | null
  is_anchor: boolean
  date_mode: 'date' | 'term' | null
  category: ClauseCategory | null
}

interface ProjectStage {
  code: string
  label: string
  sort_order: number
}

interface RelatedEvent {
  id: string
  title: string | null
  event_type: string
  date_end: string | null
  date_computed: string | null
  fact_date: string | null
}

interface EventSubtypeRef {
  code: string
  category: string  // 'fin' | 'work' | 'appr' | 'exec' | 'system'
  label: string
  icon: string
}

// Цвет бейджа события по категории event_subtypes
// (события используют 5 категорий: fin/work/appr/exec/system; пункты — 4: fin/work/appr/legal)
const EVENT_CATEGORY_BADGE: Record<string, string> = {
  fin:    'bg-emerald-100 text-emerald-800 border-emerald-200',
  work:   'bg-blue-100 text-blue-800 border-blue-200',
  appr:   'bg-violet-100 text-violet-800 border-violet-200',
  exec:   'bg-amber-100 text-amber-800 border-amber-200',
  system: 'bg-gray-100 text-gray-700 border-gray-200',
}

interface ContractDetail {
  id: string
  title: string
  version: string | null
  folder_path: string | null
  indexed_at: string | null
  signed_date: string | null
  project_stage: string | null
  stage: { code: string; label: string; sort_order: number } | null
  customer: LegalEntity | null
  contractor: LegalEntity | null
  objects: { object_code: string }[]
  clauses: Clause[]
  parties_snapshot?: unknown
}

export default function ContractDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id

  const [doc, setDoc] = useState<ContractDetail | null>(null)
  const [allStages, setAllStages] = useState<ProjectStage[]>([])
  const [eventsByClause, setEventsByClause] = useState<Record<string, RelatedEvent[]>>({})
  const [eventSubtypes, setEventSubtypes] = useState<Record<string, EventSubtypeRef>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [savingClause, setSavingClause] = useState<string | null>(null)
  const [reparsing, setReparsing] = useState(false)

  // Загружаем справочники один раз
  useEffect(() => {
    supabase
      .from('project_stages')
      .select('code,label,sort_order')
      .order('sort_order', { ascending: true })
      .then(({ data }) => setAllStages((data as unknown as ProjectStage[]) ?? []))
    supabase
      .from('event_subtypes')
      .select('code,category,label,icon')
      .then(({ data }) => {
        const map: Record<string, EventSubtypeRef> = {}
        for (const s of (data ?? []) as EventSubtypeRef[]) map[s.code] = s
        setEventSubtypes(map)
      })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/v2/${id}`)
      if (!res.ok) {
        const { error } = await res.json()
        throw new Error(error)
      }
      const data: ContractDetail = await res.json()
      setDoc(data)

      // Загружаем связанные события для всех пунктов одним запросом
      const clauseIds = (data.clauses ?? []).map(c => c.id)
      if (clauseIds.length > 0) {
        const { data: links } = await supabase
          .from('clause_events')
          .select('clause_id, events(id, title, event_type, date_end, date_computed, fact_date)')
          .in('clause_id', clauseIds)
        const map: Record<string, RelatedEvent[]> = {}
        type Row = { clause_id: string; events: RelatedEvent | null }
        for (const row of (links ?? []) as unknown as Row[]) {
          if (!row.events) continue
          if (!map[row.clause_id]) map[row.clause_id] = []
          map[row.clause_id].push(row.events)
        }
        setEventsByClause(map)
      } else {
        setEventsByClause({})
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // Расчёт абсолютных дат для всех пунктов в режиме 'term'
  const computedDates = useMemo(
    () => doc
      ? computeAllClauseDates(doc.clauses, { signedDate: doc.signed_date })
      : new Map<string, ClauseDateResult>(),
    [doc],
  )

  // ─── Document-level patches ──────────────────────────────────────────────

  async function patchDocument(fields: Record<string, unknown>) {
    try {
      const res = await fetch(`/api/contracts/v2/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ─── Clauses CRUD ─────────────────────────────────────────────────────────

  /**
   * Оптимистичный PATCH одного пункта — без перезагрузки всей страницы.
   * Использует обновлённый row из ответа сервера.
   * На ошибке откатываемся через полный load().
   */
  async function patchClause(cid: string, fields: Partial<Clause>) {
    setSavingClause(cid)
    try {
      const res = await fetch(`/api/contracts/v2/${id}/clauses/${cid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      const updated = await res.json() as Clause
      setDoc(prev => prev ? {
        ...prev,
        clauses: prev.clauses.map(c => c.id === cid ? { ...c, ...updated } : c),
      } : prev)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      await load() // откат к серверному состоянию
    } finally {
      setSavingClause(null)
    }
  }

  /**
   * Оптимистичное добавление пункта: используем row из ответа POST.
   */
  async function addClause() {
    try {
      const res = await fetch(`/api/contracts/v2/${id}/clauses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Новый пункт' }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      const created = await res.json() as Clause
      setDoc(prev => prev ? {
        ...prev,
        clauses: [...prev.clauses, created],
      } : prev)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      await load()
    }
  }

  /**
   * Оптимистичное удаление: убираем из state и зачищаем eventsByClause.
   */
  async function deleteClause(cid: string) {
    if (!confirm('Удалить пункт?')) return
    try {
      const res = await fetch(`/api/contracts/v2/${id}/clauses/${cid}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error)
      setDoc(prev => prev ? {
        ...prev,
        clauses: prev.clauses.filter(c => c.id !== cid),
      } : prev)
      setEventsByClause(prev => {
        const next = { ...prev }
        delete next[cid]
        return next
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      await load()
    }
  }

  /**
   * Повторный разбор пунктов через LLM.
   * 1. POST /reparse → получает новый список clauses от LLM (без записи). Долго (~30–60 сек).
   * 2. confirm с количеством → если ОК → POST /clauses/replace (DELETE+INSERT).
   * 3. load() для обновления.
   *
   * Во время длинного запроса:
   *   - кнопка disabled + текст «Анализ…»
   *   - синий info-баннер «Запущен повторный разбор LLM…»
   */
  async function reparse() {
    if (!confirm('Запустить повторный разбор пунктов через LLM?\n\nТекущие пункты будут заменены результатом анализа.\nЗапрос занимает 30–60 секунд.')) return

    setReparsing(true)
    setError(null)
    setInfo('🔄 Запущен повторный разбор договора через LLM. Обычно занимает 30–60 секунд, не закрывайте страницу…')

    try {
      const res = await fetch(`/api/contracts/v2/${id}/reparse`, { method: 'POST' })
      if (!res.ok) {
        const { error } = await res.json()
        setError(error)
        setInfo(null)
        return
      }
      const { clauses: fresh } = await res.json() as { clauses: unknown[] }
      setInfo(null)

      const currentCount = doc?.clauses.length ?? 0
      if (!confirm(`LLM нашёл пунктов: ${fresh.length}. Заменить ${currentCount} существующих?`)) return

      setInfo('💾 Сохраняем результат…')
      const replaceRes = await fetch(`/api/contracts/v2/${id}/clauses/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clauses: fresh }),
      })
      if (!replaceRes.ok) throw new Error((await replaceRes.json()).error)
      await load()
      setInfo(`✅ Заменено пунктов: ${fresh.length}`)
      setTimeout(() => setInfo(null), 3000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setInfo(null)
    } finally {
      setReparsing(false)
    }
  }

  // ─── Drag&drop sensors + handler ─────────────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !doc) return
    const oldIdx = doc.clauses.findIndex(c => c.id === active.id)
    const newIdx = doc.clauses.findIndex(c => c.id === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    // Якорь нельзя двигать — пропускаем drag, если активен или цель — anchor
    if (doc.clauses[oldIdx].is_anchor || doc.clauses[newIdx].is_anchor) return
    const reordered = arrayMove(doc.clauses, oldIdx, newIdx).map((c, i) => ({ ...c, order_index: i + 1 }))
    // Оптимистично обновим UI до ответа сервера
    setDoc({ ...doc, clauses: reordered })
    const items = reordered.map(c => ({ id: c.id, order_index: c.order_index }))
    try {
      const res = await fetch(`/api/contracts/v2/${id}/clauses/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      await load() // откатываем визуально к серверному состоянию
    }
  }

  async function archive() {
    if (!confirm('Архивировать договор?\n\nДокумент скроется из списка. Связанные события будут погашены (удалены).')) return
    const res = await fetch(`/api/contracts/v2/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const { error } = await res.json()
      setError(error)
      return
    }
    router.push('/contracts')
  }

  if (loading) return <div className="p-6">Загрузка...</div>
  if (!doc)    return <div className="p-6">Не найдено</div>

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-4 mb-4">
        <button onClick={() => router.push('/contracts')} className="text-blue-600">← Назад</button>
        <h1 className="text-2xl font-bold flex-1">{doc.title}</h1>
        <button onClick={archive} className="px-3 py-1 text-sm border border-red-300 text-red-600 rounded hover:bg-red-50">
          Архивировать
        </button>
      </div>

      {/* Информационные баннеры */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-300 text-red-800 rounded flex justify-between items-start gap-2">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} className="text-red-600 hover:text-red-900 text-lg leading-none">×</button>
        </div>
      )}
      {info && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-300 text-blue-800 rounded flex items-center gap-2">
          {reparsing && (
            <span className="inline-block w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
          )}
          <span>{info}</span>
        </div>
      )}

      {/* Метаданные договора: дата подписания + стадия */}
      <div className="mb-4 flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-gray-500">Дата подписания:</span>
          <input
            type="date"
            value={doc.signed_date ?? ''}
            onChange={e => patchDocument({ signed_date: e.target.value || null })}
            className="px-2 py-1 border rounded text-sm bg-white"
            title="Используется для якорного пункта и расчёта term_base=contract"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-gray-500">Стадия проекта:</span>
          <select
            value={doc.project_stage ?? ''}
            onChange={e => patchDocument({ project_stage: e.target.value || null })}
            className="px-2 py-1 border rounded text-sm bg-white"
          >
            <option value="">— не определена —</option>
            {allStages.map(s => (
              <option key={s.code} value={s.code}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Карточка договора */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500 mb-1">Заказчик</div>
          <div className="font-medium">{doc.customer?.name ?? '—'}</div>
          <div className="text-xs text-gray-600">ИНН {doc.customer?.inn ?? '—'}{doc.customer?.kpp ? ` / КПП ${doc.customer.kpp}` : ''}</div>
          {doc.customer?.signatory_name && (
            <div className="text-xs text-gray-600 mt-1">{doc.customer.signatory_name} ({doc.customer.signatory_position})</div>
          )}
        </div>
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500 mb-1">Подрядчик</div>
          <div className="font-medium">{doc.contractor?.name ?? '—'}</div>
          <div className="text-xs text-gray-600">ИНН {doc.contractor?.inn ?? '—'}{doc.contractor?.kpp ? ` / КПП ${doc.contractor.kpp}` : ''}</div>
          {doc.contractor?.signatory_name && (
            <div className="text-xs text-gray-600 mt-1">{doc.contractor.signatory_name} ({doc.contractor.signatory_position})</div>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Объекты:</span>
        {doc.objects.length === 0 ? (
          <span className="text-xs text-gray-400">—</span>
        ) : (
          doc.objects.map(o => (
            <span key={o.object_code} className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">{o.object_code}</span>
          ))
        )}
        {doc.folder_path && (
          <span className="ml-auto text-xs text-gray-500">📁 {doc.folder_path}</span>
        )}
      </div>

      {/* Таблица пунктов */}
      <div className="border rounded">
        <div className="flex items-center justify-between p-3 border-b bg-gray-50">
          <div className="font-semibold">Пункты договора <span className="text-gray-500 text-sm">({doc.clauses.length})</span></div>
          <div className="flex gap-2">
            <button
              onClick={reparse}
              disabled={reparsing}
              className="px-3 py-1 text-sm border border-blue-300 text-blue-600 rounded hover:bg-blue-50 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
              title="Повторный разбор пунктов через LLM (30–60 сек)"
            >
              {reparsing && (
                <span className="inline-block w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
              )}
              {reparsing ? 'Анализ…' : '🔄 Переразобрать'}
            </button>
            <button onClick={addClause} disabled={reparsing} className="px-3 py-1 text-sm bg-blue-600 text-white rounded disabled:opacity-50">+ Пункт</button>
          </div>
        </div>
        {doc.clauses.length === 0 ? (
          <div className="p-6 text-center text-gray-500">Нет пунктов. Нажмите «+ Пункт» чтобы добавить.</div>
        ) : (<>
          {/* Legend: цветовая схема режимов */}
          <div className="text-xs text-gray-500 mb-2 px-3 pt-2 flex flex-wrap gap-4 items-center">
            <span className="font-semibold text-gray-600">Режим пункта:</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border-2 border-green-500 bg-white"></span>
              <span>определяющая (введено вручную)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-gray-300 bg-gray-50"></span>
              <span className="italic">расчётная (вычислено из формулы)</span>
            </span>
            <span className="ml-auto text-gray-400 text-[11px]">↻ — переключить режим</span>
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={doc.clauses.map(c => c.id)} strategy={verticalListSortingStrategy}>
              <div>
                {doc.clauses.map((c) => (
                  <ClauseRow
                    key={c.id}
                    clause={c}
                    allClauses={doc.clauses}
                    events={eventsByClause[c.id] ?? []}
                    eventSubtypes={eventSubtypes}
                    computed={computedDates.get(c.id) ?? null}
                    onPatch={fields => patchClause(c.id, fields)}
                    onDelete={() => deleteClause(c.id)}
                    saving={savingClause === c.id}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>)}
      </div>
    </div>
  )
}

// ─── ClauseRow — inline-редактируемая строка ───────────────────────────────

function ClauseRow({
  clause, allClauses, events, eventSubtypes, computed, onPatch, onDelete, saving,
}: {
  clause: Clause
  allClauses: Clause[]
  events: RelatedEvent[]
  eventSubtypes: Record<string, EventSubtypeRef>
  computed: ClauseDateResult | null
  onPatch: (fields: Partial<Clause>) => void
  onDelete: () => void
  saving: boolean
}) {
  const router = useRouter()
  const [local, setLocal] = useState(clause)
  useEffect(() => { setLocal(clause) }, [clause])

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: clause.id, disabled: clause.is_anchor })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    background: isDragging ? '#eff6ff' : (clause.is_anchor ? '#f0fdf4' : undefined),
  }

  // Эффективный режим: явный date_mode из БД или вывод по содержимому.
  const mode: 'date' | 'term' | null = local.date_mode
    ?? ((local.term_days != null && local.term_base) ? 'term'
       : local.clause_date ? 'date'
       : null)
  const isDateMode = mode === 'date'
  const isTermMode = mode === 'term'

  // Расчётная дата для отображения в поле даты при mode='term'
  const computedDate = computed?.date ?? ''
  const computedReason = computed?.reason ?? null

  // Стили: зелёная рамка вокруг определяющего блока, серая italic у расчётного.
  const dateBoxClass = isDateMode
    ? 'border-2 border-green-500 bg-white'
    : isTermMode
      ? 'border border-gray-300 bg-gray-50 italic text-gray-500'
      : 'border border-gray-300'
  const termFieldClass = isTermMode
    ? 'border-2 border-green-500 bg-white'
    : isDateMode
      ? 'border border-gray-300 bg-gray-50 italic text-gray-400'
      : 'border border-gray-300'

  // Что показывать в поле даты
  const dateDisplayValue = isTermMode
    ? computedDate                       // расчётное значение (или пусто)
    : (local.clause_date ?? '')          // оператор правит
  const dateReadOnly = isTermMode || saving
  const dateTitle = isDateMode
    ? 'Определяющая дата (введена вручную). Источник истины пункта.'
    : isTermMode
      ? (computedDate
          ? `Расчётная: ${computedDate} (вычислена из формулы срока)`
          : `Дата не вычислена. ${computedReason ?? ''}`)
      : 'Введите дату или заполните формулу срока'

  // Поля term — readonly в режиме date
  const termReadOnly = isDateMode || saving
  const termTitleSuffix = isDateMode
    ? ' (определяющая — дата; формула как справка)'
    : ''

  function commit(field: keyof Clause) {
    const before = clause[field] as unknown
    const after  = local[field] as unknown
    if (before !== after) onPatch({ [field]: after } as Partial<Clause>)
  }

  /**
   * Toggle режима. Не показывается у якоря.
   *  date → term: переходим на формулу. clause_date оставляем (как справку).
   *  term → date: фиксируем расчётную как абсолютную (date_mode='date' + clause_date=computed).
   *  null: первый ввод определит режим автоматически (см. *AutoMode ниже).
   */
  function toggleMode() {
    if (clause.is_anchor) return
    if (isDateMode) {
      onPatch({ date_mode: 'term' })
    } else if (isTermMode) {
      const fixed = computedDate || local.clause_date || null
      setLocal({ ...local, date_mode: 'date', clause_date: fixed })
      onPatch({ date_mode: 'date', clause_date: fixed })
    }
  }

  // При empty mode — первый ввод определяет режим
  function commitDateAutoMode() {
    const after = local.clause_date
    const before = clause.clause_date
    if (after === before) return
    if (mode === null && after) {
      setLocal({ ...local, date_mode: 'date' })
      onPatch({ clause_date: after, date_mode: 'date' })
    } else {
      onPatch({ clause_date: after })
    }
  }

  function commitTermFieldAutoMode<F extends 'term_days' | 'term_type' | 'term_base'>(
    field: F,
    value: Clause[F],
  ) {
    const next = { ...local, [field]: value } as Clause
    setLocal(next)
    const becomingTermMode = mode === null && (next.term_days != null || next.term_base)
    if (becomingTermMode) {
      onPatch({ [field]: value, date_mode: 'term' } as Partial<Clause>)
    } else {
      onPatch({ [field]: value } as Partial<Clause>)
    }
  }

  /**
   * Обработчик select «база» — поддерживает два формата value:
   *   обычная база ('contract', 'advance', ...) → term_base=value, term_ref_clause_id=null
   *   'clause:UUID' → term_base='clause', term_ref_clause_id=UUID
   */
  function handleBaseChange(rawValue: string) {
    const newRef: string | null = rawValue || null
    const newBase: TermBase | null = newRef ? 'clause' : null

    const becomingTermMode = mode === null && newBase
    const patch: Partial<Clause> = {
      term_base: newBase,
      term_ref_clause_id: newRef,
    }
    if (becomingTermMode) patch.date_mode = 'term'

    setLocal({ ...local, ...patch })
    onPatch(patch)
  }

  // Текущее value select'а — UUID пункта-источника (или '' если нет)
  const baseSelectValue = local.term_ref_clause_id ?? ''

  // Список других пунктов (не себя) — отсортирован по order_index, как в UI
  const otherClauses = allClauses
    .filter(c => c.id !== clause.id)
    .sort((a, b) => a.order_index - b.order_index)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`border-b px-3 py-3 ${saving ? 'opacity-60' : ''} ${clause.is_anchor ? 'bg-green-50' : 'hover:bg-gray-50'}`}
    >
      {/* Строка 1: # + БОЛЬШОЕ название пункта на всю ширину + удалить */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-1 flex-shrink-0 text-gray-500" style={{ width: 48 }}>
          {clause.is_anchor ? (
            <span title="Якорный пункт" className="text-green-600 px-1 select-none">📌</span>
          ) : (
            <button
              {...attributes}
              {...listeners}
              type="button"
              title="Перетащить"
              aria-label="Перетащить"
              className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-700 px-1 select-none touch-none"
            >⋮⋮</button>
          )}
          <span className="text-xs font-medium">{clause.order_index}</span>
        </div>
        <input
          type="text"
          value={local.description ?? ''}
          onChange={e => setLocal({ ...local, description: e.target.value })}
          onBlur={() => commit('description')}
          className="flex-1 px-2 py-1.5 border rounded font-semibold text-gray-900 text-[15px]"
          placeholder="Описание пункта..."
        />
        {clause.is_anchor ? (
          <span title="Якорный пункт нельзя удалить" className="text-gray-300 px-1 flex-shrink-0">🔒</span>
        ) : (
          <button
            onClick={onDelete}
            className="px-1 text-red-500 hover:text-red-700 flex-shrink-0"
            title="Удалить пункт"
          >✕</button>
        )}
      </div>

      {/* Строка 2: режим + дата/срок + примечание/цитата + стр. + события */}
      <div className="flex items-start gap-2" style={{ paddingLeft: 56 }}>
        {/* Режим: тумблер */}
        <div className="flex flex-col border rounded overflow-hidden text-[11px] w-20 flex-shrink-0">
          <button
            type="button"
            onClick={() => { if (!isDateMode && !clause.is_anchor) toggleMode() }}
            disabled={clause.is_anchor && !isDateMode}
            className={`px-1.5 py-1 ${isDateMode
              ? 'bg-green-100 text-green-700 font-semibold'
              : 'bg-white text-gray-400 hover:bg-gray-50'}`}
            title={isDateMode ? 'Активен: фиксированная дата' : 'Переключить на режим «дата»'}
          >📅 Дата</button>
          <button
            type="button"
            onClick={() => { if (!isTermMode && !clause.is_anchor) toggleMode() }}
            disabled={clause.is_anchor}
            className={`px-1.5 py-1 border-t ${isTermMode
              ? 'bg-green-100 text-green-700 font-semibold'
              : 'bg-white text-gray-400 hover:bg-gray-50'} ${clause.is_anchor ? 'opacity-30 cursor-not-allowed' : ''}`}
            title={clause.is_anchor
              ? 'Якорь — режим зафиксирован'
              : isTermMode ? 'Активен: формула срока' : 'Переключить на режим «срок»'}
          >⏱ Срок</button>
        </div>

        {/* Дата + формула срока + категория */}
        <div className="w-56 flex-shrink-0 space-y-1">
          <input
            type="date"
            value={dateDisplayValue}
            readOnly={dateReadOnly}
            onChange={e => setLocal({ ...local, clause_date: e.target.value || null })}
            onBlur={commitDateAutoMode}
            className={`px-1 py-0.5 rounded text-xs w-full ${dateBoxClass}`}
            title={dateTitle}
          />
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              placeholder="N"
              value={local.term_days ?? ''}
              readOnly={termReadOnly}
              onChange={e => setLocal({ ...local, term_days: e.target.value ? parseInt(e.target.value) : null })}
              onBlur={() => commitTermFieldAutoMode('term_days', local.term_days)}
              className={`w-12 px-1 py-0.5 rounded text-xs ${termFieldClass}`}
              title={`Количество дней${termTitleSuffix}`}
            />
            <select
              value={local.term_type ?? ''}
              disabled={termReadOnly}
              onChange={e => commitTermFieldAutoMode('term_type', (e.target.value || null) as 'working' | 'calendar' | null)}
              className={`px-0.5 py-0.5 rounded text-xs ${termFieldClass}`}
              title={`Тип дней${termTitleSuffix}`}
            >
              <option value="">—</option>
              <option value="working">раб.</option>
              <option value="calendar">кал.</option>
            </select>
            <select
              value={baseSelectValue}
              disabled={termReadOnly}
              onChange={e => handleBaseChange(e.target.value)}
              className={`flex-1 px-0.5 py-0.5 rounded text-xs min-w-0 ${termFieldClass}`}
              title={`От пункта-источника${termTitleSuffix}`}
            >
              <option value="">— от пункта… —</option>
              {otherClauses.map(oc => {
                const desc = (oc.description ?? '').slice(0, 40)
                const truncated = (oc.description ?? '').length > 40 ? '…' : ''
                const anchorMark = oc.is_anchor ? '📌 ' : ''
                return (
                  <option key={oc.id} value={oc.id}>
                    {anchorMark}п.{oc.order_index} — {desc}{truncated}
                  </option>
                )
              })}
            </select>
          </div>
          {isTermMode && computedReason && !computedDate && (
            <div className="text-[10px] text-amber-600 italic">{computedReason}</div>
          )}
          <select
            value={local.category ?? ''}
            onChange={e => {
              const v = (e.target.value || null) as ClauseCategory | null
              setLocal({ ...local, category: v })
              if (v !== clause.category) onPatch({ category: v })
            }}
            className={`w-full text-[11px] px-1.5 py-1 border rounded font-semibold uppercase tracking-wide ${
              local.category ? CATEGORY_BADGE_CLASS[local.category] : 'bg-gray-50 text-gray-400 border-gray-200'
            }`}
            title="Категория пункта"
          >
            <option value="">— тип —</option>
            {CATEGORY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.short} · {o.label}</option>
            ))}
          </select>
        </div>

        {/* Источник из договора (read-only) + примечание + цитата формулы — на оставшуюся ширину */}
        <div className="flex-1 min-w-0 space-y-1">
          {/* Источник: цитата + страница, единый read-only блок */}
          <div
            className="w-full px-1.5 py-1 border-l-4 border-blue-300 border-y border-r rounded text-xs flex items-center gap-2 bg-blue-50/30"
            title="Источник пункта — точная цитата из текста договора (read-only)"
          >
            <span className="flex-shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-medium tabular-nums">
              стр. {local.source_page ?? '—'}
            </span>
            <span className={`flex-1 italic truncate ${local.source_quote ? 'text-blue-900' : 'text-gray-400 not-italic'}`}>
              {local.source_quote || '— цитата из договора отсутствует —'}
            </span>
          </div>
          <input
            type="text"
            value={local.note ?? ''}
            onChange={e => setLocal({ ...local, note: e.target.value || null })}
            onBlur={() => commit('note')}
            className="w-full px-1.5 py-1 border rounded text-xs text-gray-600"
            placeholder="Примечание (опционально)..."
          />
          <input
            type="text"
            value={local.term_text ?? ''}
            onChange={e => setLocal({ ...local, term_text: e.target.value || null })}
            onBlur={() => commit('term_text')}
            className="w-full px-1.5 py-1 border rounded text-xs italic text-gray-500"
            placeholder="Цитата формулы срока (если есть): «15 рабочих дней с даты подписания»"
          />
        </div>

        {/* События */}
        <div className="w-44 flex-shrink-0">
          <label className="text-[10px] text-gray-400 block mb-0.5">События</label>
          {events.length === 0 ? (
            <span className="text-xs text-gray-300">—</span>
          ) : (
            <div className="flex flex-col gap-1">
              {events.map(ev => {
                const st = eventSubtypes[ev.event_type]
                const cat = st?.category ?? 'system'
                const badgeClass = EVENT_CATEGORY_BADGE[cat] ?? EVENT_CATEGORY_BADGE.system
                const icon = st?.icon ?? '📋'
                return (
                  <button
                    key={ev.id}
                    onClick={() => router.push('/events')}
                    title={`${st?.label ?? ev.event_type}${ev.fact_date ? ` (факт ${ev.fact_date})` : ''}`}
                    className={`text-left px-1.5 py-0.5 rounded text-xs border hover:opacity-80 truncate inline-flex items-center gap-1 ${badgeClass}`}
                  >
                    <span className="flex-shrink-0">{icon}</span>
                    <span className="truncate">{ev.title || ev.event_type}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
