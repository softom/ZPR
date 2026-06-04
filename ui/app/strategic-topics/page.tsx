'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRole } from '@/lib/useRole'

type Topic = {
  id: string
  seq: number
  code: string | null
  title: string
  category: string
  synopsis: string
  status: string
  source_quote: string | null
  created_at: string
  updated_at: string
}

function fmtSeq(n: number): string {
  return String(n).padStart(3, '0')
}

const CATEGORY_LABEL: Record<string, string> = {
  environment:  'Средовое',
  engineering:  'Инженерное',
  land_legal:   'Земля/Право',
  organization: 'Организация',
  personnel:    'Кадры',
  contracting:  'Договоры',
}

const CATEGORY_COLOR: Record<string, string> = {
  environment:  'bg-emerald-100 text-emerald-800',
  engineering:  'bg-sky-100 text-sky-800',
  land_legal:   'bg-amber-100 text-amber-800',
  organization: 'bg-violet-100 text-violet-800',
  personnel:    'bg-rose-100 text-rose-800',
  contracting:  'bg-slate-100 text-slate-800',
}

const STATUS_LABEL: Record<string, string> = {
  open:         'Открыта',
  in_progress:  'В работе',
  mitigated:    'Купирована',
  resolved:     'Закрыта',
  cancelled:    'Отменена',
}

const STATUS_COLOR: Record<string, string> = {
  open:         'bg-red-100 text-red-700',
  in_progress:  'bg-yellow-100 text-yellow-700',
  mitigated:    'bg-blue-100 text-blue-700',
  resolved:     'bg-gray-200 text-gray-600',
  cancelled:    'bg-gray-100 text-gray-400',
}

export default function StrategicTopicsPage() {
  // Создание новых тем — admin only (по той же модели, что и прямая правка
  // полей: workflow B оставляет только админу право куратора стратегического
  // каркаса; uploader может только предлагать правки существующих тем).
  const { isAdmin } = useRole()
  const router = useRouter()

  const [items, setItems] = useState<Topic[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus]     = useState('')
  const [search, setSearch]                 = useState('')

  useEffect(() => { load() }, [])

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

  async function createNew() {
    setCreating(true)
    setError('')
    try {
      const r = await fetch('/api/strategic-topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:    'Новая стратегическая тема',
          category: 'organization',
          synopsis: '— заполните синопсис —',
          threats:  '— заполните угрозы —',
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      router.push(`/strategic-topics/${j.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCreating(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(t => {
      if (filterCategory && t.category !== filterCategory) return false
      if (filterStatus && t.status !== filterStatus) return false
      if (q) {
        const hay = `${t.title} ${t.synopsis} ${t.code ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, filterCategory, filterStatus, search])

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Стратегические темы</h1>
          <p className="text-sm text-gray-500 mt-1">
            Управленческие темы с горизонтом 6–18 мес. Источник — аналитические отчёты ТЗ-ЮГ.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/strategic-topics/print"
            className="px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-50 text-sm"
            title="Печатная форма — каждая тема на отдельном листе"
          >
            🖨️ Печать
          </Link>
          {isAdmin && (
            <button
              onClick={createNew}
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? 'Создание…' : '+ Добавить тему'}
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded shadow mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-gray-500 mb-1">Поиск</label>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Название, синопсис, код"
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Категория</label>
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm"
          >
            <option value="">Все</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Статус</label>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded text-sm"
          >
            <option value="">Все</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="text-xs text-gray-500 ml-auto">
          {filtered.length} / {items.length}
        </div>
      </div>

      {error && (
        <div className="p-3 mb-4 bg-red-50 text-red-700 border border-red-200 rounded">
          {error}
        </div>
      )}

      {loading ? (
        <div>Загрузка…</div>
      ) : (
        <div className="space-y-3">
          {filtered.map(t => (
            <Link
              key={t.id}
              href={`/strategic-topics/${t.id}`}
              className="block bg-white rounded shadow hover:shadow-md transition-shadow border border-transparent hover:border-blue-200"
            >
              <div className="p-4 flex items-start gap-4">
                <div className="shrink-0 w-12 text-right">
                  <span className="font-mono text-2xl font-bold text-gray-300 leading-none">
                    {fmtSeq(t.seq)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${CATEGORY_COLOR[t.category] ?? 'bg-gray-100 text-gray-700'}`}>
                      {CATEGORY_LABEL[t.category] ?? t.category}
                    </span>
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOR[t.status] ?? 'bg-gray-100 text-gray-700'}`}>
                      {STATUS_LABEL[t.status] ?? t.status}
                    </span>
                    {t.code && (
                      <span className="text-xs font-mono text-gray-400">{t.code}</span>
                    )}
                  </div>
                  <h2 className="text-lg font-semibold text-gray-900">{t.title}</h2>
                  <p className="text-sm text-gray-600 mt-1 line-clamp-2">{t.synopsis}</p>
                </div>
              </div>
            </Link>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              {items.length === 0 ? 'Тем ещё нет' : 'По фильтрам ничего не нашлось'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
