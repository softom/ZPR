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
import ContractClausesGantt, {
  type GanttClause as GClause,
  type GanttContractStage as GStage,
  type GanttEventType as GType,
} from '@/components/ContractClausesGantt'

// 7 категорий (с 2026-05-18): fin/work/term/legal/appr/comm/ctrl.
// Источник правды — таблица `contract_event_types`; категория в clauses — denorm.
type ClauseCategory = 'fin' | 'work' | 'term' | 'legal' | 'appr' | 'comm' | 'ctrl'

const CATEGORY_OPTIONS: { value: ClauseCategory; label: string; short: string; badge: string }[] = [
  { value: 'fin',   short: 'ФИН',  label: 'Финансовый',       badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { value: 'work',  short: 'РАБ',  label: 'Производственный', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'term',  short: 'СРОК', label: 'Сроковый',         badge: 'bg-orange-100 text-orange-700 border-orange-200' },
  { value: 'legal', short: 'ЮР',   label: 'Юридический',      badge: 'bg-amber-100 text-amber-700 border-amber-200' },
  { value: 'appr',  short: 'СОГЛ', label: 'Согласование',     badge: 'bg-violet-100 text-violet-700 border-violet-200' },
  { value: 'comm',  short: 'КОММ', label: 'Коммуникационный', badge: 'bg-sky-100 text-sky-700 border-sky-200' },
  { value: 'ctrl',  short: 'КОНТ', label: 'Контрольный',      badge: 'bg-rose-100 text-rose-700 border-rose-200' },
]
const CATEGORY_BADGE_CLASS: Record<ClauseCategory, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map(o => [o.value, o.badge])
) as Record<ClauseCategory, string>
const CATEGORY_SHORT: Record<ClauseCategory, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map(o => [o.value, o.short])
) as Record<ClauseCategory, string>

interface ContractEventType {
  id: string                                  // UUID — для FK
  code: string                                // 'fin_advance' и т.п. — для seed/LLM
  category: ClauseCategory
  label: string                               // «Аванс»
  icon: string | null
  sort_order: number
  is_intermediate: boolean
  is_anchor: boolean
  is_active: boolean
}

type DateSource = 'contract' | 'edited' | 'computed'
const DATE_SOURCE_META: Record<DateSource, { icon: string; label: string; badge: string }> = {
  contract: { icon: '📋', label: 'договорная',  badge: 'bg-gray-100 text-gray-700 border-gray-200' },
  edited:   { icon: '✏️', label: 'изменённая',  badge: 'bg-amber-100 text-amber-700 border-amber-300' },
  computed: { icon: '🧮', label: 'расчётная',   badge: 'bg-blue-100 text-blue-700 border-blue-200' },
}

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
  // ─── С 2026-05-14 (этапы) ─────────────────────────────────────
  stage_id: string | null               // FK → contract_stages.id
  // ─── С 2026-05-18 (классификатор + статус даты) ───────────────
  event_type_id: string | null          // FK → contract_event_types.id
  date_source: DateSource               // 'contract' | 'edited' | 'computed'
  date_change_event_id: string | null   // FK → events.id (причина смены даты)
}

interface ProjectStage {
  code: string
  label: string
  sort_order: number
}

interface ContractStage {
  id: string
  document_id: string
  stage_number: number
  stage_name: string
  description: string | null
  sort_order: number
  is_default: boolean
  clauses_count: number
  clauses_with_date: number
  is_current: boolean
  // Поле есть в таблице, но НЕТ во view contract_stages_with_progress
  // — поэтому в виджете используем эвристику: ручной этап = stage_number > LLM-извлечённого
  // максимума. Для подсветки чекаем «source_quote отсутствует» через отдельный fetch не делаем.
  source_quote?: string | null
  source_page?: number | null
}

interface RelatedEvent {
  id: string
  title: string | null
  event_type: string
  date_end: string | null
  date_computed: string | null
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
  const [contractStages, setContractStages] = useState<ContractStage[]>([])
  const [eventsByClause, setEventsByClause] = useState<Record<string, RelatedEvent[]>>({})
  const [eventSubtypes, setEventSubtypes] = useState<Record<string, EventSubtypeRef>>({})
  // С 2026-05-18: классификатор + список событий договора для пикера «событие-причина»
  const [contractEventTypes, setContractEventTypes] = useState<ContractEventType[]>([])
  const [docEvents, setDocEvents] = useState<{ id: string; title: string | null; date_start: string | null; event_type: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [savingClause, setSavingClause] = useState<string | null>(null)
  const [reparsing, setReparsing] = useState(false)
  const [extractingStages, setExtractingStages] = useState(false)
  const [transitioningTo, setTransitioningTo] = useState<string | null>(null)
  const [savingStageId, setSavingStageId] = useState<string | null>(null)
  const [addingStage, setAddingStage] = useState(false)
  // Событие contract_stage_change для текущего этапа — для редактирования даты перехода
  const [currentTransition, setCurrentTransition] = useState<{ id: string; date: string | null } | null>(null)
  const [savingTransitionDate, setSavingTransitionDate] = useState(false)

  // Загружаем справочники один раз
  useEffect(() => {
    supabase
      .from('project_stages')
      .select('code,label,sort_order')
      .order('sort_order', { ascending: true })
      .then(({ data }) => setAllStages((data as unknown as ProjectStage[]) ?? []))
    supabase
      .from('contract_event_types')
      .select('id,code,category,label,icon,sort_order,is_intermediate,is_anchor,is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .then(({ data }) => setContractEventTypes((data as unknown as ContractEventType[]) ?? []))
    supabase
      .from('event_subtypes')
      .select('code,category,label,icon')
      .then(({ data }) => {
        const map: Record<string, EventSubtypeRef> = {}
        for (const s of (data ?? []) as EventSubtypeRef[]) map[s.code] = s
        setEventSubtypes(map)
      })
  }, [])

  const loadStages = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/v2/${id}/stages`)
      if (!res.ok) return
      const { stages } = await res.json() as { stages: ContractStage[] }
      setContractStages(stages ?? [])

      // Подтягиваем последнее событие contract_stage_change для текущего этапа —
      // нужно для редактирования даты перехода прямо в виджете.
      const current = stages?.find(s => s.is_current)
      if (current) {
        const { data: evs } = await supabase
          .from('events')
          .select('id, date_start')
          .eq('subject_document_id', id)
          .eq('event_type', 'contract_stage_change')
          .eq('to_stage_id', current.id)
          .order('created_at', { ascending: false })
          .limit(1)
        const ev = evs?.[0] as { id: string; date_start: string | null } | undefined
        setCurrentTransition(ev ? { id: ev.id, date: ev.date_start } : null)
      } else {
        setCurrentTransition(null)
      }
    } catch {
      // тихо — этапы не критичны для отображения карточки
    }
  }, [id])

  /**
   * Правка даты события «contract_stage_change» (переход на текущий этап).
   * Обновляет date_start и date_end (для contract_stage_change они равны).
   * Триггер БД current_stage_id уже выставил — здесь только аудит-дата.
   */
  async function updateTransitionDate(newDate: string) {
    if (!currentTransition) return
    const dateOrNull = newDate || null
    setSavingTransitionDate(true)
    setError(null)
    try {
      const { error: upErr } = await supabase
        .from('events')
        .update({ date_start: dateOrNull, date_end: dateOrNull })
        .eq('id', currentTransition.id)
      if (upErr) throw new Error(upErr.message)
      setCurrentTransition({ ...currentTransition, date: dateOrNull })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingTransitionDate(false)
    }
  }

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
      await loadStages()

      // События, связанные с этим договором — для пикера «событие-причина»
      // в редактировании даты пункта. Берём те что имеют subject_document_id=doc,
      // плюс позже можем добавить связь через entity_links.
      const { data: evs } = await supabase
        .from('events')
        .select('id, title, date_start, event_type')
        .eq('subject_document_id', id)
        .order('date_start', { ascending: false })
        .limit(100)
      setDocEvents((evs as unknown as typeof docEvents) ?? [])

      // clause_events удалена в миграции 20260508000003. Для пунктов договора
      // теперь генерируются calendar_entries (см. WIKI 15_Календарь_объекта).
      // Pipeline clauses → calendar_entries — TODO; пока секция пустая.
      const clauseIds = (data.clauses ?? []).map(c => c.id)
      if (clauseIds.length > 0) {
        setEventsByClause({})
      } else {
        setEventsByClause({})
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id, loadStages])

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
   * Полный повторный разбор: этапы + пункты через LLM (2 прохода).
   * 1. POST /reparse → возвращает {stages, clauses} от LLM. Долго (~40–80 сек).
   * 2. confirm с количеством → если ОК → POST /clauses/replace (DELETE+INSERT обоих).
   * 3. load() для обновления.
   *
   * Используется кнопкой «🔄 Переразобрать всё» — затирает И этапы И пункты.
   * Если нужны только пункты (этапы оставить) — используй extractEvents().
   */
  async function reparse() {
    if (!confirm('Запустить полный повторный разбор договора через LLM?\n\nЭтапы И пункты будут заменены результатом анализа.\nРучные правки (как этапов, так и пунктов) будут потеряны.\nЗапрос занимает 40–80 секунд.')) return

    setReparsing(true)
    setError(null)
    setInfo('🔄 Запущен полный повторный разбор договора через LLM. 40–80 секунд, не закрывайте страницу…')

    try {
      const res = await fetch(`/api/contracts/v2/${id}/reparse`, { method: 'POST' })
      if (!res.ok) {
        const { error } = await res.json()
        setError(error)
        setInfo(null)
        return
      }
      const { stages: freshStages, clauses: fresh } = await res.json() as {
        stages: unknown[]
        clauses: unknown[]
      }
      setInfo(null)

      const currentCount = doc?.clauses.length ?? 0
      if (!confirm(`LLM нашёл: этапов ${freshStages.length}, пунктов ${fresh.length}. Заменить ${contractStages.length} этап(а) и ${currentCount} существующих пункт(а)?`)) return

      setInfo('💾 Сохраняем результат…')
      const replaceRes = await fetch(`/api/contracts/v2/${id}/clauses/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stages: freshStages, clauses: fresh }),
      })
      if (!replaceRes.ok) throw new Error((await replaceRes.json()).error)
      await load()
      setInfo(`✅ Заменено: этапов ${freshStages.length}, пунктов ${fresh.length}`)
      setTimeout(() => setInfo(null), 3000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setInfo(null)
    } finally {
      setReparsing(false)
    }
  }

  /**
   * «🎯 Выделить события договора» — LLM-проход ТОЛЬКО по пунктам, используя
   * существующие contract_stages из БД (skip_stages=true).
   *
   * Этапы и documents.current_stage_id НЕ трогаются (preserve_stages=true в /clauses/replace).
   * Это позволяет: 1) сначала выделить и при необходимости поправить этапы вручную,
   * 2) потом нажать «события» — пункты разметятся stage_id согласно текущим этапам.
   */
  async function extractEvents() {
    const currentCount = doc?.clauses.length ?? 0
    const warn = currentCount > 0
      ? `\n\nТекущие ${currentCount} пункт(а/ов) будут заменены результатом LLM.`
      : ''
    const stagesNote = contractStages.length === 0
      ? '\n\n⚠️ Этапы договора ещё не выделены. Пункты получат stage_id=null — потом сможете перепривязать вручную или нажать «🎯 Выделить этапы» сперва.'
      : `\n\nLLM учтёт ${contractStages.length} существующих этап(ов) и расставит привязку пунктов к ним.`

    if (!confirm(
      'Выделить события (пункты) договора через LLM?' +
      warn + stagesNote +
      '\n\nЗапрос занимает 30–60 секунд.',
    )) return

    setReparsing(true)
    setError(null)
    setInfo('🎯 LLM разбирает события договора. 30–60 секунд, не закрывайте страницу…')

    try {
      const res = await fetch(`/api/contracts/v2/${id}/reparse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_stages: true }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setError(error)
        setInfo(null)
        return
      }
      const { clauses: fresh } = await res.json() as { clauses: unknown[] }
      setInfo('💾 Сохраняем пункты…')

      const replaceRes = await fetch(`/api/contracts/v2/${id}/clauses/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clauses: fresh, preserve_stages: true }),
      })
      if (!replaceRes.ok) throw new Error((await replaceRes.json()).error)
      await load()
      setInfo(`✅ Выделено событий: ${fresh.length}`)
      setTimeout(() => setInfo(null), 3000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setInfo(null)
    } finally {
      setReparsing(false)
    }
  }

  // ─── Stages: выделить (для существующих договоров) + переход этапа ──────

  /**
   * POST /api/contracts/v2/[id]/extract-stages — LLM-проход 1 для договоров,
   * у которых уже есть clauses, но contract_stages ещё нет.
   * Источник текста: documents.extracted_text → fallback PDF.
   * После завершения contract_clauses.stage_id обнуляется (FK ON DELETE SET NULL).
   */
  async function extractStages() {
    const manualCount = contractStages.filter(s => !s.source_quote).length
    const manualWarn = manualCount > 0
      ? `\n\n⚠️ ВНИМАНИЕ: у договора ${manualCount} этап(а/ов), добавленных вручную — они будут БЕЗВОЗВРАТНО удалены и заменены результатом LLM.`
      : ''
    if (!confirm(
      'Выделить этапы договора через LLM?\n\n' +
      'LLM проанализирует текст договора и предложит список этапов (АГК, ОПР, МОП, ТЭП и т.п.).\n' +
      'Существующие этапы будут заменены; привязка пунктов к этапам сбросится — её придётся\n' +
      'восстановить вручную через UI редактора пунктов.' +
      manualWarn +
      '\n\nЗапрос занимает 20–40 секунд.',
    )) return

    setExtractingStages(true)
    setError(null)
    setInfo('🎯 Запущено выделение этапов договора через LLM. 20–40 секунд, не закрывайте страницу…')
    try {
      const res = await fetch(`/api/contracts/v2/${id}/extract-stages`, { method: 'POST' })
      const data = await res.json() as { ok?: boolean; stages_count?: number; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'extract-stages failed')
      await loadStages()
      await load()  // current_stage_id мог измениться
      setInfo(`✅ Выделено этапов: ${data.stages_count ?? 0}`)
      setTimeout(() => setInfo(null), 4000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setInfo(null)
    } finally {
      setExtractingStages(false)
    }
  }

  /**
   * Ручное добавление этапа в конец списка.
   * Если у договора этапов 0 — новый этап становится текущим автоматически.
   */
  async function addStage(stageName: string, description: string | null) {
    setAddingStage(true)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/v2/${id}/stages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_name: stageName, description }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'add stage failed')
      await loadStages()
      await load()  // current_stage_id мог измениться, если это был первый этап
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingStage(false)
    }
  }

  /**
   * Ручная правка названия/описания этапа. Не трогает stage_number.
   */
  async function patchStage(stageId: string, fields: { stage_name?: string; description?: string | null }) {
    setSavingStageId(stageId)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/v2/${id}/stages/${stageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'patch stage failed')
      await loadStages()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingStageId(null)
    }
  }

  /**
   * Удаление этапа. Если он текущий — сервер сам переключит current на следующий
   * (или NULL, если этапов больше не остаётся).
   * contract_clauses.stage_id у привязанных пунктов обнулится каскадом FK.
   */
  async function deleteStage(stageId: string, stageName: string, clausesCount: number) {
    const warn = clausesCount > 0
      ? `\n\nВНИМАНИЕ: к этому этапу привязано пунктов: ${clausesCount}. После удаления их stage_id обнулится — придётся перепривязать вручную.`
      : ''
    if (!confirm(`Удалить этап «${stageName}»?${warn}`)) return
    setSavingStageId(stageId)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/v2/${id}/stages/${stageId}`, {
        method: 'DELETE',
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'delete stage failed')
      await loadStages()
      await load()  // current_stage_id мог измениться
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingStageId(null)
    }
  }

  /**
   * POST /api/contracts/v2/[id]/stages/transition — создаёт событие
   * `contract_stage_change`; триггер БД обновит documents.current_stage_id.
   */
  async function transitionStage(toStageId: string, toStageName: string) {
    if (!confirm(`Перейти к этапу «${toStageName}»?\n\nБудет создано событие contract_stage_change в журнале.`)) return
    setTransitioningTo(toStageId)
    setError(null)
    try {
      const res = await fetch(`/api/contracts/v2/${id}/stages/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_stage_id: toStageId }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'transition failed')
      await loadStages()
      setInfo(`✅ Текущий этап: «${toStageName}»`)
      setTimeout(() => setInfo(null), 3000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTransitioningTo(null)
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
        <a
          href={`/api/contracts/v2/${id}/file`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 inline-flex items-center gap-1"
          title={doc.folder_path
            ? `Открыть PDF договора в новом окне (${doc.folder_path})`
            : 'У договора нет folder_path — файл недоступен'}
        >📄 Просмотреть договор</a>
        <button
          onClick={() => router.push(`/contracts/${id}/print`)}
          className="px-3 py-1 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50"
          title="Сводка для печати (договор, стороны, объекты, этапы, события)"
        >🖨 Печать</button>
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

      {/* Виджет «Этапы договора» */}
      <StagesWidget
        stages={contractStages}
        extracting={extractingStages}
        transitioningTo={transitioningTo}
        savingStageId={savingStageId}
        addingStage={addingStage}
        currentTransitionDate={currentTransition?.date ?? null}
        canEditTransitionDate={!!currentTransition}
        savingTransitionDate={savingTransitionDate}
        onUpdateTransitionDate={updateTransitionDate}
        onExtract={extractStages}
        onTransition={transitionStage}
        onAdd={addStage}
        onPatch={patchStage}
        onDelete={deleteStage}
      />

      {/* Ленточный график «События договора» — с 2026-05-18.
          Самописный SVG-Gantt (см. components/GanttChart.tsx). Группировка
          по этапам, бары по date_source (договорная/изменённая/расчётная),
          стрелки зависимостей по term_ref_clause_id. */}
      {doc.clauses.length > 0 && (
        <div className="mb-6 border rounded p-3 bg-white">
          <div className="text-xs text-gray-500 mb-2 flex items-center justify-between">
            <span className="font-semibold">📊 Ленточный график событий</span>
            <span className="text-[10px] text-gray-400">
              синий — договорная · зелёный — изменённая · серый — расчётная
            </span>
          </div>
          <ContractClausesGantt
            clauses={doc.clauses as unknown as GClause[]}
            stages={contractStages as unknown as GStage[]}
            eventTypes={contractEventTypes as unknown as GType[]}
            signedDate={doc.signed_date}
          />
        </div>
      )}

      {/* Таблица пунктов / событий договора */}
      <div className="border rounded">
        <div className="flex items-center justify-between p-3 border-b bg-gray-50">
          <div className="font-semibold">События договора <span className="text-gray-500 text-sm">({doc.clauses.length})</span></div>
          <div className="flex gap-2">
            <button
              onClick={extractEvents}
              disabled={reparsing}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
              title="LLM выделит пункты (события) с привязкой к существующим этапам. Этапы НЕ затрагиваются."
            >
              {reparsing && (
                <span className="inline-block w-3 h-3 border-2 border-blue-300 border-t-white rounded-full animate-spin" />
              )}
              {reparsing ? 'Анализ…' : '🎯 Выделить события договора'}
            </button>
            <button
              onClick={reparse}
              disabled={reparsing}
              className="px-3 py-1 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
              title="Полный пересбор: этапы И пункты заново (затирает ручные правки)"
            >
              {reparsing ? '…' : '🔄 Переразобрать всё'}
            </button>
            <button onClick={addClause} disabled={reparsing} className="px-3 py-1 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50">+ Пункт</button>
          </div>
        </div>
        {doc.clauses.length === 0 ? (
          <div className="p-6 text-center text-gray-500 space-y-2">
            <div>События договора ещё не выделены.</div>
            <div className="text-sm">
              Нажмите <span className="font-semibold">«🎯 Выделить события договора»</span> для LLM-разбора
              {contractStages.length > 0
                ? ' (привязка к этапам будет автоматической)'
                : ' (этапы рекомендуем выделить заранее — кнопка выше)'}.
            </div>
            <div className="text-xs text-gray-400">или «+ Пункт» — для ручного добавления.</div>
          </div>
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
                    contractEventTypes={contractEventTypes}
                    docEvents={docEvents}
                    contractStages={contractStages}
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
  clause, allClauses, events, eventSubtypes, computed,
  contractEventTypes, docEvents, contractStages,
  onPatch, onDelete, saving,
}: {
  clause: Clause
  allClauses: Clause[]
  events: RelatedEvent[]
  eventSubtypes: Record<string, EventSubtypeRef>
  computed: ClauseDateResult | null
  contractEventTypes: ContractEventType[]
  docEvents: { id: string; title: string | null; date_start: string | null; event_type: string }[]
  contractStages: ContractStage[]
  onPatch: (fields: Partial<Clause>) => void
  onDelete: () => void
  saving: boolean
}) {
  // UI-state для пикера события-причины
  const [eventPickerOpen, setEventPickerOpen] = useState(false)
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

  // При empty mode — первый ввод определяет режим.
  // Любая ручная правка даты пользователем → date_source='edited' (раньше было contract).
  // Для возврата к договорной — отдельная кнопка-бейдж рядом с датой.
  function commitDateAutoMode() {
    const after = local.clause_date
    const before = clause.clause_date
    if (after === before) return
    const patch: Partial<Clause> = { clause_date: after }
    if (mode === null && after) {
      patch.date_mode = 'date'
    }
    // Помечаем как «изменённая» если значение реально поменялось от того что было в БД.
    if (clause.date_source !== 'edited' && after !== clause.clause_date) {
      patch.date_source = 'edited'
    }
    setLocal({ ...local, ...patch })
    onPatch(patch)
  }

  // Сброс статуса на «договорная»: значение даты остаётся, ссылка на событие чистится.
  function markDateAsContract() {
    if (clause.date_source === 'contract' && !clause.date_change_event_id) return
    const patch: Partial<Clause> = { date_source: 'contract', date_change_event_id: null }
    setLocal({ ...local, ...patch })
    onPatch(patch)
  }

  // Привязка события-причины к смене даты (date_source = 'edited').
  function setDateChangeEvent(eventId: string | null) {
    const patch: Partial<Clause> = {
      date_change_event_id: eventId,
      date_source: 'edited',
    }
    setLocal({ ...local, ...patch })
    onPatch(patch)
    setEventPickerOpen(false)
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
          {/* Статус даты + пикер события-причины (с 2026-05-18) */}
          {!clause.is_anchor && (() => {
            // Эффективный date_source: если режим term — то computed (на лету), иначе хранимое.
            const effectiveSource: DateSource = isTermMode ? 'computed' : local.date_source
            const meta = DATE_SOURCE_META[effectiveSource]
            const linkedEvent = local.date_change_event_id
              ? docEvents.find(e => e.id === local.date_change_event_id) ?? null
              : null
            return (
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => effectiveSource === 'edited' && markDateAsContract()}
                  disabled={effectiveSource !== 'edited'}
                  className={`inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] rounded border ${meta.badge} ${effectiveSource === 'edited' ? 'cursor-pointer hover:opacity-70' : 'cursor-default'}`}
                  title={effectiveSource === 'edited'
                    ? `Дата ${meta.label}${linkedEvent ? ` (причина: «${linkedEvent.title ?? linkedEvent.event_type}»)` : ''}. Кликнуть → сбросить в «договорную».`
                    : `Дата ${meta.label}`}
                >
                  <span>{meta.icon}</span>
                  <span className="font-medium">{meta.label}</span>
                </button>
                {effectiveSource !== 'computed' && (
                  <button
                    type="button"
                    onClick={() => setEventPickerOpen(v => !v)}
                    className="text-[10px] text-gray-500 hover:text-blue-600 px-1 py-0.5 border border-gray-200 rounded"
                    title="Указать событие-причину смены даты (письмо/протокол)"
                  >🔗 {linkedEvent ? '✓' : 'событие'}</button>
                )}
              </div>
            )
          })()}
          {/* Пикер события-причины (мини-popover) */}
          {eventPickerOpen && (
            <div className="border rounded p-2 bg-white shadow-sm space-y-1">
              <div className="text-[10px] text-gray-500 mb-1">Событие-причина смены даты:</div>
              <select
                value={local.date_change_event_id ?? ''}
                onChange={e => setDateChangeEvent(e.target.value || null)}
                className="w-full px-1 py-0.5 border rounded text-[11px]"
              >
                <option value="">— нет —</option>
                {docEvents.map(ev => (
                  <option key={ev.id} value={ev.id}>
                    {ev.date_start ?? '—'} · {ev.title ?? ev.event_type}
                  </option>
                ))}
              </select>
              {docEvents.length === 0 && (
                <div className="text-[10px] text-gray-400 italic">
                  Нет связанных с договором событий. Создайте письмо/протокол на странице /events.
                </div>
              )}
            </div>
          )}
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
          {/* Тип события договора — из классификатора contract_event_types.
              Категория (для бейджа) денорм-синкается триггером БД, так что
              после смены event_type_id оптимистично обновляем local.category. */}
          <select
            value={local.event_type_id ?? ''}
            onChange={e => {
              const newId = e.target.value || null
              const picked = contractEventTypes.find(t => t.id === newId) ?? null
              setLocal({
                ...local,
                event_type_id: newId,
                category: picked?.category ?? null,
              })
              if (newId !== clause.event_type_id) {
                onPatch({ event_type_id: newId, category: picked?.category ?? null })
              }
            }}
            className={`w-full text-[11px] px-1.5 py-1 border rounded font-semibold tracking-wide ${
              local.category ? CATEGORY_BADGE_CLASS[local.category] : 'bg-gray-50 text-gray-400 border-gray-200'
            }`}
            title="Тип события договора (из классификатора)"
          >
            <option value="">— тип события —</option>
            {CATEGORY_OPTIONS.map(catOpt => {
              const types = contractEventTypes.filter(t => t.category === catOpt.value)
              if (!types.length) return null
              return (
                <optgroup key={catOpt.value} label={`${catOpt.short} · ${catOpt.label}`}>
                  {types.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.icon ? `${t.icon} ` : ''}{t.label}{t.is_intermediate ? ' · промежут.' : ''}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>

          {/* Привязка к этапу договора — ручной dropdown (с 2026-05-18).
              Якорь не привязывается к этапу, у него селектор не показываем. */}
          {!clause.is_anchor && (
            <select
              value={local.stage_id ?? ''}
              onChange={e => {
                const newStageId = e.target.value || null
                setLocal({ ...local, stage_id: newStageId })
                if (newStageId !== clause.stage_id) onPatch({ stage_id: newStageId })
              }}
              className={`w-full text-[11px] px-1.5 py-1 border rounded ${
                local.stage_id ? 'bg-violet-50 text-violet-800 border-violet-300' : 'bg-gray-50 text-gray-500 border-gray-200'
              }`}
              title="Этап договора, к которому относится это событие"
            >
              <option value="">— без этапа —</option>
              {contractStages
                .slice()
                .sort((a, b) => a.sort_order - b.sort_order)
                .map(s => (
                  <option key={s.id} value={s.id}>
                    🎯 Этап {s.stage_number} · {s.stage_name}
                  </option>
                ))}
            </select>
          )}
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
                    title={st?.label ?? ev.event_type}
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

// ─── StagesWidget — список этапов договора + переход + выделение ────────────

interface StagesWidgetProps {
  stages: ContractStage[]
  extracting: boolean
  transitioningTo: string | null
  savingStageId: string | null
  addingStage: boolean
  /** Дата последнего contract_stage_change-события на текущий этап (для редактирования). */
  currentTransitionDate: string | null
  /** Есть ли событие перехода — без него редактировать нечего. */
  canEditTransitionDate: boolean
  savingTransitionDate: boolean
  onUpdateTransitionDate: (newDate: string) => void
  onExtract: () => void
  onTransition: (stageId: string, stageName: string) => void
  onAdd: (stageName: string, description: string | null) => void
  onPatch: (stageId: string, fields: { stage_name?: string; description?: string | null }) => void
  onDelete: (stageId: string, stageName: string, clausesCount: number) => void
}

function StagesWidget({
  stages, extracting, transitioningTo, savingStageId, addingStage,
  currentTransitionDate, canEditTransitionDate, savingTransitionDate, onUpdateTransitionDate,
  onExtract, onTransition, onAdd, onPatch, onDelete,
}: StagesWidgetProps) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const hasStages = stages.length > 0
  const currentIdx = stages.findIndex(s => s.is_current)
  const next = currentIdx >= 0 && currentIdx + 1 < stages.length ? stages[currentIdx + 1] : null

  // Пустое состояние — карточка с кнопками «🎯 Выделить этапы» / «+ Добавить»
  if (!hasStages) {
    return (
      <div className="mb-6 border-2 border-dashed border-gray-300 rounded p-4 bg-gray-50/50">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-1">
            <div className="font-semibold text-gray-700">Этапы договора</div>
            <div className="text-sm text-gray-500 mt-1">
              Этапы не выделены. Запустите LLM-анализ или добавьте этап вручную.
            </div>
          </div>
          <button
            onClick={onExtract}
            disabled={extracting}
            className="px-4 py-2 text-sm bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-2"
            title="LLM-анализ текста договора → список этапов"
          >
            {extracting && (
              <span className="inline-block w-3 h-3 border-2 border-violet-300 border-t-white rounded-full animate-spin" />
            )}
            {extracting ? 'Анализ…' : '🎯 Выделить этапы'}
          </button>
          <button
            onClick={() => setShowAddForm(v => !v)}
            disabled={extracting || addingStage}
            className="px-3 py-2 text-sm border border-gray-300 text-gray-700 rounded hover:bg-white disabled:opacity-50"
            title="Добавить этап вручную"
          >
            ✏️ Вручную
          </button>
        </div>
        {showAddForm && (
          <AddStageForm
            saving={addingStage}
            onCancel={() => setShowAddForm(false)}
            onSubmit={async (name, desc) => {
              await onAdd(name, desc)
              setShowAddForm(false)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="mb-6 border rounded">
      <div className="flex items-center justify-between p-3 border-b bg-gray-50">
        <div className="font-semibold">
          Этапы договора <span className="text-gray-500 text-sm">({stages.length})</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddForm(v => !v)}
            disabled={extracting || addingStage}
            className="px-3 py-1 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50"
            title="Добавить новый этап вручную (в конец списка)"
          >
            + Этап
          </button>
          <button
            onClick={onExtract}
            disabled={extracting}
            className="px-3 py-1 text-sm border border-violet-300 text-violet-700 rounded hover:bg-violet-50 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
            title="Перезапустить LLM-анализ этапов (текущие этапы будут заменены, ручные правки потеряются)"
          >
            {extracting && (
              <span className="inline-block w-3 h-3 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
            )}
            {extracting ? 'Анализ…' : '🔄 Перевыделить этапы'}
          </button>
        </div>
      </div>
      <ul className="divide-y">
        {stages.map(s => {
          const isCurrent = s.is_current
          const isTransitioning = transitioningTo === s.id
          const isManual = !s.source_quote  // ручной этап (добавлен оператором, без LLM-источника)
          const isEditing = editingId === s.id
          const isSaving = savingStageId === s.id

          return (
            <li
              key={s.id}
              className={`p-3 ${isCurrent ? 'bg-emerald-50/60 border-l-4 border-emerald-500' : ''} ${isSaving ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-7 text-center pt-0.5">
                  {isCurrent
                    ? <span title="Текущий этап" className="text-emerald-600">📌</span>
                    : <span className="text-gray-300">○</span>}
                </div>
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <EditStageForm
                      initial={{ stage_name: s.stage_name, description: s.description }}
                      saving={isSaving}
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (name, desc) => {
                        await onPatch(s.id, { stage_name: name, description: desc })
                        setEditingId(null)
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-semibold">
                          Этап {s.stage_number}. {s.stage_name}
                        </span>
                        {isCurrent && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-emerald-600 text-white rounded">
                            ТЕКУЩИЙ
                          </span>
                        )}
                        {isCurrent && canEditTransitionDate && (
                          <label className="inline-flex items-center gap-1 text-[11px] text-gray-600">
                            <span title="Дата перехода на этот этап (событие contract_stage_change). Изменение даты пишется в журнал событий.">📅 переход:</span>
                            <input
                              type="date"
                              value={currentTransitionDate ?? ''}
                              onChange={e => onUpdateTransitionDate(e.target.value)}
                              disabled={savingTransitionDate}
                              className="px-1 py-0.5 border border-emerald-200 rounded text-[11px] bg-white"
                              title="Редактирует событие contract_stage_change для текущего этапа"
                            />
                            {savingTransitionDate && (
                              <span className="inline-block w-3 h-3 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin" />
                            )}
                          </label>
                        )}
                        {s.is_default && !isCurrent && (
                          <span className="text-[10px] text-gray-400 italic">по умолчанию</span>
                        )}
                        {isManual && (
                          <span
                            className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-200 rounded"
                            title="Этап добавлен вручную оператором (не из LLM-разбора). При «🔄 Перевыделить этапы» будет затёрт."
                          >
                            ✏️ ручной
                          </span>
                        )}
                      </div>
                      {s.description && (
                        <div className="text-sm text-gray-600 mt-1">{s.description}</div>
                      )}
                      <div className="text-xs text-gray-500 mt-1">
                        Пунктов: {s.clauses_count}
                        {s.clauses_with_date > 0 && ` · с датой: ${s.clauses_with_date}`}
                        {s.source_page != null && ` · стр. ${s.source_page}`}
                      </div>
                    </>
                  )}
                </div>
                {!isEditing && (
                  <div className="flex-shrink-0 flex flex-col items-end gap-1">
                    <div className="flex gap-1">
                      <button
                        onClick={() => setEditingId(s.id)}
                        disabled={isSaving}
                        className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                        title="Редактировать название и описание"
                      >✏️</button>
                      <button
                        onClick={() => onDelete(s.id, s.stage_name, s.clauses_count)}
                        disabled={isSaving}
                        className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded"
                        title="Удалить этап (привязка пунктов сбросится)"
                      >✕</button>
                    </div>
                    {!isCurrent && (
                      <button
                        onClick={() => onTransition(s.id, s.stage_name)}
                        disabled={!!transitioningTo || isSaving}
                        className="px-2.5 py-1 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 disabled:opacity-40 inline-flex items-center gap-1"
                        title="Установить как текущий этап (создаётся событие contract_stage_change)"
                      >
                        {isTransitioning && (
                          <span className="inline-block w-3 h-3 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin" />
                        )}
                        Сделать текущим
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {/* Форма добавления нового этапа */}
      {showAddForm && (
        <div className="p-3 border-t bg-gray-50/60">
          <AddStageForm
            saving={addingStage}
            onCancel={() => setShowAddForm(false)}
            onSubmit={async (name, desc) => {
              await onAdd(name, desc)
              setShowAddForm(false)
            }}
          />
        </div>
      )}

      {next && (
        <div className="p-3 border-t bg-emerald-50/40 flex items-center justify-between">
          <div className="text-sm text-gray-700">
            Следующий этап: <span className="font-semibold">«{next.stage_name}»</span>
          </div>
          <button
            onClick={() => onTransition(next.id, next.stage_name)}
            disabled={!!transitioningTo}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2"
            title="Завершить текущий этап и перейти к следующему"
          >
            {transitioningTo === next.id && (
              <span className="inline-block w-3 h-3 border-2 border-emerald-200 border-t-white rounded-full animate-spin" />
            )}
            ✅ Завершить этап → перейти к «{next.stage_name}»
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Формы для добавления/редактирования этапа ────────────────────

function AddStageForm({
  saving, onCancel, onSubmit,
}: {
  saving: boolean
  onCancel: () => void
  onSubmit: (name: string, description: string | null) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500 mb-1">Добавить новый этап (в конец списка):</div>
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Название этапа (например: АГК — Подэтап 1: предварительные варианты)"
        className="w-full px-2 py-1.5 border rounded text-sm"
        disabled={saving}
        autoFocus
      />
      <textarea
        value={desc}
        onChange={e => setDesc(e.target.value)}
        placeholder="Описание (опционально)…"
        rows={2}
        className="w-full px-2 py-1.5 border rounded text-sm"
        disabled={saving}
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1 text-sm border border-gray-300 text-gray-600 rounded hover:bg-white"
        >Отмена</button>
        <button
          onClick={() => onSubmit(name.trim(), desc.trim() || null)}
          disabled={saving || !name.trim()}
          className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {saving && (
            <span className="inline-block w-3 h-3 border-2 border-blue-200 border-t-white rounded-full animate-spin" />
          )}
          Сохранить
        </button>
      </div>
    </div>
  )
}

function EditStageForm({
  initial, saving, onCancel, onSubmit,
}: {
  initial: { stage_name: string; description: string | null }
  saving: boolean
  onCancel: () => void
  onSubmit: (name: string, description: string | null) => void | Promise<void>
}) {
  const [name, setName] = useState(initial.stage_name)
  const [desc, setDesc] = useState(initial.description ?? '')
  return (
    <div className="space-y-2">
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        className="w-full px-2 py-1.5 border-2 border-blue-400 rounded text-sm font-semibold"
        disabled={saving}
        autoFocus
      />
      <textarea
        value={desc}
        onChange={e => setDesc(e.target.value)}
        rows={3}
        placeholder="Описание этапа…"
        className="w-full px-2 py-1.5 border rounded text-sm"
        disabled={saving}
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1 text-sm border border-gray-300 text-gray-600 rounded hover:bg-white"
        >Отмена</button>
        <button
          onClick={() => onSubmit(name.trim(), desc.trim() || null)}
          disabled={saving || !name.trim()}
          className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {saving && (
            <span className="inline-block w-3 h-3 border-2 border-blue-200 border-t-white rounded-full animate-spin" />
          )}
          Сохранить
        </button>
      </div>
    </div>
  )
}
