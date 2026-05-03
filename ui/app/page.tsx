'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import ProjectGanttView from '@/components/ProjectGanttView'

// ─── Types ────────────────────────────────────────────────────────────────────

type SearchResult = {
  document_id: string
  title: string
  folder_path: string | null
  object_codes: string[] | null
  chunk_text: string
  similarity: number | null
}

type Citation = {
  n: number
  document_id: string
  title: string
  folder_path: string | null
  object_codes: string[] | null
  doc_type: string | null
  contractor_codes: string[] | null
  similarity: number | null
  snippet: string
}

type EntityMatch = { type: 'contractor' | 'object'; key: string; matched_from: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}


// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const router = useRouter()
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched]   = useState(false)

  const [answer, setAnswer]         = useState<string | null>(null)
  const [citations, setCitations]   = useState<Citation[]>([])
  const [asking, setAsking]         = useState(false)
  const [askError, setAskError]     = useState<string | null>(null)
  const [entitiesMatched, setEntitiesMatched] = useState<EntityMatch[]>([])


  // Search
  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); setSearched(false); return }
    setSearching(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      setResults(data)
      setSearched(true)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  const debouncedSearch = useDebounce(doSearch, 350)

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setQuery(v)
    // При редактировании запроса — сбрасываем предыдущий ИИ-ответ
    if (answer || askError) {
      setAnswer(null); setCitations([]); setAskError(null); setEntitiesMatched([])
    }
    debouncedSearch(v)
  }

  async function doAsk() {
    const q = query.trim()
    if (q.length < 3 || asking) return
    setAsking(true)
    setAskError(null)
    setAnswer(null)
    setCitations([])
    setEntitiesMatched([])
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const data = await res.json()
      if (!res.ok) {
        setAskError(data?.error ?? 'Ошибка запроса')
      } else {
        setAnswer(data.answer ?? '')
        setCitations(data.citations ?? [])
        setEntitiesMatched(data.entities_matched ?? [])
      }
    } catch {
      setAskError('Сеть недоступна')
    } finally {
      setAsking(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      doAsk()
    }
  }

  // Рендер ответа с кликабельными маркерами цитат [N]
  function renderAnswer(text: string) {
    const parts = text.split(/(\[\d+\])/g)
    return parts.map((p, i) => {
      const m = p.match(/^\[(\d+)\]$/)
      if (m) {
        const n = parseInt(m[1], 10)
        return (
          <a
            key={i}
            href={`#cite-${n}`}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(`cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
            className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 mx-0.5 text-[10px] font-semibold rounded bg-blue-100 text-blue-700 hover:bg-blue-200 align-super no-underline"
          >
            {n}
          </a>
        )
      }
      return <span key={i}>{p}</span>
    })
  }

  function highlight(text: string, q: string) {
    if (!q || !text) return text
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
    return parts.map((p, i) =>
      p.toLowerCase() === q.toLowerCase()
        ? <mark key={i} className="bg-yellow-100 text-yellow-900 rounded px-0.5">{p}</mark>
        : p
    )
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold text-gray-900">Добро пожаловать</h1>
      <p className="mt-1 text-gray-500 text-sm">Система управления документами проекта ЗПР.</p>

      {/* ── Поиск ── */}
      <div className="mt-6 max-w-2xl relative">
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm select-none">🔍</span>
            <input
              type="search"
              placeholder="Поиск по документам… (Enter — спросить ИИ)"
              value={query}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              className="w-full pl-9 pr-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent bg-white"
            />
            {searching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs animate-pulse">…</span>
            )}
          </div>
          <button
            onClick={doAsk}
            disabled={query.trim().length < 3 || asking}
            className="shrink-0 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
            title="Спросить ИИ по материалам проекта"
          >
            {asking ? 'Думаю…' : '✨ Спросить ИИ'}
          </button>
        </div>

        {/* ── Ответ ИИ ── */}
        {askError && (
          <div className="mt-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {askError}
          </div>
        )}

        {asking && !answer && (
          <div className="mt-2 px-4 py-3 bg-blue-50 border border-blue-100 rounded-lg text-sm text-blue-700 flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
            Ищу в материалах и формирую ответ…
          </div>
        )}

        {answer && (
          <div className="mt-2 bg-white border border-blue-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 text-[11px] font-medium text-blue-700 uppercase tracking-wide flex items-center justify-between">
              <span>Ответ ИИ</span>
              <span className="text-blue-400 font-normal normal-case">по {citations.length} источникам</span>
            </div>
            {entitiesMatched.length > 0 && (
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-800 flex items-center gap-2 flex-wrap">
                <span className="font-semibold uppercase tracking-wide">Фильтр:</span>
                {entitiesMatched.map((e, i) => (
                  <span
                    key={`${e.type}-${e.key}-${i}`}
                    className="px-1.5 py-0.5 rounded bg-amber-100 border border-amber-200 font-medium"
                    title={`распознано из «${e.matched_from}»`}
                  >
                    {e.type === 'contractor' ? '👷' : '🏗️'} {e.key}
                  </span>
                ))}
              </div>
            )}
            <div className="px-4 py-3 text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
              {renderAnswer(answer)}
            </div>
            {citations.length > 0 && (
              <div className="border-t border-gray-100 px-4 py-3">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Источники</p>
                <ul className="space-y-2">
                  {citations.map(c => (
                    <li
                      key={c.n}
                      id={`cite-${c.n}`}
                      className="p-2.5 rounded border border-gray-200 bg-gray-50 hover:bg-white hover:border-blue-300 cursor-pointer transition-colors"
                      onClick={() => router.push('/contracts')}
                    >
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 text-[10px] font-semibold rounded bg-blue-100 text-blue-700">
                          {c.n}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-sm font-medium text-gray-900 line-clamp-1">{c.title}</span>
                            <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                              {c.doc_type && (
                                <span className="px-1 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 border border-gray-200">{c.doc_type}</span>
                              )}
                              {c.contractor_codes?.map(code => (
                                <span key={`k-${code}`} className="px-1 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 border border-amber-100" title="подрядчик">👷 {code}</span>
                              ))}
                              {c.object_codes?.map(code => (
                                <span key={code} className="px-1 py-0.5 text-[10px] rounded bg-blue-50 text-blue-700 border border-blue-100">{code}</span>
                              ))}
                            </div>
                          </div>
                          {c.snippet && (
                            <p className="mt-1 text-xs text-gray-500 line-clamp-2">{c.snippet}</p>
                          )}
                          {c.folder_path && (
                            <p className="mt-1 text-[10px] text-gray-300 font-mono truncate">{c.folder_path}</p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ── Живой поиск (чанки) — показываем только если нет ИИ-ответа ── */}
        {searched && !answer && !asking && (
          <div className="mt-2 bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            {results.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-400">Ничего не найдено по запросу «{query}»</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {results.map((r, i) => (
                  <li key={i} className="px-4 py-3 hover:bg-gray-50 cursor-pointer"
                    onClick={() => router.push('/contracts')}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900">{highlight(r.title, query)}</span>
                      <div className="flex gap-1 shrink-0">
                        {r.object_codes?.map(c => (
                          <span key={c} className="px-1 py-0.5 text-[10px] rounded bg-blue-50 text-blue-700 border border-blue-100">{c}</span>
                        ))}
                      </div>
                    </div>
                    {r.chunk_text && (
                      <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">
                        …{highlight(r.chunk_text.slice(0, 200), query)}…
                      </p>
                    )}
                    {r.folder_path && (
                      <p className="mt-0.5 text-[10px] text-gray-300 font-mono truncate">{r.folder_path}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── Сводный график проекта ── */}
      <div className="mt-8">
        <h2 className="text-base font-semibold text-gray-800 mb-3">Сводный график проекта</h2>
        <ProjectGanttView />
      </div>

      {/* ── Навигация ── */}
      <div className="mt-8 grid grid-cols-3 gap-4 max-w-2xl">
        <a href="/objects"
          className="block p-5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition">
          <p className="font-medium text-gray-900">Объекты</p>
          <p className="mt-1 text-sm text-gray-500">Реестр строительных объектов</p>
        </a>
        <a href="/contracts"
          className="block p-5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition">
          <p className="font-medium text-gray-900">Договора</p>
          <p className="mt-1 text-sm text-gray-500">Загрузка и реестр договоров</p>
        </a>
        <a href="/incoming"
          className="block p-5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition">
          <p className="font-medium text-gray-900">Входящие</p>
          <p className="mt-1 text-sm text-gray-500">Входящая корреспонденция</p>
        </a>
      </div>
    </div>
  )
}
