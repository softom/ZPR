'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import '@uiw/react-md-editor/markdown-editor.css'
import '@uiw/react-markdown-preview/markdown.css'

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false })
const MDPreview = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default.Markdown),
  { ssr: false },
)

export type ContractReport = {
  id: string
  title: string | null
  period_start: string
  period_end: string
  status: 'draft' | 'final'
  period_type: 'contract'
  summary_md: string | null
  appendix_report_id: string | null
}
export type ContractSection = unknown // не используется — отчёт проектного уровня

type MonthReportOpt = { id: string; title: string | null; period_start: string }

export default function ContractReportView({
  report: initialReport,
  reload,
}: {
  report: ContractReport
  sections?: unknown[]
  reload: () => Promise<void>
}) {
  const [report, setReport] = useState(initialReport)
  const [doc, setDoc] = useState(initialReport.summary_md ?? '')
  const [sourceId, setSourceId] = useState(initialReport.appendix_report_id ?? '')
  const [monthReports, setMonthReports] = useState<MonthReportOpt[]>([])
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setReport(initialReport)
    setDoc(initialReport.summary_md ?? '')
    setSourceId(initialReport.appendix_report_id ?? '')
  }, [initialReport])

  useEffect(() => {
    fetch('/api/reports?period_type=month')
      .then((r) => r.json())
      .then((j) => setMonthReports(j.reports ?? []))
      .catch(() => {})
  }, [])

  const isFinal = report.status === 'final'
  const appendixTitle = monthReports.find((m) => m.id === sourceId)?.title

  async function saveDoc() {
    setSaving(true)
    const res = await fetch(`/api/reports/${report.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary_md: doc, appendix_report_id: sourceId || null }),
    })
    setSaving(false)
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return }
    await reload()
  }

  async function generate() {
    if (!sourceId) { alert('Выберите отчёт-источник (Приложение) — месячный отчёт ЗПР.'); return }
    if (doc.trim() && !confirm('Пересобрать документ из источника? Текущий текст будет заменён.')) return
    setGenerating(true)
    const res = await fetch(`/api/reports/${report.id}/contract/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_report_id: sourceId }),
    })
    setGenerating(false)
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return }
    await reload()
  }

  return (
    <div className="max-w-4xl mx-auto">
      <header className="mb-4 flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-900">{report.title ?? 'Отчёт по договору ТЗ'}</h1>
        <div className="flex gap-2 no-print">
          <a
            href={`/api/reports/${report.id}/render?format=md`}
            className="px-3 py-1.5 bg-gray-200 text-gray-800 text-sm rounded hover:bg-gray-300"
          >⬇️ .md (с Приложением)</a>
          <button onClick={() => window.print()} className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800">🖨️ Печать</button>
        </div>
      </header>

      {!isFinal && (
        <div className="no-print mb-4 bg-amber-50 border border-amber-200 rounded p-3 flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Источник / Приложение (месячный отчёт ЗПР)</label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="px-3 py-1.5 border rounded text-sm min-w-[260px]"
            >
              <option value="">— выбрать месячный отчёт —</option>
              {monthReports.map((m) => (
                <option key={m.id} value={m.id}>{m.title ?? m.period_start}</option>
              ))}
            </select>
          </div>
          <button onClick={generate} disabled={generating || !sourceId} className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50">
            {generating ? '⏳ Сборка…' : '✨ Собрать по договору'}
          </button>
          <button onClick={saveDoc} disabled={saving} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">💾 Сохранить</button>
          <p className="text-[11px] text-gray-500 w-full">
            Из выбранного месячного отчёта собирается документ по пунктам Задания (рамка «Исполнитель организовал…»),
            с честной оговоркой по невыполненным пунктам. Текст ниже правится вручную. Приложением подшивается этот же месячный отчёт.
          </p>
        </div>
      )}

      {/* Документ */}
      {isFinal ? (
        <div data-color-mode="light"><MDPreview source={doc || '*— документ не сформирован —*'} /></div>
      ) : (
        <div data-color-mode="light" className="mb-4">
          <MDEditor value={doc} onChange={(v) => setDoc(v ?? '')} height={600} preview="live" visibleDragbar={false} />
        </div>
      )}

      {/* Приложение — ссылка на месячный отчёт */}
      {sourceId && (
        <div className="mt-6 pt-4 border-t">
          <h2 className="text-lg font-bold text-gray-900">Приложение</h2>
          <p className="text-sm text-gray-600">
            Месячный отчёт ЗПР:{' '}
            <a href={`/reports/${sourceId}`} target="_blank" rel="noopener" className="text-blue-600 hover:underline">
              {appendixTitle ?? sourceId}
            </a>{' '}
            — подшивается к документу при экспорте (кнопка «⬇️ .md»).
          </p>
        </div>
      )}
    </div>
  )
}
