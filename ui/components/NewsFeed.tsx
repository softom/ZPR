'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { ObjectBadge, ObjectRef } from '@/components/ObjectBadge'

type NewsRow = {
  id: string
  title: string
  body_md: string | null
  object_ids: string[]
  importance: 'high' | 'normal' | 'low'
  status: 'draft' | 'published' | 'archived'
  published_at: string | null
  created_at: string
}

const IMPORTANCE_COLOR: Record<NewsRow['importance'], string> = {
  high: '#ef4444',   // red-500
  normal: '#3b82f6', // blue-500
  low: '#94a3b8',    // slate-400
}

const FALLBACK_COLOR = '#94a3b8'

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function preview(md: string | null, max = 200): string {
  if (!md) return ''
  const stripped = md.replace(/^#+\s+/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return stripped.length > max ? stripped.slice(0, max).trimEnd() + '…' : stripped
}

function isImageUrl(s: string | null | undefined): s is string {
  return !!s && (s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://'))
}

export default function NewsFeed() {
  const [news, setNews] = useState<NewsRow[]>([])
  const [objects, setObjects] = useState<ObjectRef[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const objMap = useMemo(() => {
    const m = new Map<string, ObjectRef>()
    for (const o of objects) if (o.id) m.set(o.id, o)
    return m
  }, [objects])

  // 1) Один раз тянем справочник объектов
  useEffect(() => {
    let cancel = false
    async function loadObjects() {
      const { data, error } = await supabase
        .from('objects')
        .select('id,code,current_name,color,icon,icon_small')
        .eq('active', true)
        .order('code', { ascending: true })
      if (cancel) return
      if (error) { setError(error.message); return }
      setObjects((data ?? []) as ObjectRef[])
    }
    loadObjects()
    return () => { cancel = true }
  }, [])

  // 2) Тянем новости (с учётом фильтра по объектам)
  useEffect(() => {
    let cancel = false
    async function loadNews() {
      setLoading(true)
      setError(null)
      let q = supabase
        .from('news')
        .select('id,title,body_md,object_ids,importance,status,published_at,created_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(20)
      if (selectedIds.size > 0) {
        // overlaps: object_ids && '{a,b,c}' — есть пересечение
        q = q.overlaps('object_ids', Array.from(selectedIds))
      }
      const { data, error } = await q
      if (cancel) return
      if (error) { setError(error.message); setLoading(false); return }
      setNews((data ?? []) as NewsRow[])
      setLoading(false)
    }
    loadNews()
    return () => { cancel = true }
  }, [selectedIds])

  function toggle(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function clear() {
    setSelectedIds(new Set())
  }

  return (
    <div>
      {/* Фильтр по объектам */}
      {objects.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={clear}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              selectedIds.size === 0
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            Все
          </button>
          {objects.map(o => {
            const active = !!o.id && selectedIds.has(o.id)
            const color = o.color ?? FALLBACK_COLOR
            return (
              <button
                type="button"
                key={o.id}
                onClick={() => o.id && toggle(o.id)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors"
                style={
                  active
                    ? { backgroundColor: color, color: '#fff', borderColor: color }
                    : { backgroundColor: 'white', borderColor: '#e5e7eb' }
                }
                title={o.current_name ?? o.code}
              >
                {isImageUrl(o.icon_small ?? o.icon)
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={(o.icon_small ?? o.icon)!} alt="" width={14} height={14} className="inline-block object-contain rounded-sm" />
                  : <span aria-hidden>{o.icon ?? o.code.charAt(0)}</span>}
                <span className="font-mono">{o.code}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Лента */}
      {loading ? (
        <div className="text-sm text-gray-400">Загружаю новости…</div>
      ) : error ? (
        <div className="text-sm text-red-600">Ошибка загрузки: {error}</div>
      ) : news.length === 0 ? (
        <div className="text-sm text-gray-400">
          {selectedIds.size > 0 ? 'По выбранным объектам новостей нет.' : 'Новостей пока нет.'}
        </div>
      ) : (
        <div>
          {(() => {
            // Группируем новости по дате (DD.MM.YYYY)
            const groups: Array<{ date: string; items: NewsRow[] }> = []
            let current: { date: string; items: NewsRow[] } | null = null
            for (const n of news) {
              const d = formatDate(n.published_at ?? n.created_at)
              if (!current || current.date !== d) {
                current = { date: d, items: [] }
                groups.push(current)
              }
              current.items.push(n)
            }
            return groups.map(g => (
              <section key={g.date} className="mb-5 last:mb-0">
                {/* Разделитель-дата */}
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-base font-semibold text-gray-600 font-mono whitespace-nowrap">
                    {g.date}
                  </span>
                  <span className="flex-1 h-px bg-gray-200" aria-hidden />
                </div>

                {/* Карточки этой даты — с отступом примерно на пол даты */}
                <ul className="space-y-2 ml-12">
                  {g.items.map(n => (
                    <li
                      key={n.id}
                      className="flex items-stretch bg-white border border-gray-200 rounded-lg overflow-hidden hover:border-blue-300 transition-colors"
                    >
                      <div
                        className="w-1 shrink-0"
                        style={{ backgroundColor: IMPORTANCE_COLOR[n.importance] }}
                        aria-hidden
                      />
                      {/* Заголовок + превью */}
                      <div className="flex-1 min-w-0 px-3 py-3">
                        <h3 className="text-sm font-medium text-gray-900 leading-snug">{n.title}</h3>
                        {n.body_md && (
                          <p className="mt-1 text-xs text-gray-500 line-clamp-2">{preview(n.body_md)}</p>
                        )}
                      </div>
                      {/* Объекты — справа в колонку */}
                      {n.object_ids.length > 0 && (
                        <div className="shrink-0 w-[200px] px-3 py-3 flex flex-col items-start gap-1 border-l border-gray-100">
                          {n.object_ids.map(id => {
                            const o = objMap.get(id)
                            if (!o) return null
                            return <ObjectBadge key={id} object={o} variant="compact" />
                          })}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          })()}
        </div>
      )}
    </div>
  )
}
