'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

/**
 * Печатная форма стратегических тем: каждая тема — на отдельном листе A4
 * через CSS `page-break-after: always`. Ctrl+P из браузера даёт PDF / печать
 * по теме на лист.
 *
 * Фильтры через URL query: ?status=open&category=personnel
 *
 * Сайдбар, кнопки и подсказки скрываются в режиме печати (`@media print`).
 */

type Topic = {
  id: string
  seq: number
  code: string | null
  title: string
  category: string
  synopsis: string
  threats: string
  solutions: string | null
  deadlines: string | null
  status: string
  source_quote: string | null
  published_at: string | null
}

const CATEGORY_LABEL: Record<string, string> = {
  environment:  'Средовое',
  engineering:  'Инженерное',
  land_legal:   'Земля/Право',
  organization: 'Организация',
  personnel:    'Кадры',
  contracting:  'Договоры',
}

const STATUS_LABEL: Record<string, string> = {
  open:         'Открыта',
  in_progress:  'В работе',
  mitigated:    'Купирована',
  resolved:     'Закрыта',
  cancelled:    'Отменена',
}

export default function PrintPage() {
  const [items, setItems] = useState<Topic[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus,   setFilterStatus]   = useState('')

  useEffect(() => {
    // Подхватываем фильтры из URL при первом рендере
    const params = new URLSearchParams(window.location.search)
    if (params.get('category')) setFilterCategory(params.get('category') as string)
    if (params.get('status'))   setFilterStatus(params.get('status') as string)
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/api/strategic-topics')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setItems(j.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    return items.filter(t => {
      if (filterCategory && t.category !== filterCategory) return false
      if (filterStatus   && t.status   !== filterStatus)   return false
      return true
    })
  }, [items, filterCategory, filterStatus])

  const today = new Date().toLocaleDateString('ru-RU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  })

  if (loading) return <div className="p-8">Загрузка…</div>
  if (error)   return <div className="p-8 text-red-700">{error}</div>

  return (
    <div className="print-root">
      {/* Toolbar — скрыт при печати */}
      <div className="no-print mb-6 p-4 bg-white border-b sticky top-0 z-10 flex items-center gap-4 flex-wrap">
        <Link href="/strategic-topics" className="text-blue-600 hover:underline text-sm">
          ← Все темы
        </Link>
        <div className="text-sm text-gray-600">
          Печатная форма — каждая тема на отдельной странице
        </div>
        <div className="ml-auto flex gap-3 items-center flex-wrap">
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded text-sm"
          >
            <option value="">Все категории</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-2 py-1 border border-gray-300 rounded text-sm"
          >
            <option value="">Все статусы</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <span className="text-xs text-gray-500">
            {filtered.length} / {items.length}
          </span>
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            🖨️ Печать / PDF
          </button>
        </div>
      </div>

      {/* Сами листы */}
      <div className="topics-print">
        {filtered.map(t => (
          <TopicSheet key={t.id} t={t} today={today} />
        ))}
        {filtered.length === 0 && (
          <div className="p-8 text-center text-gray-400">По фильтрам ничего не нашлось</div>
        )}
      </div>

      <style jsx global>{`
        /* ──────────── На экране ──────────── */
        .topic-sheet {
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto 12mm;
          padding: 20mm 18mm;
          background: white;
          box-shadow: 0 0 6px rgba(0,0,0,0.15);
          font-family: 'Geist', 'Inter', system-ui, sans-serif;
          color: #111827;
          font-size: 11pt;
          line-height: 1.45;
          box-sizing: border-box;
        }
        .topic-sheet h1.t-title {
          font-size: 18pt;
          font-weight: 700;
          margin: 0 0 8pt;
          line-height: 1.2;
        }
        .topic-sheet .t-seq {
          font-family: ui-monospace, Menlo, monospace;
          font-size: 36pt;
          font-weight: 800;
          color: #d1d5db;
          line-height: 1;
          margin-bottom: 4pt;
        }
        .topic-sheet .t-meta {
          display: flex;
          gap: 14pt;
          font-size: 9.5pt;
          color: #4b5563;
          border-bottom: 1pt solid #e5e7eb;
          padding-bottom: 8pt;
          margin-bottom: 12pt;
        }
        .topic-sheet .t-meta strong { color: #111827; font-weight: 600; }
        .topic-sheet h2.t-section {
          font-size: 11pt;
          font-weight: 600;
          color: #4b5563;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin: 12pt 0 4pt;
          border-bottom: 0.5pt solid #d1d5db;
          padding-bottom: 2pt;
        }
        .topic-sheet .t-body {
          white-space: pre-wrap;
          font-size: 11pt;
        }
        .topic-sheet .t-source {
          font-size: 9pt;
          color: #6b7280;
          font-style: italic;
          margin-top: 18pt;
          padding-top: 6pt;
          border-top: 0.5pt solid #e5e7eb;
        }
        .topic-sheet .t-footer {
          position: relative;
          margin-top: 24pt;
          padding-top: 6pt;
          border-top: 0.5pt solid #e5e7eb;
          font-size: 9pt;
          color: #6b7280;
          display: flex;
          justify-content: space-between;
        }

        /* ──────────── При печати ──────────── */
        @page { size: A4; margin: 0 }
        @media print {
          html, body { background: white; margin: 0; padding: 0 }
          .no-print { display: none !important }
          .topics-print { padding: 0; margin: 0 }
          .topic-sheet {
            margin: 0;
            box-shadow: none;
            page-break-after: always;
            break-after: page;
          }
          .topic-sheet:last-child { page-break-after: auto; break-after: auto; }
          /* Скрываем aside-сайдбар из layout */
          aside { display: none !important }
          main { padding: 0 !important; overflow: visible !important }
        }
      `}</style>
    </div>
  )
}

function TopicSheet({ t, today }: { t: Topic; today: string }) {
  return (
    <section className="topic-sheet">
      <div className="t-seq">{String(t.seq).padStart(3, '0')}</div>
      <h1 className="t-title">{t.title}</h1>
      <div className="t-meta">
        <span><strong>Категория:</strong> {CATEGORY_LABEL[t.category] ?? t.category}</span>
        <span><strong>Статус:</strong> {STATUS_LABEL[t.status] ?? t.status}</span>
        {t.code && <span><strong>Код:</strong> {t.code}</span>}
      </div>

      <h2 className="t-section">Синопсис</h2>
      <div className="t-body">{t.synopsis}</div>

      <h2 className="t-section">Угрозы</h2>
      <div className="t-body">{t.threats}</div>

      {t.solutions && t.solutions.trim().length > 0 && (
        <>
          <h2 className="t-section">Решения</h2>
          <div className="t-body">{t.solutions}</div>
        </>
      )}

      {t.deadlines && t.deadlines.trim().length > 0 && (
        <>
          <h2 className="t-section">Сроки и контрольные точки</h2>
          <div className="t-body">{t.deadlines}</div>
        </>
      )}

      {t.source_quote && t.source_quote.trim().length > 0 && (
        <div className="t-source">
          <strong>Источник:</strong> {t.source_quote.split('\n')[0]}
        </div>
      )}

      <div className="t-footer">
        <span>ЗПР · Стратегические темы</span>
        <span>Распечатано: {today}</span>
      </div>
    </section>
  )
}
