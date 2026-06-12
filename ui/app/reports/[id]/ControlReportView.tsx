'use client'

import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { detectStaleLlmHint } from '@/lib/reports/detectStaleLlmHint'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })
const MDPreview = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default.Markdown),
  { ssr: false },
)

// Auto-growing textarea (без max-height — растёт по содержимому)
function AutoGrowTextarea({
  value, onChange, placeholder, minRows = 3,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minRows?: number
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
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
      className="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-purple-400 resize-none overflow-hidden"
    />
  )
}

export type ControlReport = {
  id: string
  period_type: 'control'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  finalized_at: string | null
  preamble: string | null
  include_financials: boolean
}

export type ControlSection = {
  id: string
  object_id: string
  narrative: string | null
  contract_summary: string | null
  decisions: string | null
  next_period_tasks: string | null
  priority_group: 'priority' | 'secondary' | null
  tep_deadline: string | null
  generated_at: string
  model_used: string | null
  object: {
    code: string; current_name: string;
    contractor: string | null; active: boolean;
    llm_hint: string | null;
    aliases?: string[];
  } | null
  contracts?: ControlSectionContract[]
  recent_activity?: { tasks_active: number; topics_30d: number; events_30d: number }
  hint_effective_at_reference?: boolean
}

export type ControlSectionContract = {
  id: string
  type: string
  title: string
  doc_number: string | null
  signed_date: string | null
  contractor_name: string | null
  current_stage_id: string | null
  current_stage_number: number | null
  current_stage_name: string | null
  stages?: ControlContractStage[]
}

export type ControlContractStage = {
  id: string
  stage_number: number
  stage_name: string
  sort_order: number
  status: 'done' | 'current' | 'upcoming'
}

type ControlFieldKey = 'narrative' | 'contract_summary' | 'decisions' | 'next_period_tasks'

const CONTROL_FIELDS: Array<{ key: ControlFieldKey; title: string; hint: string }> = [
  { key: 'narrative',        title: '1. Работы отчётного периода',   hint: 'Что сделано по объекту за последнюю неделю (7 дней до даты справки): свежие события, закрытые задачи, решённые проблемы. Сухо, 1 абзац.' },
  { key: 'contract_summary', title: '2. Этапы договора со сроками', hint: 'Список этапов (Массинг / ОПР / МОП) с фактическими и плановыми датами.' },
  { key: 'decisions',        title: '3. Общее состояние работ',       hint: 'Интегральная картина СОСТОЯНИЯ объекта: что завершено/получено/решено, положение по договору и сроку ТЭП. Без задач и планов. Сухо, 1 абзац.' },
  { key: 'next_period_tasks', title: '4. Текущие задачи и планы',     hint: 'Что в работе (задачи имеют срок исполнения), ближайшие контрольные точки, идущие/планируемые тендеры и работы. Сухо, 1 абзац.' },
]

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Форматированный титул объекта:
//   "102_ГОСТИНИЦА_800" + "Гостиница 4*..." →
//     <span class="obj-number">102</span> ГОСТИНИЦА 800 — Гостиница 4*...
// Номер крупнее (CSS class .obj-number = 1.15em), остальное — обычный текст,
// подчёркивания заменены на пробелы.
export function ObjectTitle({
  code, currentName, className = '',
}: { code: string; currentName?: string | null; className?: string }) {
  const m = code.match(/^(\d+)[_\s]+(.+)$/)
  const number = m?.[1] ?? code
  const rest = m?.[2] ? m[2].replace(/_/g, ' ') : ''
  return (
    <span className={className}>
      <span className="obj-number font-bold">{number}</span>
      {rest && <span> {rest}</span>}
      {currentName && <span className="font-normal text-gray-700"> — {currentName}</span>}
    </span>
  )
}

export default function ControlReportView({
  report: initialReport,
  sections: initialSections,
  reload,
}: {
  report: ControlReport
  sections: ControlSection[]
  reload: () => Promise<void>
}) {
  const router = useRouter()
  const [report, setReport] = useState(initialReport)
  const [sections, setSections] = useState(initialSections)
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<string, string>>>>({})
  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, 'priority' | 'secondary' | null>>({})
  const [deadlineDrafts, setDeadlineDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [preambleDraft, setPreambleDraft] = useState(initialReport.preamble ?? '')
  const [preambleDirty, setPreambleDirty] = useState(false)
  const [preambleSaving, setPreambleSaving] = useState(false)
  const [preambleGenerating, setPreambleGenerating] = useState(false)

  // Синхронизация local state когда parent reload пришёл со свежими props.
  // Драфты сохраняем — пользователь мог уже править textarea параллельно
  // загрузке (после нажатия «Сохранить» драфт уже отправлен, locales очистится
  // в saveSection отдельно).
  useEffect(() => {
    setReport(initialReport)
    setSections(initialSections)
    // Подтягиваем preamble только если пользователь его не правил руками
    setPreambleDraft((prev) => preambleDirty ? prev : (initialReport.preamble ?? ''))
  }, [initialReport, initialSections, preambleDirty])

  const isFinal = report.status === 'final'

  function getValue(s: ControlSection, field: ControlFieldKey): string {
    const d = drafts[s.id]?.[field]
    if (d !== undefined) return d
    return (s[field] ?? '')
  }
  function setDraft(sectionId: string, field: string, value: string) {
    setDrafts((prev) => ({
      ...prev, [sectionId]: { ...(prev[sectionId] ?? {}), [field]: value },
    }))
  }
  function isDirty(s: ControlSection): boolean {
    const textDirty = Boolean(drafts[s.id] && Object.keys(drafts[s.id]).length > 0)
    const prioDirty = s.id in priorityDrafts && priorityDrafts[s.id] !== s.priority_group
    const deadDirty = s.id in deadlineDrafts && deadlineDrafts[s.id] !== (s.tep_deadline ?? '')
    return textDirty || prioDirty || deadDirty
  }
  function getPriority(s: ControlSection): 'priority' | 'secondary' | null {
    return s.id in priorityDrafts ? priorityDrafts[s.id] : s.priority_group
  }
  function getDeadline(s: ControlSection): string {
    return s.id in deadlineDrafts ? deadlineDrafts[s.id] : (s.tep_deadline ?? '')
  }

  async function saveSection(s: ControlSection) {
    if (!isDirty(s)) return
    setSavingId(s.id)
    const payload: Record<string, unknown> = { ...(drafts[s.id] ?? {}) }
    if (s.id in priorityDrafts) payload.priority_group = priorityDrafts[s.id]
    if (s.id in deadlineDrafts) payload.tep_deadline = deadlineDrafts[s.id] || null
    const res = await fetch(`/api/reports/${report.id}/sections/${s.object_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setSavingId(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    // Очищаем драфты ЭТОЙ секции после успешного сохранения
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[s.id]
      return next
    })
    setPriorityDrafts((prev) => {
      const next = { ...prev }
      delete next[s.id]
      return next
    })
    setDeadlineDrafts((prev) => {
      const next = { ...prev }
      delete next[s.id]
      return next
    })
    await reload()
  }

  async function generateSection(s: ControlSection, fields?: ControlFieldKey[]) {
    setGeneratingId(s.id)
    const res = await fetch(`/api/reports/${report.id}/sections/${s.object_id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: fields ? JSON.stringify({ fields }) : '',
    })
    setGeneratingId(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await reload()
  }

  async function generateAll() {
    if (!confirm(`Сгенерировать LLM по всем ${sections.length} объектам? Несколько минут.`)) return
    setBulkRunning(true)
    for (const s of sections) {
      setGeneratingId(s.id)
      try {
        await fetch(`/api/reports/${report.id}/sections/${s.object_id}/generate`, { method: 'POST' })
      } catch { /* skip */ }
    }
    setGeneratingId(null)
    setBulkRunning(false)
    await reload()
  }

  async function generatePreamble(mode: 'template' | 'llm') {
    setPreambleGenerating(true)
    const res = await fetch(`/api/reports/${report.id}/preamble?mode=${mode}`, { method: 'POST' })
    setPreambleGenerating(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await reload()
  }

  async function savePreamble() {
    if (!preambleDirty) return
    setPreambleSaving(true)
    const res = await fetch(`/api/reports/${report.id}/preamble`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preamble: preambleDraft }),
    })
    setPreambleSaving(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    setPreambleDirty(false)
    await reload()
  }

  async function finalize() {
    if (!confirm('Финализировать Справку ТЗ? После — правки заблокированы.')) return
    setFinalizing(true)
    const res = await fetch(`/api/reports/${report.id}/finalize`, { method: 'POST' })
    setFinalizing(false)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await reload()
  }

  async function deleteReport() {
    if (!confirm('Удалить Справку ТЗ?')) return
    const res = await fetch(`/api/reports/${report.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    router.push('/reports')
  }

  async function toggleIncludeFinancials() {
    const newVal = !report.include_financials
    const res = await fetch(`/api/reports/${report.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_financials: newVal }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await reload()
  }

  // Группировка по priority_group
  const priority = sections.filter((s) => getPriority(s) === 'priority')
  const secondary = sections.filter((s) => getPriority(s) !== 'priority')

  const snap = new Date(report.period_start).toLocaleDateString('ru-RU', {
    day: '2-digit', month: 'long', year: 'numeric',
  })

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-2 no-print">
        <Link href="/reports" className="text-sm text-blue-600 hover:underline">← К списку отчётов</Link>
      </div>

      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold leading-tight">
            📋 Справка технического заказчика на {snap}
          </h1>
          <p className="text-base text-gray-700 mt-1">
            Туристический комплекс «Золотые пески России»
          </p>
          <p className="text-xs text-gray-500 mt-1 no-print">
            Снимок состояния проекта · разделов: {sections.length} ·
            первоочередных: {priority.length} · прочих: {secondary.length}
          </p>
          {isFinal && (
            <p className="text-sm text-green-700 mt-1 font-medium">
              ✅ Финализирована {formatDate(report.finalized_at)}
            </p>
          )}
          {!isFinal && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 mt-2 cursor-pointer hover:text-gray-900 no-print">
              <input type="checkbox" checked={report.include_financials} onChange={toggleIncludeFinancials} className="rounded" />
              <span>Включать <strong>финансовые события</strong> в LLM-генерацию</span>
              <span className="text-xs text-gray-400">
                ({report.include_financials ? 'включены' : 'игнорируются'})
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-2 flex-wrap no-print">
          {!isFinal && (
            <button
              onClick={generateAll}
              disabled={bulkRunning}
              className="px-3 py-1.5 bg-purple-600 text-white text-sm rounded hover:bg-purple-700 disabled:opacity-50"
            >
              {bulkRunning ? '⏳ Генерация…' : '✨ Сгенерировать всё'}
            </button>
          )}
          <a href={`/api/reports/${report.id}/render?format=md`} className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50" download>⬇ .md</a>
          <a href={`/api/reports/${report.id}/render?format=docx`} className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50" download>📄 WORD</a>
          <button onClick={() => window.print()} className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800">🖨️ Печать</button>
          {!isFinal && (
            <>
              <button onClick={finalize} disabled={finalizing} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">🔒 Финализировать</button>
              <button onClick={deleteReport} className="px-3 py-1.5 bg-white border border-red-300 text-red-700 text-sm rounded hover:bg-red-50">Удалить</button>
            </>
          )}
        </div>
      </div>

      {/* Преамбула */}
      <article className="report-preamble-block bg-purple-50/40 rounded shadow border border-purple-200 p-5 mb-6">
        <header className="flex items-baseline justify-between gap-3 mb-3 flex-wrap no-print">
          <div>
            <h2 className="text-lg font-bold text-purple-900">📝 Преамбула</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Общее вводное описание проекта и перечень объектов (для шапки документа).
            </p>
          </div>
          {!isFinal && (
            <div className="flex gap-2 no-print">
              <button
                onClick={() => generatePreamble('template')}
                disabled={preambleGenerating}
                className="px-3 py-1 bg-purple-600 text-white text-xs rounded hover:bg-purple-700 disabled:opacity-50"
                title="Детерминированный шаблон из списка объектов"
              >
                {preambleGenerating ? '⏳' : '📋'} Из шаблона
              </button>
              <button
                onClick={() => generatePreamble('llm')}
                disabled={preambleGenerating}
                className="px-3 py-1 bg-purple-700 text-white text-xs rounded hover:bg-purple-800 disabled:opacity-50"
                title="Связный текст через LLM"
              >
                {preambleGenerating ? '⏳' : '✨'} LLM
              </button>
              {preambleDirty && (
                <button onClick={savePreamble} disabled={preambleSaving}
                  className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50">
                  {preambleSaving ? '💾 Сохранение…' : '💾 Сохранить'}
                </button>
              )}
            </div>
          )}
        </header>
        {isFinal ? (
          report.preamble ? (
            <div data-color-mode="light"><MDPreview source={report.preamble} /></div>
          ) : (
            <p className="text-sm text-gray-400 italic">Преамбула не заполнена.</p>
          )
        ) : (
          <>
            {/* Экран — MD-редактор с live preview (два окна) */}
            <div data-color-mode="light" className="no-print">
              <MDEditor
                value={preambleDraft}
                onChange={(v) => {
                  setPreambleDraft(v ?? '')
                  setPreambleDirty((v ?? '') !== (report.preamble ?? ''))
                }}
                height={280}
                preview="live"
                visibleDragbar={false}
              />
            </div>
            {/* Печать — только preview (одно окно) */}
            <div data-color-mode="light" className="print-only">
              {(preambleDraft || report.preamble) ? (
                <MDPreview source={preambleDraft || report.preamble || ''} />
              ) : (
                <span className="text-sm text-gray-400 italic">Преамбула не заполнена.</span>
              )}
            </div>
          </>
        )}
      </article>

      {/* Группа: первоочередные */}
      {priority.length > 0 && (
        <>
          <h2 className="report-group-heading text-xl font-bold text-purple-900 mb-3 mt-6 border-l-4 border-purple-500 pl-3">
            ⭐ Первоочередные объекты ({priority.length})
          </h2>
          <div className="space-y-6 mb-6">
            {priority.map((s) => (
              <ControlSectionCard
                key={s.id}
                s={s}
                isFinal={isFinal}
                isGenerating={generatingId === s.id}
                isSaving={savingId === s.id}
                bulkRunning={bulkRunning}
                getValue={getValue}
                setDraft={setDraft}
                getPriority={getPriority}
                getDeadline={getDeadline}
                onPriorityChange={(sid, v) => setPriorityDrafts((d) => ({ ...d, [sid]: v }))}
                onDeadlineChange={(sid, v) => setDeadlineDrafts((d) => ({ ...d, [sid]: v }))}
                isDirty={isDirty(s)}
                onSave={() => saveSection(s)}
                onGenerate={(fields) => generateSection(s, fields)}
                reportPeriodStart={report.period_start}
                onReload={reload}
              />
            ))}
          </div>
        </>
      )}

      {/* Группа: прочие */}
      {secondary.length > 0 && (
        <>
          <h2 className="report-group-heading text-xl font-bold text-gray-800 mb-3 mt-6 border-l-4 border-gray-400 pl-3">
            Прочие объекты ({secondary.length})
          </h2>
          <div className="space-y-6">
            {secondary.map((s) => (
              <ControlSectionCard
                key={s.id}
                s={s}
                isFinal={isFinal}
                isGenerating={generatingId === s.id}
                isSaving={savingId === s.id}
                bulkRunning={bulkRunning}
                getValue={getValue}
                setDraft={setDraft}
                getPriority={getPriority}
                getDeadline={getDeadline}
                onPriorityChange={(sid, v) => setPriorityDrafts((d) => ({ ...d, [sid]: v }))}
                onDeadlineChange={(sid, v) => setDeadlineDrafts((d) => ({ ...d, [sid]: v }))}
                isDirty={isDirty(s)}
                onSave={() => saveSection(s)}
                onGenerate={(fields) => generateSection(s, fields)}
                reportPeriodStart={report.period_start}
                onReload={reload}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ControlSectionCard({
  s, isFinal, isGenerating, isSaving, bulkRunning,
  getValue, setDraft, getPriority, getDeadline,
  onPriorityChange, onDeadlineChange,
  isDirty, onSave, onGenerate,
  reportPeriodStart, onReload,
}: {
  s: ControlSection
  isFinal: boolean
  isGenerating: boolean
  isSaving: boolean
  bulkRunning: boolean
  getValue: (s: ControlSection, field: ControlFieldKey) => string
  setDraft: (sid: string, field: string, value: string) => void
  getPriority: (s: ControlSection) => 'priority' | 'secondary' | null
  getDeadline: (s: ControlSection) => string
  onPriorityChange: (sid: string, v: 'priority' | 'secondary' | null) => void
  onDeadlineChange: (sid: string, v: string) => void
  isDirty: boolean
  onSave: () => void
  onGenerate: (fields?: ControlFieldKey[]) => void
  reportPeriodStart: string
  onReload: () => Promise<void>
}) {
  if (!s.object) return null
  const prio = getPriority(s)
  const deadline = getDeadline(s)
  return (
    <article className="object-report bg-white rounded shadow border border-gray-200 p-6">
      <header className="border-b pb-3 mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              <ObjectTitle code={s.object.code} currentName={s.object.current_name} />
            </h2>
            {/* Подрядчик показан в блоке 0 "Сводка" — здесь не дублируем */}
          </div>
          <div className="flex gap-2 no-print">
            {!isFinal && (
              <>
                <button onClick={() => onGenerate()} disabled={isGenerating || bulkRunning}
                  className="px-3 py-1 bg-purple-600 text-white text-xs rounded hover:bg-purple-700 disabled:opacity-50">
                  {isGenerating ? '⏳' : '✨'} Сгенерировать раздел
                </button>
                {isDirty && (
                  <button onClick={onSave} disabled={isSaving}
                    className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50">
                    {isSaving ? '💾…' : '💾 Сохранить'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Метаполя раздела: приоритет + срок ТЭП.
            Экран — селекторы (только для draft). При печати — plain-text. */}
        {!isFinal && (
          <div className="no-print flex gap-4 mt-3 flex-wrap items-center text-sm">
            <label className="flex items-center gap-2">
              <span className="text-xs text-gray-600">Группа:</span>
              <select
                value={prio ?? ''}
                onChange={(e) => onPriorityChange(s.id, (e.target.value || null) as 'priority' | 'secondary' | null)}
                className="px-2 py-1 border rounded text-xs"
              >
                <option value="">— не классифицирован —</option>
                <option value="priority">⭐ Первоочередной</option>
                <option value="secondary">Прочий</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs text-gray-600">Срок ТЭП:</span>
              <input
                type="date"
                value={deadline}
                onChange={(e) => onDeadlineChange(s.id, e.target.value)}
                className="px-2 py-1 border rounded text-xs"
              />
            </label>
          </div>
        )}
        {/* Печатный вариант — для всех (draft/final): plain-text */}
        <div className="print-only mt-2 text-xs text-gray-700">
          {prio === 'priority' && (
            <span className="mr-3"><strong>⭐ Первоочередной</strong></span>
          )}
          {prio === 'secondary' && (
            <span className="mr-3">Группа: <strong>Прочий</strong></span>
          )}
          {(deadline || s.tep_deadline) && (
            <span>Срок ТЭП: <strong>{formatDate(deadline || s.tep_deadline)}</strong></span>
          )}
        </div>
        {isFinal && (
          <div className="no-print flex gap-4 mt-3 flex-wrap items-center text-xs text-gray-600">
            {prio === 'priority' && <span className="text-purple-700 font-medium">⭐ Первоочередной</span>}
            {s.tep_deadline && <span>Срок ТЭП: <strong>{formatDate(s.tep_deadline)}</strong></span>}
          </div>
        )}
      </header>

      {/* Warning: устаревший llm_hint (утверждает паузу, но в БД есть свежая активность) */}
      <StaleHintWarning
        section={s}
        reportPeriodStart={reportPeriodStart}
        onSaved={onReload}
      />

      {/* 0. Сводка — детерминированно из БД (название, алиасы, подрядчики, договоры).
          При печати: класс report-summary-block убирает фон/рамки, чипы no-print
          заменяются plain-text вариантами print-only — структура сохраняется. */}
      <section className="report-summary-block mb-5 bg-purple-50/60 border border-purple-200 rounded p-4">
        <h3 className="text-sm font-semibold text-purple-800 uppercase tracking-wider mb-2">
          0. Сводка
        </h3>
        <dl className="text-sm space-y-1.5">
          <div className="flex gap-2 flex-wrap">
            <dt className="text-gray-600 font-medium min-w-[160px]">Название:</dt>
            <dd className="flex-1 text-gray-900">
              {s.object && (
                <ObjectTitle code={s.object.code} currentName={s.object.current_name} />
              )}
            </dd>
          </div>
          {s.object?.aliases && s.object.aliases.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              <dt className="text-gray-600 font-medium min-w-[160px]">Алиасы:</dt>
              <dd className="flex-1">
                {/* Экранный вариант: чипы */}
                <span className="no-print">
                  {s.object.aliases.map((a, i) => (
                    <span key={i} className="inline-block bg-white border border-purple-200 rounded px-1.5 py-0.5 text-xs mr-1 mb-1 text-purple-900">
                      {a}
                    </span>
                  ))}
                </span>
                {/* Печатный вариант: запятыми */}
                <span className="print-only">{s.object.aliases.join(', ')}</span>
              </dd>
            </div>
          )}
          {(() => {
            const contractors = [...new Set(
              (s.contracts ?? [])
                .map((c) => c.contractor_name)
                .filter((x): x is string => Boolean(x))
            )]
            return (
              <div className="flex gap-2 flex-wrap">
                <dt className="text-gray-600 font-medium min-w-[160px]">Подрядные орг.:</dt>
                <dd className="flex-1">
                  {contractors.length > 0 ? (
                    <>
                      <span className="no-print">
                        {contractors.map((name, i) => (
                          <span key={i} className="inline-block bg-white border border-blue-200 rounded px-1.5 py-0.5 text-xs mr-1 mb-1 text-blue-900">
                            {name}
                          </span>
                        ))}
                      </span>
                      <span className="print-only">{contractors.join(', ')}</span>
                    </>
                  ) : (
                    <span className="text-gray-400 italic">не определены</span>
                  )}
                </dd>
              </div>
            )
          })()}
          <div className="flex gap-2 flex-wrap items-start">
            <dt className="text-gray-600 font-medium min-w-[160px]">Договоры:</dt>
            <dd className="flex-1 min-w-0">
              {!s.contracts || s.contracts.length === 0 ? (
                <span className="text-gray-400 italic">не зарегистрированы</span>
              ) : (
                <div className="space-y-3">
                  {s.contracts.map((c) => (
                    <ContractWithStagesBlock key={c.id} contract={c} />
                  ))}
                </div>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <div className="space-y-5">
        {CONTROL_FIELDS.map((f) => {
          // Dirty-флаг конкретного поля: текущее значение != сохранённое в БД
          const currentValue = getValue(s, f.key)
          const savedValue = (s[f.key] as string | null) ?? ''
          const fieldDirty = currentValue !== savedValue
          return (
          <div key={f.key}>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <h3 className="text-sm font-semibold text-purple-700 uppercase tracking-wider">
                {f.title}
              </h3>
              {!isFinal && (
                <div className="flex gap-1 no-print">
                  <button
                    onClick={() => onGenerate([f.key])}
                    disabled={isGenerating || bulkRunning}
                    className="px-2 py-0.5 bg-purple-600 text-white text-[11px] rounded hover:bg-purple-700 disabled:opacity-50"
                    title="Сгенерировать LLM только этот пункт"
                  >
                    {isGenerating ? '⏳' : '✨'}
                  </button>
                  {fieldDirty && (
                    <button
                      onClick={onSave}
                      disabled={isSaving}
                      className="px-2 py-0.5 bg-blue-600 text-white text-[11px] rounded hover:bg-blue-700 disabled:opacity-50"
                      title="Сохранить правки этой секции"
                    >
                      {isSaving ? '💾…' : '💾'}
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Hint-подсказка — только для редактирования, скрыть при печати */}
            <p className="text-[11px] text-gray-500 mb-1 no-print">{f.hint}</p>
            {isFinal ? (
              (s[f.key] ?? '').trim() ? (
                <div data-color-mode="light" className="text-sm">
                  <MDPreview source={s[f.key] as string} />
                </div>
              ) : (
                <span className="text-sm text-gray-400 italic">— не заполнено —</span>
              )
            ) : (
              <>
                {/* Экранный вариант: редактор */}
                <div className="no-print">
                  <AutoGrowTextarea
                    value={getValue(s, f.key)}
                    onChange={(v) => setDraft(s.id, f.key, v)}
                    placeholder="Пусто. Нажмите ✨ или впишите вручную."
                  />
                </div>
                {/* Печатный вариант: MD-превью или fallback */}
                <div className="print-only">
                  {getValue(s, f.key).trim() ? (
                    <div data-color-mode="light" className="text-sm">
                      <MDPreview source={getValue(s, f.key)} />
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400 italic">— не заполнено —</span>
                  )}
                </div>
              </>
            )}
          </div>
          )
        })}
      </div>

      {s.generated_at && (
        <p className="text-xs text-gray-400 mt-3 pt-3 border-t">
          Последняя редакция раздела: {new Date(s.generated_at).toLocaleDateString('ru-RU', {
            day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      )}
    </article>
  )
}

// Warning-бадж: показывается если llm_hint утверждает паузу/неактивность,
// но в БД есть свежая активность (задачи / темы / события за 30 дней).
// Скрыт при печати — это диагностический UI-элемент, не часть документа.
//
// reportPeriodStart — используется как «отключить с этой даты» (фактически
// проставит llm_hint_valid_until = day_before_period_start, hint остаётся в БД
// но в текущий и будущие отчёты не попадает).
export function StaleHintWarning({
  section, reportPeriodStart, onSaved,
}: {
  section: { id: string; object_id: string; object: { llm_hint: string | null } | null;
             recent_activity?: { tasks_active: number; topics_30d: number; events_30d: number };
             hint_effective_at_reference?: boolean }
  reportPeriodStart: string  // YYYY-MM-DD
  onSaved?: () => void | Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const hint = section.object?.llm_hint ?? null
  const activity = section.recent_activity ?? null
  // Если hint уже отключён сроком — badge не нужен (LLM его не получает)
  if (section.hint_effective_at_reference === false) return null
  const finding = detectStaleLlmHint(hint, activity)
  if (!finding.isStale) return null

  // День до начала периода отчёта (включительно)
  const cutoff = (() => {
    const d = new Date(reportPeriodStart + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })()
  const cutoffHuman = new Date(cutoff + 'T00:00:00').toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })

  async function disableHint() {
    if (!section.object_id) return
    setSaving(true)
    const res = await fetch(`/api/objects/${section.object_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm_hint_valid_until: cutoff }),
    })
    setSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      alert(j.error ?? `HTTP ${res.status}`)
      return
    }
    if (onSaved) await onSaved()
  }

  return (
    <div className="no-print mb-4 bg-amber-50 border border-amber-300 rounded p-3 text-sm">
      <div className="flex items-start gap-2">
        <span className="text-lg leading-none">⚠️</span>
        <div className="flex-1">
          <div className="font-semibold text-amber-900">
            Возможно устаревший «Контекст для LLM»
          </div>
          <p className="text-amber-800 mt-0.5 text-xs">
            В БД есть свежая активность ({finding.activitySummary}), но llm_hint
            утверждает паузу или отсутствие работы по объекту. LLM поверит hint
            и сгенерирует «на паузе» — обновите подсказку или отключите её срок.
          </p>
          <div className="mt-2 flex gap-2 flex-wrap items-center">
            <button
              onClick={disableHint}
              disabled={saving}
              className="px-3 py-1 bg-amber-600 text-white text-xs rounded hover:bg-amber-700 disabled:opacity-50"
              title={`Установит llm_hint_valid_until = ${cutoff} (день до начала периода отчёта). Hint останется в БД, но в этот и будущие отчёты не попадёт.`}
            >
              {saving ? '💾…' : `🚫 Отключить с ${cutoffHuman}`}
            </button>
            <details className="text-xs">
              <summary className="text-amber-700 cursor-pointer hover:underline">
                Показать текущий hint
              </summary>
              <pre className="mt-1 text-[11px] bg-white border border-amber-200 rounded p-2 whitespace-pre-wrap text-gray-700">
                {hint}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  )
}

// Блок одного договора со «светофором» этапов: ⚪ done · 🟢 current · 🔵 upcoming.
// При печати чипы скрываются (.no-print), вместо них — plain-text вариант
// «1. Массинг ✓ · 2. ОПР ► (текущий) · 3. МОП ○».
function ContractWithStagesBlock({ contract: c }: { contract: ControlSectionContract }) {
  return (
    <div className="contract-card bg-white border border-gray-200 rounded p-2.5">
      {/* Заголовок: Договор № X (от ДД.ММ.ГГГГ) — Подрядчик */}
      <div className="text-sm mb-2">
        <span className="text-gray-500 uppercase text-[10px] tracking-wider">{c.type}</span>
        {c.doc_number && (
          <span className="ml-1.5 font-mono font-semibold text-gray-900">№ {c.doc_number}</span>
        )}
        {c.signed_date && (
          <span className="ml-1 text-gray-500 text-xs">(от {formatDate(c.signed_date)})</span>
        )}
        {c.contractor_name && (
          <span className="text-gray-700"> — <strong>{c.contractor_name}</strong></span>
        )}
      </div>

      {/* Этапы договора: цветные чипы на экране, plain text при печати */}
      {!c.stages || c.stages.length === 0 ? (
        <p className="text-xs text-gray-400 italic">Этапы договора не определены.</p>
      ) : (
        <>
          {/* Экранный вариант: цветные чипы */}
          <div className="no-print flex gap-1 flex-wrap">
            {c.stages.map((st) => {
              const cls = st.status === 'current'
                ? 'bg-emerald-100 text-emerald-900 border-emerald-400 ring-1 ring-emerald-400'
                : st.status === 'done'
                  ? 'bg-gray-100 text-gray-600 border-gray-300 line-through'
                  : 'bg-sky-50 text-sky-800 border-sky-200'
              const icon = st.status === 'current' ? '🟢' : st.status === 'done' ? '⚪' : '🔵'
              return (
                <span
                  key={st.id}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${cls}`}
                  title={st.status === 'current' ? 'Текущий этап' : st.status === 'done' ? 'Выполнен' : 'Предстоящий'}
                >
                  <span className="text-[10px]">{icon}</span>
                  <span className="font-mono">{st.stage_number}.</span>
                  <span>{st.stage_name}</span>
                </span>
              )
            })}
          </div>

          {/* Печатный вариант: plain text, структура сохранена */}
          <div className="print-only text-xs">
            <span className="text-gray-600">Этапы: </span>
            {c.stages.map((st, i) => {
              const marker = st.status === 'current' ? '►' : st.status === 'done' ? '✓' : '○'
              const text = `${marker} ${st.stage_number}. ${st.stage_name}`
              const styled = st.status === 'current'
                ? <strong>{text} (текущий)</strong>
                : st.status === 'done'
                  ? <s>{text}</s>
                  : <>{text}</>
              return (
                <span key={st.id}>
                  {i > 0 && ' · '}
                  {styled}
                </span>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
