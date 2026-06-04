'use client'

import { useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import '@uiw/react-markdown-preview/markdown.css'

const MDPreview = dynamic(
  () => import('@uiw/react-md-editor').then((m) => m.default.Markdown),
  { ssr: false },
)

// Проверка внешнего отчёта: загрузка DOCX/TXT/MD → LLM-анализ → результат в MD.
//
// 1. Drag&drop / file input
// 2. POST /api/reports/external-check (FormData)
// 3. Отображение MD-результата + кнопка «Скачать .md»

export default function ExternalCheckPage() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [md, setMd] = useState<string>('')
  const [error, setError] = useState('')

  async function runCheck() {
    if (!file) return
    setBusy(true)
    setError('')
    setMd('')
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch('/api/reports/external-check', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setMd(json.md as string)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка проверки')
    }
    setBusy(false)
  }

  function downloadMd() {
    if (!md) return
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(file?.name ?? 'отчёт').replace(/\.[^.]+$/, '')}_проверка.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-2">
        <Link href="/reports" className="text-sm text-blue-600 hover:underline">← К отчётам</Link>
      </div>

      <h1 className="text-2xl font-bold mb-2">🔍 Проверка внешнего отчёта</h1>
      <p className="text-sm text-gray-600 mb-5">
        Загрузи внешний документ (.docx / .txt / .md) — LLM разобьёт его на разделы по объектам
        и сверит факты с БД проекта (события, задачи, темы). Период проверки — <strong>интегральный</strong>{' '}
        (вся история объекта). Результат — Markdown с категориями ✅ Подтверждено / ⚠ Расхождения /
        ❌ Не упомянуто / ❓ Не проверить.
      </p>

      {/* Загрузка файла */}
      <div className="bg-white border-2 border-dashed border-gray-300 rounded-lg p-6 mb-5">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const f = e.dataTransfer.files?.[0]
            if (f) setFile(f)
          }}
          className="flex items-center gap-4 flex-wrap"
        >
          <label className="px-4 py-2 bg-blue-600 text-white text-sm rounded cursor-pointer hover:bg-blue-700">
            📎 Выбрать файл
            <input
              type="file"
              accept=".docx,.txt,.md"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setFile(f)
                e.currentTarget.value = ''
              }}
            />
          </label>
          <span className="text-sm text-gray-500">или перетащите файл сюда</span>
          {file && (
            <span className="text-sm text-gray-800 font-medium">
              {file.name} <span className="text-gray-400">({(file.size / 1024).toFixed(1)} КБ)</span>
              <button
                onClick={() => { setFile(null); setMd(''); setError('') }}
                className="ml-2 text-red-600 hover:underline text-xs"
              >
                очистить
              </button>
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={runCheck}
            disabled={!file || busy}
            className="px-4 py-2 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? '⏳ Анализирую…' : '✨ Проверить'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          Поддерживаемые форматы: .docx (Word), .txt, .md. Анализ занимает 30 сек — 5 мин в зависимости от размера документа.
        </p>
      </div>

      {error && (
        <div className="p-3 mb-4 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          {error}
        </div>
      )}

      {busy && (
        <div className="bg-blue-50 border border-blue-200 rounded p-4 text-sm text-blue-800">
          <div className="font-medium mb-1">⏳ LLM анализирует документ</div>
          <div className="text-blue-700">
            Шаг 1: разбивка на разделы и привязка к объектам.<br />
            Шаг 2: для каждого раздела — сверка с БД проекта.<br />
            <span className="text-blue-500">Это может занять несколько минут.</span>
          </div>
        </div>
      )}

      {md && (
        <div>
          <div className="flex items-center justify-end mb-3 gap-2">
            <button
              onClick={downloadMd}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50"
            >
              ⬇ Скачать .md
            </button>
            <button
              onClick={() => window.print()}
              className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800"
            >
              🖨️ Печать
            </button>
          </div>
          <article className="bg-white border border-gray-200 rounded-lg p-6">
            <div data-color-mode="light">
              <MDPreview source={md} />
            </div>
          </article>
        </div>
      )}
    </div>
  )
}
