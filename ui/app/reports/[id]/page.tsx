'use client'

import { useEffect, useState, useRef, useLayoutEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { formatPeriodPhrase } from '@/lib/reports/periodHelpers'
import { formatScopeLabel } from '@/lib/reports/scopeLabel'
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
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={minRows}
      placeholder={placeholder}
      className="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none overflow-hidden"
    />
  )
}

type Report = {
  id: string
  period_type: 'week' | 'month'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  finalized_at: string | null
  summary_md: string | null
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
  project_movement: string | null
  achievements: string | null
  achievements_list: string | null
  next_period_tasks: string | null
  next_period_tasks_list: string | null
  risks: string | null
  generated_at: string
  model_used: string | null
  object: { code: string; current_name: string; contractor: string | null; active: boolean; llm_hint: string | null } | null
}

type ReportFieldKey = 'project_movement' | 'achievements' | 'achievements_list'
                    | 'next_period_tasks' | 'next_period_tasks_list' | 'risks'

// 6 контентных полей секции отчёта. Поля 2.1/2.2 и 3.1/3.2 группируются в UI.
type FieldDef = { key: ReportFieldKey; title: string; group?: string }
const SECTION_FIELDS: FieldDef[] = [
  { key: 'project_movement',       title: '1. Существующее движение проекта' },
  { key: 'achievements',           title: '2.1 Описание',        group: '2. Достижения за период' },
  { key: 'achievements_list',      title: '2.2 Основные пункты', group: '2. Достижения за период' },
  { key: 'next_period_tasks',      title: '3.1 Описание',        group: '3. Задачи наступающего периода' },
  { key: 'next_period_tasks_list', title: '3.2 Основные пункты', group: '3. Задачи наступающего периода' },
  { key: 'risks',                  title: '4. Риски' },
]

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

  async function load() {
    setLoading(true)
    setError('')
    const [rRes, sRes] = await Promise.all([
      fetch(`/api/reports/${id}`).then((r) => r.json()),
      fetch(`/api/reports/${id}/stats`).then((r) => r.json()),
    ])
    if (rRes.error) {
      setError(rRes.error)
      setLoading(false)
      return
    }
    setReport(rRes.report)
    setSections(rRes.sections || [])
    setStats(sRes.stats || [])
    setSummaryDraft(rRes.report?.summary_md ?? '')
    setSummaryDirty(false)
    setDrafts({})
    setLoading(false)
  }

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

      <div className="space-y-6">
        {sections.map((s) => {
          if (!s.object) return null
          const dirty = isDirty(s)
          const objStats = stats.find((st) => st.object_id === s.object_id)
          return (
            <article
              key={s.id}
              className="object-report bg-white rounded shadow border border-gray-200 p-6"
            >
              <header className="border-b pb-3 mb-4 flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">
                    {s.object.code} — {s.object.current_name}
                  </h2>
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
                  per-contractor статистика задач (на этом объекте) внизу. */}
              {objStats && objStats.contractors.length > 0 && (
                <div className="mb-4 space-y-2">
                  {objStats.contractors.map((g) => (
                    <div key={g.contractor_entity_id ?? 'orphan'} className="bg-gray-50 border border-gray-200 rounded p-3">
                      <div className="text-sm font-semibold text-gray-800 mb-2">
                        {g.contractor_entity_id ? '👤' : '⚠️'} {g.contractor_name}
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

              {/* Контекст для LLM (objects.llm_hint) — приоритетная подсказка
                  владельца, не выводится в финальный отчёт. */}
              {s.object && !isFinal && (() => {
                const draftValue = llmHintDrafts[s.object_id]
                const currentValue = draftValue !== undefined ? draftValue : (s.object.llm_hint ?? '')
                const dirty = draftValue !== undefined && draftValue !== (s.object.llm_hint ?? '')
                return (
                  <details className="mb-4 bg-amber-50/40 border border-amber-200 rounded">
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
                  // Группируем по f.group: undefined → одиночные, иначе 2/3
                  const groupOrder: Array<{ group?: string; fields: FieldDef[] }> = []
                  for (const f of SECTION_FIELDS) {
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
                          return (
                            <div key={f.key}>
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

              {s.generated_at && (
                <p className="text-xs text-gray-400 mt-3 pt-3 border-t">
                  Последняя генерация: {new Date(s.generated_at).toLocaleString('ru-RU')}
                  {s.model_used && ` · ${s.model_used}`}
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
