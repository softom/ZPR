'use client'

import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import dynamic from 'next/dynamic'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

import ObjectCover from './ObjectCover'

const MDPreview = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default.Markdown),
  { ssr: false },
)

// ── Типы ───────────────────────────────────────────────────────────────────
export type ShortReport = {
  id: string
  title: string | null
  period_start: string
  period_end: string
  status: 'draft' | 'final'
  period_type: 'short'
}

export type ShortSection = {
  id: string
  object_id: string
  narrative: string | null        // вступление
  achievements: string | null     // графа «Утверждённые варианты» — только номера
  decisions: string | null        // перечень утверждённых вариантов (детализация)
  generated_at: string | null
  object: { code: string; current_name: string } | null
}

type FieldKey = 'narrative' | 'achievements' | 'decisions'
const VIEW_FIELDS: Array<{ key: FieldKey; title: string; hint: string }> = [
  { key: 'narrative',    title: '1. Вступление', hint: 'Короткий абзац: что в целом заказчик утвердил по объекту в работу.' },
  { key: 'achievements', title: '2. Утверждённые варианты (№№)', hint: 'Только номера утверждённых вариантов: одно число или через запятую (напр. «2, 4»).' },
  { key: 'decisions',    title: '3. Перечень вариантов', hint: 'Список: вариант · кто утвердил · дата · протокол/собрание.' },
]

// Авто-растущая textarea для редактирования (на печать — потоковый блок).
function AutoGrowTextarea({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="no-print w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none overflow-hidden"
      />
      <div className="print-only text-sm whitespace-pre-wrap break-words">{value}</div>
    </>
  )
}

function ObjectTitle({ code, name }: { code: string; name?: string | null }) {
  const m = code.match(/^(\d+)[_\s]+(.+)$/)
  const number = m?.[1] ?? code
  const rest = m?.[2] ? m[2].replace(/_/g, ' ') : ''
  return (
    <span>
      <span className="obj-number font-bold">{number}</span>
      {rest && <span> {rest}</span>}
      {name && <span className="font-normal text-gray-700"> — {name}</span>}
    </span>
  )
}

// ── Компонент ────────────────────────────────────────────────────────────────
export default function ShortReportView({
  report: initialReport,
  sections: initialSections,
  reload,
}: {
  report: ShortReport
  sections: ShortSection[]
  reload: () => Promise<void>
}) {
  const [report, setReport] = useState(initialReport)
  const [sections, setSections] = useState(initialSections)
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<FieldKey, string>>>>({})
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [genFieldKey, setGenFieldKey] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)

  useEffect(() => {
    setReport(initialReport)
    setSections(initialSections)
  }, [initialReport, initialSections])

  const isFinal = report.status === 'final'

  function getValue(s: ShortSection, f: FieldKey): string {
    const d = drafts[s.id]?.[f]
    return d !== undefined ? d : (s[f] ?? '')
  }
  function setDraft(sectionId: string, f: FieldKey, v: string) {
    setDrafts((prev) => ({ ...prev, [sectionId]: { ...(prev[sectionId] ?? {}), [f]: v } }))
  }
  function isDirty(s: ShortSection): boolean {
    return Boolean(drafts[s.id] && Object.keys(drafts[s.id]).length > 0)
  }

  async function saveSection(s: ShortSection) {
    if (!isDirty(s)) return
    setSavingId(s.id)
    const res = await fetch(`/api/reports/${report.id}/sections/${s.object_id}`, {
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
    setDrafts((prev) => { const next = { ...prev }; delete next[s.id]; return next })
    await reload()
  }

  async function generateSection(s: ShortSection, fields?: FieldKey[]) {
    setGeneratingId(s.id)
    setGenFieldKey(fields && fields.length === 1 ? `${s.id}|${fields[0]}` : null)
    const res = await fetch(`/api/reports/${report.id}/sections/${s.object_id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: fields ? JSON.stringify({ fields }) : '',
    })
    setGeneratingId(null)
    setGenFieldKey(null)
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    await reload()
  }

  async function generateAll() {
    if (!confirm('Сгенерировать короткую справку по всем объектам? Это вызовет LLM для каждого.')) return
    setBulkRunning(true)
    for (const s of sections) {
      setGeneratingId(s.id)
      await fetch(`/api/reports/${report.id}/sections/${s.object_id}/generate`, { method: 'POST' }).catch(() => {})
    }
    setGeneratingId(null)
    setBulkRunning(false)
    await reload()
  }

  const formedDate = new Date(report.period_start).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  return (
    <div className="max-w-4xl mx-auto">
      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {report.title ?? `Короткая справка на ${formedDate}`}
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Утверждённые заказчиком варианты в дальнейшую работу · накопительно на {formedDate}
            </p>
          </div>
          <div className="flex gap-2 no-print">
            <button
              onClick={() => window.print()}
              className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800"
            >
              🖨️ Печать
            </button>
            {!isFinal && (
              <button
                onClick={generateAll}
                disabled={bulkRunning}
                className="px-3 py-1.5 bg-teal-600 text-white text-sm rounded hover:bg-teal-700 disabled:opacity-50"
              >
                {bulkRunning ? '⏳ Генерация…' : '✨ Сгенерировать всё'}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Печатная обложка справки (стр. 1). Первый объект уходит на новую
          страницу через .object-report:first-of-type (globals.css). */}
      <div className="print-only text-center" style={{ paddingTop: '40mm' }}>
        <h1 className="text-3xl font-bold text-gray-900">Короткая справка</h1>
        <p className="text-lg text-gray-700 mt-3">Утверждённые заказчиком варианты в дальнейшую работу</p>
        <p className="text-base text-gray-600 mt-1">накопительно на {formedDate}</p>
      </div>

      <div className="space-y-6">
        {sections.map((s) => {
          if (!s.object) return null
          const dirty = isDirty(s)
          return (
            <article key={s.id} className="object-report bg-white rounded shadow border border-gray-200 p-6">
              {/* Титульный лист объекта (только печать): название + PNG-обложка.
                  geoData=null — обложка грузится из Storage по номеру объекта;
                  при отсутствии PNG раздел просто без картинки. */}
              <div className="print-only print-page-break-after object-title-page">
                <h1 className="text-2xl font-bold text-gray-900 mb-3">
                  <ObjectTitle code={s.object.code} name={s.object.current_name} />
                </h1>
                <ObjectCover code={s.object.code} objectName={s.object.current_name} geoData={null} />
              </div>
              <header className="border-b pb-3 mb-4 flex items-baseline justify-between gap-3">
                <h2 className="text-xl font-bold text-gray-900">
                  <ObjectTitle code={s.object.code} name={s.object.current_name} />
                </h2>
                <div className="flex gap-2 no-print">
                  {!isFinal && (
                    <>
                      <button
                        onClick={() => generateSection(s)}
                        disabled={generatingId === s.id || bulkRunning}
                        className="px-3 py-1 bg-teal-600 text-white text-xs rounded hover:bg-teal-700 disabled:opacity-50"
                      >
                        {generatingId === s.id ? '⏳' : '✨'} Сгенерировать
                      </button>
                      {dirty && (
                        <button
                          onClick={() => saveSection(s)}
                          disabled={savingId === s.id}
                          className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          💾 Сохранить
                        </button>
                      )}
                    </>
                  )}
                </div>
              </header>

              <div className="space-y-4">
                {VIEW_FIELDS.map((f) => {
                  const isGenThis = genFieldKey === `${s.id}|${f.key}`
                  const fieldDirty = drafts[s.id]?.[f.key] !== undefined
                  return (
                    <div key={f.key}>
                      <div className="flex items-baseline justify-between gap-2 mb-1">
                        <h4 className="text-sm font-semibold text-teal-700 uppercase tracking-wider">{f.title}</h4>
                        {!isFinal && (
                          <div className="flex gap-2 no-print">
                            <button
                              onClick={() => generateSection(s, [f.key])}
                              disabled={isGenThis || generatingId === s.id || bulkRunning}
                              title="Сгенерировать только этот пункт"
                              className="px-2 py-0.5 bg-teal-600 text-white text-[11px] rounded hover:bg-teal-700 disabled:opacity-50"
                            >
                              {isGenThis ? '⏳' : '✨'}
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
                      <p className="text-[11px] text-gray-400 mb-1 no-print">{f.hint}</p>
                      {isFinal ? (
                        (s[f.key] ?? '').trim() ? (
                          <div data-color-mode="light" className="text-sm"><MDPreview source={s[f.key] as string} /></div>
                        ) : (
                          <span className="text-sm text-gray-400 italic">— не заполнено —</span>
                        )
                      ) : (
                        <AutoGrowTextarea
                          value={getValue(s, f.key)}
                          onChange={(v) => setDraft(s.id, f.key, v)}
                          placeholder="Пусто. Нажмите ✨ или впишите вручную."
                        />
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
        })}
      </div>
    </div>
  )
}
