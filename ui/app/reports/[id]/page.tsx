'use client'

import { useEffect, useState, useRef, useLayoutEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { formatPeriodPhrase } from '@/lib/reports/periodHelpers'
import { formatScopeLabel } from '@/lib/reports/scopeLabel'
import ControlReportView, { type ControlReport, type ControlSection, ObjectTitle, StaleHintWarning } from './ControlReportView'
import ShortReportView, { type ShortReport, type ShortSection } from './ShortReportView'
import ContractReportView, { type ContractReport } from './ContractReportView'
import { type MapGeoData, getObjectAreaM2 } from './ObjectSchema'
import ObjectCover from './ObjectCover'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })
const MDPreview = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default.Markdown),
  { ssr: false },
)

// Textarea, который вырастает на размер содержимого. Без max-height —
// используется внутри прокручиваемой страницы карточки отчёта.
function AutoGrowTextarea({
  value, onChange, placeholder, minRows = 3,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minRows?: number
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // useLayoutEffect — пересчитываем высоту синхронно после DOM-изменений,
  // до того как браузер отрисует кадр (без «прыжка» высоты).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <>
      {/* Редактируемое поле — только на экране. */}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={minRows}
        placeholder={placeholder}
        className="no-print w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none overflow-hidden"
      />
      {/* Печатная версия. <textarea> не пагинируется: его высота
          фиксируется в px по экранному рендеру (14px), а при печати шрифт
          становится 10pt и ширина меняется — текст переразбивается выше
          бокса и вылезает за рамку. Поэтому при печати выводим значение
          обычным потоковым блоком (pre-wrap сохраняет переносы/списки как
          введены). Рамки нет — лишний бордюр на печати не нужен. */}
      <div className="print-only text-sm whitespace-pre-wrap break-words">
        {value}
      </div>
    </>
  )
}

type Report = {
  id: string
  period_type: 'week' | 'month' | 'control' | 'short' | 'contract'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  finalized_at: string | null
  summary_md: string | null
  preamble: string | null
  include_financials: boolean
}

type ContractSummary = {
  id: string
  type: string
  title: string
  doc_number: string | null
  signed_date: string | null
  customer_name: string | null
  contractor_name: string | null
  contractor_entity_id: string | null
}

type ContractorGroup = {
  contractor_entity_id: string | null
  contractor_name: string
  contracts: ContractSummary[]
  stats: { tasks_done: number; tasks_active: number; tasks_overdue: number }
}

type SectionStats = {
  object_id: string
  object_code: string
  object_name: string
  tasks_done: number
  tasks_active: number
  tasks_overdue: number
  tasks_due_next: number
  events_in_period: number
  events_next_period: number
  events_overdue: number
  topics_recent: number
  contractors: ContractorGroup[]
}

type Section = {
  id: string
  object_id: string
  // week/month поля (legacy 6-секционная структура — оставлены для month)
  project_movement: string | null
  achievements: string | null
  achievements_list: string | null
  next_period_tasks: string | null
  next_period_tasks_list: string | null
  risks: string | null
  // weekly v3 поля (с 14.05.2026)
  weekly_done_brief: string | null
  weekly_topics_brief: string | null
  weekly_upcoming_brief: string | null
  // control поля
  narrative: string | null
  contract_summary: string | null
  decisions: string | null
  priority_group: 'priority' | 'secondary' | null
  tep_deadline: string | null
  generated_at: string
  model_used: string | null
  object: { code: string; current_name: string; contractor: string | null; active: boolean; llm_hint: string | null; aliases?: string[] } | null
  recent_activity?: { tasks_active: number; topics_30d: number; events_30d: number }
  hint_effective_at_reference?: boolean
  lifecycle_events?: {
    resolved: LifecycleEventLite[]
    active_problems: LifecycleEventLite[]
    risk_no_followup: LifecycleEventLite[]
  }
  tasks_done_in_period?: Array<{
    id: string; code: string; title: string;
    assignee_org: string | null; done_date: string; status: string
  }>
}

type LifecycleEventLite = {
  id: string
  title: string
  importance: 'high' | 'critical' | null
  date: string | null
  is_resolved: boolean
  resolved_date: string | null
  resolved_by_title: string | null
  task_count: number
  has_active_task: boolean
  related_tasks?: Array<{
    id: string
    code: string
    title: string
    status: string
    done_date: string | null
  }>
}

type ReportFieldKey = 'project_movement' | 'achievements' | 'achievements_list'
                    | 'next_period_tasks' | 'next_period_tasks_list' | 'risks'
                    | 'weekly_done_brief' | 'weekly_topics_brief' | 'weekly_upcoming_brief'

// Контентные поля секции отчёта.
// month → 6 полей legacy-структуры (с группировкой 2/3)
// week  → 4 поля Weekly v3 (плоско)
type FieldDef = { key: ReportFieldKey; title: string; group?: string; hint?: string }

const MONTH_FIELDS: FieldDef[] = [
  { key: 'project_movement',       title: '1. Существующее движение проекта' },
  { key: 'achievements',           title: '2.1 Описание',        group: '2. Достижения за период' },
  { key: 'achievements_list',      title: '2.2 Основные пункты', group: '2. Достижения за период' },
  { key: 'next_period_tasks',      title: '3.1 Описание',        group: '3. Задачи наступающего периода' },
  { key: 'next_period_tasks_list', title: '3.2 Основные пункты', group: '3. Задачи наступающего периода' },
  { key: 'risks',                  title: '4. Риски' },
]

const WEEKLY_V3_FIELDS_UI: FieldDef[] = [
  { key: 'project_movement',     title: 'Движение проекта за неделю',  hint: '1 абзац (2-4 предложения): что движется на объекте сейчас.' },
  { key: 'weekly_done_brief',    title: '✓ Выполнено / зафиксировано', hint: 'Markdown-список с маркером "* **DD.MM** — событие/факт".' },
  { key: 'weekly_topics_brief',  title: 'Обобщение тем собраний',      hint: 'Связный абзац курсивом — что обсуждалось на собраниях.' },
  { key: 'weekly_upcoming_brief', title: '🔜 Предстоит',                hint: 'Markdown-список задач со сроками и исполнителями.' },
]

// Для обратной совместимости со старым кодом ниже:
const SECTION_FIELDS = MONTH_FIELDS

// Маппинг поля → какие lifecycle-категории важных событий показывать в его
// «контекст-сводке». Для полей без релевантной семантики (темы / задачи будущего) — [].
type LifecycleKind = 'resolved' | 'active_problems' | 'risk_no_followup'
const FIELD_LIFECYCLE_KINDS: Record<ReportFieldKey, LifecycleKind[]> = {
  // 6-секционная (week/month legacy):
  // В блоке «Движение» — все три типа (полная картина: что сделано, что в работе, факты)
  project_movement:       ['resolved', 'active_problems', 'risk_no_followup'],
  // Достижения: resolved (закрытые проблемы) + risk_no_followup (положительные
  // факты без задачи — «получено», «согласовано» — это тоже достижения).
  achievements:           ['resolved', 'risk_no_followup'],
  achievements_list:      ['resolved', 'risk_no_followup'],
  next_period_tasks:      [],
  next_period_tasks_list: [],
  // Риски: только реальный «незакрытый негатив». «risk_no_followup» не
  // обязательно негатив — LLM сам различает по title (см. промпт).
  risks:                  ['resolved', 'active_problems', 'risk_no_followup'],
  // Weekly v3:
  weekly_done_brief:      ['resolved', 'risk_no_followup'],
  weekly_topics_brief:    [],
  weekly_upcoming_brief:  ['active_problems'],
}

const LIFECYCLE_LABELS: Record<LifecycleKind, { icon: string; label: string; color: string }> = {
  resolved:         { icon: '✓',  label: 'Решено за период',                color: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  active_problems:  { icon: '🔓', label: 'В работе (есть задача)',           color: 'bg-amber-50 text-amber-800 border-amber-200' },
  // Эта категория — важные ФАКТЫ без задачи-followup. НЕ обязательно негативные!
  // «Получены ТУ», «согласован вариант», «утверждены показатели» — позитивные/
  // нейтральные. LLM должен использовать их как факты для нарратива, не как
  // автоматические риски.
  risk_no_followup: { icon: '📌', label: 'Важные факты без задачи',          color: 'bg-sky-50 text-sky-800 border-sky-200' },
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [report, setReport] = useState<Report | null>(null)
  const [sections, setSections] = useState<Section[]>([])
  const [stats, setStats] = useState<SectionStats[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // dirty[sectionId][field] = string draft, если есть несохранённые правки
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<string, string>>>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [finalizing, setFinalizing] = useState(false)

  // Общая сводка по проекту (reports.summary_md)
  const [summaryDraft, setSummaryDraft] = useState('')
  const [summaryDirty, setSummaryDirty] = useState(false)
  const [summaryGenerating, setSummaryGenerating] = useState(false)
  const [summarySaving, setSummarySaving] = useState(false)

  useEffect(() => { load() }, [id])

  // load(silent=true) — обновляет данные без перерисовки всей страницы в режиме
  // "Загрузка…". Используется кнопками 🔄 в сводках контекста.
  async function load(silent = false) {
    if (!silent) setLoading(true)
    setError('')
    const [rRes, sRes] = await Promise.all([
      fetch(`/api/reports/${id}`).then((r) => r.json()),
      fetch(`/api/reports/${id}/stats`).then((r) => r.json()),
    ])
    if (rRes.error) {
      setError(rRes.error)
      if (!silent) setLoading(false)
      return
    }
    setReport(rRes.report)
    setSections(rRes.sections || [])
    setStats(sRes.stats || [])
    setSummaryDraft(rRes.report?.summary_md ?? '')
    setSummaryDirty(false)
    setDrafts({})
    if (!silent) setLoading(false)
  }

  // Refresh контекста без полного «Загрузка…» — для кнопок 🔄 в сводках
  const [refreshingContext, setRefreshingContext] = useState(false)
  // GIS-данные для печатной формы (общий план комплекса).
  // Загружаются один раз и шерятся между всеми ObjectSchema-блоками отчёта.
  const [geoData, setGeoData] = useState<MapGeoData | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/reports/map/geojson')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setGeoData(data as MapGeoData)
      } catch { /* tolerate */ }
    })()
    return () => { cancelled = true }
  }, [])
  async function refreshContext() {
    setRefreshingContext(true)
    try { await load(true) } finally { setRefreshingContext(false) }
  }

  // Активная закладка объекта (для навигации без прокрутки).
  // null = «все объекты» (для печати/обзора).
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null)
  // При печати — сбрасываем активный таб, чтобы все секции попали в DOM (и на бумагу).
  useEffect(() => {
    const beforePrint = () => setActiveObjectId(null)
    window.addEventListener('beforeprint', beforePrint)
    return () => window.removeEventListener('beforeprint', beforePrint)
  }, [])

  async function generateSummary() {
    setSummaryGenerating(true)
    const res = await fetch(`/api/reports/${id}/summary/generate`, { method: 'POST' })
    setSummaryGenerating(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  async function saveSummary() {
    if (!summaryDirty) return
    setSummarySaving(true)
    const res = await fetch(`/api/reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary_md: summaryDraft }),
    })
    setSummarySaving(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    setSummaryDirty(false)
    await load()
  }

  function setDraft(sectionId: string, field: string, value: string) {
    setDrafts((prev) => ({
      ...prev,
      [sectionId]: { ...(prev[sectionId] ?? {}), [field]: value },
    }))
  }

  function getValue(s: Section, field: keyof Section): string {
    const draft = drafts[s.id]?.[field as string]
    if (draft !== undefined) return draft
    return ((s[field] as string) ?? '')
  }

  function isDirty(s: Section): boolean {
    return Boolean(drafts[s.id] && Object.keys(drafts[s.id]).length > 0)
  }

  async function saveSection(s: Section) {
    if (!isDirty(s)) return
    setSavingId(s.id)
    const res = await fetch(`/api/reports/${id}/sections/${s.object_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drafts[s.id] ?? {}),
    })
    setSavingId(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  // Полная регенерация секции одного объекта (все 6 полей)
  async function generateSection(s: Section) {
    setGeneratingId(s.id)
    const res = await fetch(`/api/reports/${id}/sections/${s.object_id}/generate`, {
      method: 'POST',
    })
    setGeneratingId(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  // Toggle: включать ли финансовые события в генерацию (LLM-инструкция).
  // Применяется при последующих ✨-генерациях; уже сохранённый текст не трогает.
  async function toggleIncludeFinancials() {
    if (!report) return
    const newVal = !report.include_financials
    const res = await fetch(`/api/reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_financials: newVal }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  // Сохранение llm_hint объекта: «приоритетный контекст от владельца» для LLM.
  // Не выводится в финальный отчёт. См. generateSection.ts → ownerHintBlock.
  const [llmHintDrafts, setLlmHintDrafts] = useState<Record<string, string>>({})
  const [llmHintSaving, setLlmHintSaving] = useState<string | null>(null)
  async function saveLlmHint(objectId: string, value: string) {
    setLlmHintSaving(objectId)
    const res = await fetch(`/api/objects/${objectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm_hint: value }),
    })
    setLlmHintSaving(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    setLlmHintDrafts((d) => {
      const next = { ...d }
      delete next[objectId]
      return next
    })
    await load()
  }

  // Generation of one field of one section (for ✨ buttons next to each subitem)
  const [genFieldKey, setGenFieldKey] = useState<string | null>(null)
  async function generateField(s: Section, field: ReportFieldKey) {
    const key = `${s.id}|${field}`
    setGenFieldKey(key)
    const res = await fetch(`/api/reports/${id}/sections/${s.object_id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: [field] }),
    })
    setGenFieldKey(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  async function generateAll() {
    if (!confirm(`Сгенерировать LLM все ${sections.length} разделов? Это займёт несколько минут.`)) return
    setBulkRunning(true)
    for (const s of sections) {
      setGeneratingId(s.id)
      try {
        await fetch(`/api/reports/${id}/sections/${s.object_id}/generate`, { method: 'POST' })
      } catch {
        // продолжаем — не падаем на одной ошибке
      }
    }
    setGeneratingId(null)
    setBulkRunning(false)
    await load()
  }

  async function finalize() {
    if (!confirm('Финализировать отчёт? После этого правки будут заблокированы.')) return
    setFinalizing(true)
    const res = await fetch(`/api/reports/${id}/finalize`, { method: 'POST' })
    setFinalizing(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await load()
  }

  async function deleteReport() {
    if (!confirm('Удалить отчёт целиком? Все разделы тоже удалятся.')) return
    const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    router.push('/reports')
  }

  if (loading) return <div className="max-w-5xl mx-auto p-6">Загрузка…</div>
  if (error) return <div className="max-w-5xl mx-auto p-6 text-red-600">{error}</div>
  if (!report) return null

  // control-отчёт (Справка ТЗ) рендерится отдельным компонентом
  if (report.period_type === 'control') {
    return (
      <ControlReportView
        report={report as unknown as ControlReport}
        sections={sections as unknown as ControlSection[]}
        reload={load}
      />
    )
  }

  // короткая справка (утверждённые варианты) — отдельный компонент
  if (report.period_type === 'short') {
    return (
      <ShortReportView
        report={report as unknown as ShortReport}
        sections={sections as unknown as ShortSection[]}
        reload={load}
      />
    )
  }

  // отчёт по договору ТЗ (проектного уровня) — отдельный компонент
  if (report.period_type === 'contract') {
    return (
      <ContractReportView
        report={report as unknown as ContractReport}
        reload={load}
      />
    )
  }

  const isFinal = report.status === 'final'

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-2">
        <Link href="/reports" className="text-sm text-blue-600 hover:underline">← К списку отчётов</Link>
      </div>
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          {(() => {
            // Расширенный титул: «Отчёт еженедельный за период с 13 по 19 мая 2026 года»
            // + «По комплексу объектов: Золотые Пески России»
            const kind = report.period_type === 'week' ? 'еженедельный' : 'ежемесячный'
            const phrase = formatPeriodPhrase(new Date(report.period_start), new Date(report.period_end), report.period_type)
            const scopeObjects = sections
              .map((s) => s.object ? { id: s.object_id, code: s.object.code, current_name: s.object.current_name } : null)
              .filter((x): x is { id: string; code: string; current_name: string } => Boolean(x))
            const scopeLabel = formatScopeLabel(scopeObjects)
            return (
              <>
                <h1 className="text-2xl font-bold leading-tight">
                  Отчёт {kind} за период {phrase}
                </h1>
                <p className="text-base text-gray-700 mt-1">{scopeLabel}</p>
              </>
            )
          })()}
          <p className="text-xs text-gray-500 mt-1">
            {formatDate(report.period_start)} — {formatDate(report.period_end)} · разделов: {sections.length}
          </p>
          {isFinal && (
            <p className="text-sm text-green-700 mt-1 font-medium">
              ✅ Финализирован {formatDate(report.finalized_at)}
            </p>
          )}
          {!isFinal && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 mt-2 cursor-pointer hover:text-gray-900 no-print">
              <input
                type="checkbox"
                checked={report.include_financials}
                onChange={toggleIncludeFinancials}
                className="rounded"
              />
              <span>Включать <strong>финансовые события</strong> в LLM-генерацию</span>
              <span className="text-xs text-gray-400">
                ({report.include_financials ? 'будут включены' : 'игнорируются'})
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {!isFinal && (
            <button
              onClick={generateAll}
              disabled={bulkRunning}
              className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50"
            >
              {bulkRunning ? '⏳ Генерируется…' : '✨ Сгенерировать всё'}
            </button>
          )}
          <a
            href={`/api/reports/${id}/render?format=md`}
            className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50"
            download
          >
            ⬇ Скачать .md
          </a>
          <a
            href={`/api/reports/${id}/render?format=docx`}
            className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50"
            download
          >
            📄 Скачать WORD
          </a>
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800"
          >
            🖨️ Печать
          </button>
          {!isFinal && (
            <>
              <button
                onClick={finalize}
                disabled={finalizing}
                className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
              >
                🔒 Финализировать
              </button>
              <button
                onClick={deleteReport}
                className="px-3 py-1.5 bg-white border border-red-300 text-red-700 text-sm rounded hover:bg-red-50"
              >
                Удалить
              </button>
            </>
          )}
        </div>
      </div>

      {/* Общая сводка по проекту (LLM на основе всех секций) */}
      <article className="bg-emerald-50/40 rounded shadow border border-emerald-200 p-5 mb-6">
        <header className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-emerald-900">📊 Общая сводка периода</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Агрегат по всему проекту. Генерируется LLM после заполнения секций по объектам.
            </p>
          </div>
          {!isFinal && (
            <div className="flex gap-2 no-print">
              <button
                onClick={generateSummary}
                disabled={summaryGenerating}
                className="px-3 py-1 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
              >
                {summaryGenerating ? '⏳ Формируется…' : '✨ Сгенерировать сводку'}
              </button>
              {summaryDirty && (
                <button
                  onClick={saveSummary}
                  disabled={summarySaving}
                  className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {summarySaving ? '💾 Сохранение…' : '💾 Сохранить'}
                </button>
              )}
            </div>
          )}
        </header>
        {isFinal ? (
          report.summary_md ? (
            <div data-color-mode="light">
              <MDPreview source={report.summary_md} />
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">Общая сводка не сформирована.</p>
          )
        ) : (
          <div data-color-mode="light">
            <MDEditor
              value={summaryDraft}
              onChange={(v) => {
                setSummaryDraft(v ?? '')
                setSummaryDirty((v ?? '') !== (report.summary_md ?? ''))
              }}
              height={400}
              preview="live"
              visibleDragbar={false}
            />
          </div>
        )}
      </article>

      {/* Закладки по объектам — навигация без прокрутки. При печати скрыты,
          все секции рендерятся в DOM (CSS .screen-hidden показывает их). */}
      {sections.length > 1 && (
        <div className="no-print mb-4 sticky top-0 z-10 bg-gray-50 border-b border-gray-200 -mx-6 px-6 py-2 overflow-x-auto">
          <div className="flex gap-1 flex-nowrap">
            <button
              onClick={() => setActiveObjectId(null)}
              className={`px-3 py-1 rounded text-xs whitespace-nowrap border ${
                activeObjectId === null
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
              }`}
              title="Показать все объекты — для прокрутки и печати"
            >
              📑 Все ({sections.length})
            </button>
            {sections.map((s) => {
              if (!s.object) return null
              const active = activeObjectId === s.object_id
              // Маркеры наличия событий для tab
              const lc = s.lifecycle_events
              const hasResolved = (lc?.resolved.length ?? 0) > 0
              const hasActive = (lc?.active_problems.length ?? 0) > 0
              const hasRisk = (lc?.risk_no_followup.length ?? 0) > 0
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveObjectId(s.object_id)}
                  className={`px-3 py-1 rounded text-xs whitespace-nowrap border flex items-center gap-1 ${
                    active
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                  }`}
                  title={s.object?.current_name ?? ''}
                >
                  <span className="font-mono">{s.object?.code}</span>
                  {hasResolved && <span title="есть resolved" className={active ? 'text-emerald-200' : 'text-emerald-600'}>✓</span>}
                  {hasActive && <span title="active problems" className={active ? 'text-amber-200' : 'text-amber-600'}>🔓</span>}
                  {hasRisk && <span title="risks without followup" className={active ? 'text-red-200' : 'text-red-600'}>🔴</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {sections.map((s) => {
          if (!s.object) return null
          // Tab-фильтр: если выбран конкретный объект, остальные не рендерим.
          // При печати beforeprint-листенер сбрасывает activeObjectId=null,
          // поэтому в бумагу попадают все.
          if (activeObjectId !== null && activeObjectId !== s.object_id) return null
          const dirty = isDirty(s)
          const objStats = stats.find((st) => st.object_id === s.object_id)
          return (
            <article
              key={s.id}
              className="object-report bg-white rounded shadow border border-gray-200 p-6"
            >
              {/* Титульный лист объекта — ТОЛЬКО при печати. Идёт ПЕРВЫМ
                  листом объекта, ПЕРЕД содержанием (п.1.1…). Вверху —
                  «Название объекта» (как на листе с п.1.1) + площадь участка,
                  ниже SVG-схема комплекса с красным выделением участка.
                  Рендерим ВСЕГДА (s.object гарантирован выше): даже если гео
                  ещё не загрузилось — титульный лист с названием будет у
                  каждого объекта. Схему/площадь показываем при наличии geoData. */}
              {s.object && (
                <div className="print-only print-page-break-after object-title-page">
                  <div className="mb-3">
                    <h1 className="text-2xl font-bold text-gray-900">
                      <ObjectTitle code={s.object.code} currentName={s.object.current_name} />
                    </h1>
                    {s.object.aliases && s.object.aliases.length > 0 && (
                      <p className="text-xs text-gray-500 mt-0.5 italic">
                        {s.object.aliases.join(', ')}
                      </p>
                    )}
                    {(() => {
                      const areaM2 = geoData ? getObjectAreaM2(geoData, s.object.code) : 0
                      if (areaM2 <= 0) return null
                      return (
                        <p className="text-sm text-gray-700 mt-1">
                          Площадь участка: <strong>{Math.round(areaM2).toLocaleString('ru-RU')} м²</strong>
                        </p>
                      )
                    })()}
                  </div>
                  {/* Обложка объекта: PNG из Storage report-covers/<номер>.png,
                      где номер = префикс кода объекта (001, 101, 301…).
                      При отсутствии файла — фолбэк на SVG-схему. */}
                  <ObjectCover
                    code={s.object.code}
                    objectName={s.object.current_name}
                    geoData={geoData}
                  />
                </div>
              )}
              <header className="border-b pb-3 mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">
                    <ObjectTitle code={s.object.code} currentName={s.object.current_name} />
                  </h2>
                  {s.object.aliases && s.object.aliases.length > 0 && (
                    <p className="text-xs text-gray-500 mt-0.5 italic">
                      {s.object.aliases.join(', ')}
                    </p>
                  )}
                  {s.object.contractor && (
                    <p className="text-xs text-gray-500 mt-0.5">Подрядчик: {s.object.contractor}</p>
                  )}
                </div>
                <div className="flex gap-2 no-print">
                  {!isFinal && (
                    <>
                      <button
                        onClick={() => generateSection(s)}
                        disabled={generatingId === s.id || bulkRunning}
                        className="px-3 py-1 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {generatingId === s.id ? '⏳' : '✨'} Сгенерировать
                      </button>
                      {dirty && (
                        <button
                          onClick={() => saveSection(s)}
                          disabled={savingId === s.id}
                          className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          {savingId === s.id ? '💾' : '💾'} Сохранить
                        </button>
                      )}
                    </>
                  )}
                </div>
              </header>

              {objStats && (
                <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <StatCard
                    label="Задачи закрыты"
                    value={objStats.tasks_done}
                    sub={`за период`}
                    color="text-green-700"
                  />
                  <StatCard
                    label="Активны (на конец периода)"
                    value={objStats.tasks_active}
                    sub={objStats.tasks_overdue > 0 ? `${objStats.tasks_overdue} просрочено к ${formatDate(report.period_end)}` : 'без просрочек на конец периода'}
                    color={objStats.tasks_overdue > 0 ? 'text-red-600' : 'text-blue-700'}
                  />
                  <StatCard
                    label="События за период"
                    value={objStats.events_in_period}
                    sub={`+ ${objStats.events_next_period} плановых далее`}
                    color="text-gray-800"
                  />
                  <StatCard
                    label="Темы обсуждений"
                    value={objStats.topics_recent}
                    sub={`±2 нед.`}
                    color="text-gray-700"
                  />
                </div>
              )}

              {/* Метаданные объекта: блоки по подрядчикам.
                  Структура внутри каждого блока: имя подрядчика → список договоров →
                  per-contractor статистика задач (на этом объекте) внизу.
                  Группа «Без договора» (contractor_entity_id=null) скрыта —
                  отчёт ведётся в разрезе объекта, а не договора. Привязка задач
                  к подрядчикам пока не полная, акцентировать внимание не нужно. */}
              {objStats && objStats.contractors.filter((g) => g.contractor_entity_id).length > 0 && (
                <div className="mb-4 space-y-2">
                  {objStats.contractors.filter((g) => g.contractor_entity_id).map((g) => (
                    <div key={g.contractor_entity_id ?? 'orphan'} className="bg-gray-50 border border-gray-200 rounded p-3">
                      <div className="text-sm font-semibold text-gray-800 mb-2">
                        👤 {g.contractor_name}
                      </div>

                      {g.contracts.length > 0 ? (
                        <div className="space-y-1.5 text-xs mb-2">
                          {g.contracts.map((c) => (
                            <div key={c.id} className="border-l-2 border-gray-300 pl-2 py-0.5">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="px-1.5 py-0 rounded bg-blue-100 text-blue-800 text-[10px] uppercase tracking-wider">
                                  {c.type}
                                </span>
                                {c.doc_number && (
                                  <span className="font-mono text-gray-500">№ {c.doc_number}</span>
                                )}
                                {c.signed_date && (
                                  <span className="text-gray-400">от {formatDate(c.signed_date)}</span>
                                )}
                              </div>
                              <div className="text-gray-800 mt-0.5">{c.title}</div>
                              <div className="text-gray-500 mt-0.5 text-[11px]">
                                <span className="text-gray-400">Заказчик:</span> {c.customer_name ?? '—'}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500 italic mb-2">
                          Договор по объекту не оформлен — задачи висят без привязки к подрядчику.
                        </p>
                      )}

                      <div className="text-xs text-gray-700 flex gap-3 flex-wrap pt-2 border-t border-gray-200" title="Срезы на конец отчётного периода">
                        <span>Закрыто за период: <strong className="text-green-700">{g.stats.tasks_done}</strong></span>
                        <span>Активны на конец: <strong className="text-blue-700">{g.stats.tasks_active}</strong></span>
                        <span>Просрочено на конец: <strong className={g.stats.tasks_overdue > 0 ? 'text-red-600' : 'text-gray-500'}>{g.stats.tasks_overdue}</strong></span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* «✓ Выполнено за отчётный период» — детерминированный блок:
                  закрытые задачи + resolved важные события.
                  В UI рендерится здесь (для удобства редактирования);
                  при печати — на отдельной странице после п.4 (см. ниже). */}
              <div className="no-print">
                <DonePeriodBlock section={s} />
              </div>

              {/* Warning: устаревший llm_hint (утверждает паузу при свежей активности) */}
              <StaleHintWarning
                section={s}
                reportPeriodStart={report.period_start}
                onSaved={load}
              />


              {/* Контекст для LLM (objects.llm_hint) — приоритетная подсказка
                  владельца, не выводится в финальный отчёт. */}
              {s.object && !isFinal && (() => {
                const draftValue = llmHintDrafts[s.object_id]
                const currentValue = draftValue !== undefined ? draftValue : (s.object.llm_hint ?? '')
                const dirty = draftValue !== undefined && draftValue !== (s.object.llm_hint ?? '')
                return (
                  <details className="no-print mb-4 bg-amber-50/40 border border-amber-200 rounded">
                    <summary className="px-3 py-2 text-sm font-medium text-amber-900 cursor-pointer hover:bg-amber-100 select-none">
                      📝 Контекст для LLM (не попадает в отчёт)
                      {(s.object.llm_hint ?? '').trim() && (
                        <span className="ml-2 text-xs text-amber-700">
                          ({(s.object.llm_hint ?? '').trim().length} симв.)
                        </span>
                      )}
                    </summary>
                    <div className="px-3 pb-3 pt-1 space-y-2">
                      <p className="text-xs text-gray-600">
                        Ключевые факты по объекту, которые LLM использует при генерации
                        разделов отчёта (особенно когда событий и задач мало). Не выводится
                        в финальный <code>.md</code> / <code>.docx</code>.
                      </p>
                      <textarea
                        value={currentValue}
                        onChange={(e) => setLlmHintDrafts((d) => ({ ...d, [s.object_id]: e.target.value }))}
                        rows={4}
                        placeholder="Например: «Объект на стадии формирования концепции массинга. Подрядчик начнёт работы с 1 июня. Главный риск — задержка ИРД от заказчика.»"
                        className="w-full px-3 py-2 border border-amber-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                      />
                      <div className="flex justify-end">
                        <button
                          onClick={() => saveLlmHint(s.object_id, currentValue)}
                          disabled={!dirty || llmHintSaving === s.object_id}
                          className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                        >
                          {llmHintSaving === s.object_id ? 'Сохранение…' : '💾 Сохранить контекст'}
                        </button>
                      </div>
                    </div>
                  </details>
                )
              })()}

              <div className="space-y-5">
                {/* Сначала рендерим поля без group (1, 4), затем 2 и 3 как группы. */}
                {(() => {
                  // Выбираем набор полей по типу отчёта: week → v3 (плоско),
                  // month → 6 полей legacy с группировкой 2.1/2.2/3.1/3.2.
                  const activeFields: FieldDef[] = report.period_type === 'week'
                    ? WEEKLY_V3_FIELDS_UI
                    : MONTH_FIELDS
                  // Группируем по f.group: undefined → одиночные, иначе 2/3
                  const groupOrder: Array<{ group?: string; fields: FieldDef[] }> = []
                  for (const f of activeFields) {
                    if (!f.group) {
                      groupOrder.push({ fields: [f] })
                    } else {
                      const last = groupOrder[groupOrder.length - 1]
                      if (last && last.group === f.group) last.fields.push(f)
                      else groupOrder.push({ group: f.group, fields: [f] })
                    }
                  }
                  return groupOrder.map((g, gi) => (
                    <div key={gi}>
                      {g.group && (
                        <h3 className="text-base font-bold text-gray-900 mb-2 mt-2">{g.group}</h3>
                      )}
                      <div className={g.group ? 'space-y-4 pl-3 border-l-2 border-emerald-200' : 'space-y-4'}>
                        {g.fields.map((f) => {
                          const fieldGenKey = `${s.id}|${f.key}`
                          const isGenThisField = genFieldKey === fieldGenKey
                          const fieldDirty = drafts[s.id]?.[f.key] !== undefined
                          const kinds = FIELD_LIFECYCLE_KINDS[f.key] ?? []
                          return (
                            <div key={f.key}>
                              {/* Сводка важных событий для этого блока — клик по событию открывает /events/{id}
                                  для прикрепления задачи. После правок — кнопка ✨ перегенерирует с новым контекстом. */}
                              <BlockContextEvents
                                kinds={kinds}
                                lifecycle={s.lifecycle_events}
                                onRefresh={refreshContext}
                                refreshing={refreshingContext}
                              />
                              <div className="flex items-baseline justify-between gap-2 mb-1">
                                <h4 className="text-sm font-semibold text-emerald-700 uppercase tracking-wider">
                                  {f.title}
                                </h4>
                                {!isFinal && (
                                  <div className="flex gap-2 no-print">
                                    <button
                                      onClick={() => generateField(s, f.key)}
                                      disabled={isGenThisField || generatingId === s.id || bulkRunning}
                                      title="Сгенерировать LLM только этот пункт"
                                      className="px-2 py-0.5 bg-emerald-600 text-white text-[11px] rounded hover:bg-emerald-700 disabled:opacity-50"
                                    >
                                      {isGenThisField ? '⏳' : '✨'}
                                    </button>
                                    {fieldDirty && (
                                      <button
                                        onClick={() => saveSection(s)}
                                        disabled={savingId === s.id}
                                        className="px-2 py-0.5 bg-blue-600 text-white text-[11px] rounded hover:bg-blue-700 disabled:opacity-50"
                                      >
                                        💾
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                              {isFinal ? (
                                (s[f.key] as string)?.trim() ? (
                                  <div data-color-mode="light" className="text-sm">
                                    <MDPreview source={s[f.key] as string} />
                                  </div>
                                ) : (
                                  <span className="text-sm text-gray-400 italic">— не заполнено —</span>
                                )
                              ) : (
                                <AutoGrowTextarea
                                  value={getValue(s, f.key as keyof Section)}
                                  onChange={(v) => setDraft(s.id, f.key, v)}
                                  placeholder="Пусто. Нажмите ✨ или впишите вручную."
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))
                })()}
              </div>

              {/* Печатный вариант «✓ Выполнено» — на отдельной странице
                  после п.4 (page-break-before: always через CSS).
                  ВАЖНО: рендерим обёртку с разрывом ТОЛЬКО если есть контент.
                  Иначе пустой div с page-break-before форсит лишнюю пустую
                  страницу («Пустой лист») перед разрывом самого объекта. */}
              {((s.tasks_done_in_period?.length ?? 0) > 0 ||
                (s.lifecycle_events?.resolved?.length ?? 0) > 0) && (
                <div className="print-only print-page-break-before">
                  <DonePeriodBlock section={s} />
                </div>
              )}

              {s.generated_at && (
                <p className="text-xs text-gray-400 mt-3 pt-3 border-t">
                  Последняя редакция раздела: {new Date(s.generated_at).toLocaleDateString('ru-RU', {
                    day: 'numeric', month: 'long', year: 'numeric',
                  })}
                </p>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: number; sub?: string; color: string }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded p-2">
      <div className="text-gray-500 uppercase tracking-wider text-[10px]">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-gray-400 text-[10px] mt-0.5">{sub}</div>}
    </div>
  )
}

// Сводка важных событий, влияющих на конкретный блок отчёта (выше LLM-поля).
// Каждое событие — кликабельное → открывает /events/{id} в новой вкладке,
// где можно прикрепить задачу (raised_from) или resolved_by-связь.
// После работы с событиями пользователь возвращается и нажимает ✨ — LLM получает
// обновлённый контекст и перегенерирует раздел.
function BlockContextEvents({
  kinds, lifecycle, onRefresh, refreshing,
}: {
  kinds: LifecycleKind[]
  lifecycle?: {
    resolved: LifecycleEventLite[]
    active_problems: LifecycleEventLite[]
    risk_no_followup: LifecycleEventLite[]
  }
  onRefresh?: () => void | Promise<void>
  refreshing?: boolean
}) {
  if (kinds.length === 0 || !lifecycle) return null
  const buckets = kinds.map((k) => ({ k, events: lifecycle[k] ?? [] }))
  const total = buckets.reduce((s, b) => s + b.events.length, 0)
  if (total === 0) return null

  return (
    <details className="no-print mb-2 bg-gray-50 border border-gray-200 rounded text-xs">
      <summary className="px-2 py-1 cursor-pointer hover:bg-gray-100 select-none flex items-center gap-2">
        <span className="text-gray-500">📌 Контекст для LLM:</span>
        {buckets.map((b) => b.events.length > 0 && (
          <span key={b.k} className={`px-1.5 py-0.5 rounded border ${LIFECYCLE_LABELS[b.k].color}`}>
            {LIFECYCLE_LABELS[b.k].icon} {LIFECYCLE_LABELS[b.k].label}: {b.events.length}
          </span>
        ))}
        {onRefresh && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()        // не разворачивать details
              e.stopPropagation()
              void onRefresh()
            }}
            disabled={refreshing}
            className="px-1.5 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 text-[11px]"
            title="Обновить список событий из БД (после привязки/закрытия задач)"
          >
            {refreshing ? '⏳' : '🔄'} Обновить
          </button>
        )}
        <span className="text-gray-400 ml-auto text-[10px]">
          клик по событию → редактор связей · после правок: 🔄 список · ✨ генерация
        </span>
      </summary>
      <div className="px-2 pb-2 pt-1 space-y-2">
        {buckets.map((b) => b.events.length > 0 && (
          <div key={b.k}>
            <div className="text-[11px] font-semibold text-gray-600 mb-1">
              {LIFECYCLE_LABELS[b.k].icon} {LIFECYCLE_LABELS[b.k].label} ({b.events.length})
            </div>
            <ul className="space-y-0.5">
              {b.events.slice(0, 12).map((e) => (
                <li key={e.id}>
                  <a
                    href={`/events/${e.id}`}
                    target="_blank"
                    rel="noopener"
                    className="block px-1.5 py-0.5 rounded hover:bg-white hover:shadow-sm border border-transparent hover:border-gray-200 text-gray-700"
                    title={`${e.title} — открыть в новой вкладке`}
                  >
                    {e.importance === 'critical' && <span className="text-red-600">★</span>}
                    {e.importance === 'high' && <span className="text-amber-600">★</span>}{' '}
                    {e.date && <span className="font-mono text-gray-500">[{e.date}]</span>}{' '}
                    <span className="text-gray-900">{e.title}</span>
                    {e.is_resolved && e.resolved_date && (
                      <span className="ml-1 text-emerald-700 text-[10px]">
                        ✓ решено {e.resolved_date}
                      </span>
                    )}
                    {!e.is_resolved && e.has_active_task && (
                      <span className="ml-1 text-amber-700 text-[10px]">
                        в работе: {e.task_count} задач{e.task_count === 1 ? 'а' : ''}
                      </span>
                    )}
                    {!e.is_resolved && e.task_count === 0 && (
                      <span className="ml-1 text-red-700 text-[10px]">
                        🔧 нет задачи-решения
                      </span>
                    )}
                  </a>
                  {/* Связанные задачи (raised_from-task) — для resolved-события каждая
                      закрытая задача = доп.положительный факт для отчёта. */}
                  {(e.related_tasks?.length ?? 0) > 0 && (
                    <ul className="ml-6 mt-0.5 mb-1 space-y-0.5">
                      {(e.related_tasks ?? []).map((t) => {
                        const isClosed = ['done', 'closed'].includes(t.status)
                        const isCancelled = t.status === 'cancelled'
                        return (
                          <li key={t.id}>
                            <a
                              href={`/tasks?open=${t.id}`}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded border border-transparent hover:bg-white hover:border-gray-200 text-[11px]"
                              title={`Задача ${t.code} — открыть на странице задач`}
                            >
                              <span className={
                                isClosed ? 'text-emerald-700' :
                                isCancelled ? 'text-gray-400' :
                                'text-amber-700'
                              }>
                                {isClosed ? '✓' : isCancelled ? '✗' : '⏳'}
                              </span>
                              <span className="font-mono text-gray-500">{t.code}</span>
                              <span className={isCancelled ? 'text-gray-400 line-through' : 'text-gray-700'}>
                                {t.title}
                              </span>
                              {isClosed && t.done_date && (
                                <span className="text-emerald-700 text-[10px]">
                                  закрыта {t.done_date}
                                </span>
                              )}
                            </a>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              ))}
              {b.events.length > 12 && (
                <li className="text-[10px] text-gray-400 px-1.5">
                  … и ещё {b.events.length - 12}. Полный список в LLM-контексте.
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </details>
  )
}

// Блок «✓ Выполнено за отчётный период» — детерминированный (из БД),
// показывает закрытые задачи + resolved важные события. Виден в UI и при печати.
function DonePeriodBlock({ section }: { section: Section }) {
  const tasks = section.tasks_done_in_period ?? []
  const resolvedEvents = section.lifecycle_events?.resolved ?? []
  if (tasks.length === 0 && resolvedEvents.length === 0) return null
  const obj = section.object

  return (
    <section className="mb-4 bg-emerald-50/40 border border-emerald-200 rounded p-3">
      {/* Титул на печатной форме (схема и название объекта вынесены в
          титульный лист — см. рендер перед article.object-report). */}
      {obj && (
        <h2 className="print-only text-lg font-bold text-gray-900 mb-2 pb-2 border-b border-emerald-300">
          По объекту <ObjectTitle code={obj.code} currentName={obj.current_name} /> за отчётный период
        </h2>
      )}
      <div className="text-sm font-semibold text-emerald-900 mb-2">
        ✓ За отчётный период выполнено
      </div>
      <ul className="space-y-1 text-sm">
        {/* Сначала resolved-проблемы (важные) — выделяем как ★ */}
        {resolvedEvents.map((e) => (
          <li key={`e-${e.id}`} className="text-gray-800">
            <span className="text-emerald-700 mr-1">★ ✓</span>
            {e.date && <span className="font-mono text-gray-500 text-xs">[{e.date}]</span>}{' '}
            <a
              href={`/events/${e.id}`}
              target="_blank"
              rel="noopener"
              className="text-gray-900 hover:underline"
              title="Открыть событие в новой вкладке"
            >
              {e.title}
            </a>
            {e.resolved_date && (
              <span className="ml-1 text-[11px] text-emerald-700">
                → решено {e.resolved_date}
              </span>
            )}
          </li>
        ))}
        {/* Затем обычные закрытые задачи */}
        {tasks.map((t) => (
          <li key={`t-${t.id}`} className="text-gray-700">
            <span className="text-emerald-700 mr-1">✓</span>
            <span className="font-mono text-gray-500 text-xs">[{t.done_date}]</span>{' '}
            <a
              href={`/tasks?open=${t.id}`}
              target="_blank"
              rel="noopener"
              className="hover:underline"
              title={`Задача ${t.code}`}
            >
              {t.title}
            </a>
            {t.assignee_org && (
              <span className="ml-1 text-[11px] text-gray-500">— {t.assignee_org}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-gray-500 mt-2 no-print">
        Список формируется автоматически из БД. ★ — закрытие важной проблемы
        (resolved event), ✓ — закрытая задача. Клик → карточка.
      </p>
    </section>
  )
}
