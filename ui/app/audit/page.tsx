'use client'

/**
 * /audit — Конструктор запросов «Связка Объект ↔ Зона ↔ Участок».
 *
 * Что показывает:
 *   • Слева: Leaflet-карта со всеми участками. Совпавшие с пресетом + фильтрами
 *     полигоны подсвечиваются цветом, остальные — серые тонкие.
 *   • Справа: панель с пресетами, условиями (role/queue/площадь/привязки),
 *     сводкой и CSV-экспортом.
 *   • Под картой: таблица «Бизнес-объекты без участков» (когда пресет такой).
 *
 * Пресеты:
 *   • plots-no-object        — plots где effective_object_ids = []
 *   • objects-no-plots       — objects у которых ни одного plot через effective_object_ids
 *   • container-anomalies    — is_container=true И child_count=0 (после правки данных)
 *   • custom                 — без пресета, только фильтры
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Script from 'next/script'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { LeafletGeoJSON, LeafletMap } from '@/lib/leaflet/types'

// ============================================================================
// Типы (упрощённое подмножество geojson properties из /api/plots/geojson)

type PlotProps = {
  plot_id: string
  plot_code: string
  plot_name: string | null
  role: 'plot' | 'servitude' | 'partial' | 'cadastral'
  area_calc_m2: number | null
  area_declared_m2: number | null
  functional_zone_code: string | null
  functional_queue: string | null
  functional_name: string | null
  effective_object_ids: string[]
  container_plot_id: string | null
  container_plot_code: string | null
  is_container: boolean
  child_count: number
  objects: Array<{ id: string; code: string; name: string; color: string | null }>
  masterplan_objects: Array<{ id: string; code: string; name_contract: string | null }>
}

type PlotFeature = {
  type: 'Feature'
  id?: string
  geometry: { type: string; coordinates: unknown }
  properties: PlotProps
}

type PlotsGeoJSON = { type: 'FeatureCollection'; features: PlotFeature[] }

type ObjectRow = { id: string; code: string; current_name: string; color: string | null }

type LeafletSubLayer = {
  feature?: { properties?: Record<string, unknown> }
  setStyle?: (style: object) => void
  getBounds?: () => unknown
}

// ============================================================================
// Пресеты и фильтры

type Preset = 'custom' | 'plots-no-object' | 'objects-no-plots' | 'container-anomalies'

const PRESET_LABELS: Record<Preset, string> = {
  'custom':                'Свой запрос',
  'plots-no-object':       'Участки без бизнес-объекта',
  'objects-no-plots':      'Бизнес-объекты без участков',
  'container-anomalies':   'Аномалии иерархии контейнеров',
}

const PRESET_DESCRIPTIONS: Record<Preset, string> = {
  'custom':              'Применять только условия из фильтра.',
  'plots-no-object':     'Plots, у которых effective_object_ids пустой и нет связи через мастерплан. Сервитуты исключены.',
  'objects-no-plots':    'Бизнес-объекты, к которым нет ни одного плота — ни через объектный override, ни через зону. Под картой — таблица.',
  'container-anomalies': 'Контейнеры с child_count=0 (после правки геометрии), либо дети без признанного контейнера на верхнем уровне.',
}

type Filters = {
  role: 'any' | 'plot' | 'servitude' | 'partial' | 'cadastral'
  queueOnly: '' | '1' | '2' | '3' | '4'
  hasZone: 'any' | 'yes' | 'no'
  isContainer: 'any' | 'yes' | 'no'
  minArea: string  // пользовательский ввод
  maxArea: string
}

const FILTERS_DEFAULT: Filters = {
  role: 'any',
  queueOnly: '',
  hasZone: 'any',
  isContainer: 'any',
  minArea: '',
  maxArea: '',
}

// ============================================================================

export default function AuditPage() {
  const mapRef = useRef<LeafletMap | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<LeafletGeoJSON | null>(null)
  const [leafletReady, setLeafletReady] = useState<boolean>(typeof window !== 'undefined' && !!window.L)

  const [geojson, setGeojson] = useState<PlotsGeoJSON | null>(null)
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [preset, setPreset] = useState<Preset>('plots-no-object')
  const [filters, setFilters] = useState<Filters>(FILTERS_DEFAULT)

  // ─── Загрузка ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let abort = false
    setLoading(true)
    setError(null)
    Promise.all([
      fetch('/api/plots/geojson?role=all').then(async r => {
        if (!r.ok) throw new Error(`plots/geojson HTTP ${r.status}`)
        return r.json() as Promise<PlotsGeoJSON>
      }),
      supabase
        .from('objects')
        .select('id,code,current_name,color')
        .eq('active', true)
        .order('code'),
    ]).then(([gj, objRes]) => {
      if (abort) return
      setGeojson(gj)
      setObjects((objRes.data ?? []) as ObjectRow[])
    }).catch(e => {
      if (!abort) setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    }).finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [])

  // ─── Множество object.id, у которых есть хотя бы один plot ─────────────────
  const objectIdsWithPlots = useMemo(() => {
    const set = new Set<string>()
    if (!geojson) return set
    for (const f of geojson.features) {
      for (const id of f.properties.effective_object_ids ?? []) set.add(id)
    }
    return set
  }, [geojson])

  // ─── Функция «совпадает ли plot с активным пресетом+фильтрами» ─────────────
  const matchPlot = useMemo(() => {
    return (p: PlotProps): boolean => {
      // Пресет
      switch (preset) {
        case 'plots-no-object': {
          if (p.role === 'servitude') return false
          const empty = (p.effective_object_ids?.length ?? 0) === 0
                     && (p.masterplan_objects?.length ?? 0) === 0
          if (!empty) return false
          break
        }
        case 'container-anomalies': {
          // Сейчас: только контейнер с child_count=0 (после правки геометрии).
          // В будущем — расширим (см. WIKI 34).
          if (!(p.is_container && p.child_count === 0)) return false
          break
        }
        case 'objects-no-plots':
          // Этот пресет про объекты, не про плоты — на карте показываем «все
          // плоты текущих объектов» как фон без подсветки.
          return false
        case 'custom':
          break
      }

      // Условия из фильтра
      if (filters.role !== 'any' && p.role !== filters.role) return false
      if (filters.queueOnly && p.functional_queue !== filters.queueOnly) return false
      if (filters.hasZone === 'yes' && !p.functional_zone_code) return false
      if (filters.hasZone === 'no'  &&  p.functional_zone_code) return false
      if (filters.isContainer === 'yes' && !p.is_container) return false
      if (filters.isContainer === 'no'  &&  p.is_container) return false
      const min = filters.minArea ? Number(filters.minArea) : null
      const max = filters.maxArea ? Number(filters.maxArea) : null
      const a = p.area_calc_m2 ?? p.area_declared_m2 ?? null
      if (min !== null && (a === null || a < min)) return false
      if (max !== null && (a === null || a > max)) return false

      return true
    }
  }, [preset, filters])

  // ─── Считаем совпадения ────────────────────────────────────────────────────
  const matched = useMemo(() => {
    if (!geojson) return [] as PlotFeature[]
    return geojson.features.filter(f => matchPlot(f.properties))
  }, [geojson, matchPlot])

  const objectsWithoutPlots = useMemo(() => {
    return objects.filter(o => !objectIdsWithPlots.has(o.id))
  }, [objects, objectIdsWithPlots])

  const summaryCount = preset === 'objects-no-plots' ? objectsWithoutPlots.length : matched.length

  // ─── Leaflet init ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !containerRef.current || mapRef.current) return
    const L = window.L
    if (!L) return

    const map = L.map(containerRef.current, { center: [45.18, 33.44], zoom: 13 })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [leafletReady])

  // ─── Перерисовка слоя ─────────────────────────────────────────────────────
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map || !geojson) return

    if (layerRef.current) {
      map.removeLayer(layerRef.current)
      layerRef.current = null
    }

    const matchedIds = new Set(matched.map(f => f.properties.plot_id))

    const layer = L.geoJSON(geojson, {
      style: (feature: unknown) => {
        const f = feature as { properties?: PlotProps }
        const p = f.properties
        if (!p) return { color: '#94a3b8', weight: 1, fillOpacity: 0.05 }
        if (matchedIds.has(p.plot_id)) {
          return { color: '#dc2626', weight: 3, fillOpacity: 0.5 }
        }
        if (p.role === 'servitude') return { color: '#f59e0b', weight: 0.7, fillOpacity: 0.05, dashArray: '4,3' }
        return { color: '#cbd5e1', weight: 0.7, fillOpacity: 0.07 }
      },
      onEachFeature: (feature: unknown, lyr: unknown) => {
        const f = feature as { properties?: PlotProps }
        const p = f.properties
        if (!p) return
        const objLabels = (p.objects ?? []).map(o => o.code).join(', ') || '—'
        const mpLabels = (p.masterplan_objects ?? []).map(o => o.code).join(', ') || '—'
        const html = `
          <div style="font-family:ui-monospace,monospace;font-size:12px;min-width:220px;">
            <div style="font-weight:600;color:#1e40af;">${p.plot_code}</div>
            <div style="margin-top:4px;color:#475569;">Роль: <b>${p.role}</b>${p.area_calc_m2 ? ` · ${Math.round(p.area_calc_m2).toLocaleString('ru')} м²` : ''}</div>
            <div style="color:#475569;">Зона ППТ: <b>${p.functional_zone_code ?? '—'}</b></div>
            ${p.container_plot_code ? `<div style="color:#475569;">Внутри контейнера: <b>${p.container_plot_code}</b></div>` : ''}
            ${p.is_container ? `<div style="color:#1d4ed8;">📦 Контейнер (${p.child_count} детей)</div>` : ''}
            <div style="color:#475569;margin-top:4px;">Бизнес: <b>${objLabels}</b></div>
            <div style="color:#475569;">Мастерплан: <b>${mpLabels}</b></div>
          </div>`
        ;(lyr as { bindPopup: (h: string) => unknown }).bindPopup(html)
        // Подпись кода прямо на полигоне для совпавших — чтобы сразу было видно.
        if (matchedIds.has(p.plot_id) && p.role !== 'servitude') {
          ;(lyr as { bindTooltip: (h: string, o?: object) => unknown }).bindTooltip(p.plot_code, {
            permanent: true,
            direction: 'center',
            className: 'audit-code-label',
          })
        }
      },
    })
    layer.addTo(map)
    layerRef.current = layer

    // Зум на совпавшие, если они есть.
    if (matched.length > 0) {
      const matchedLayer = L.geoJSON({
        type: 'FeatureCollection',
        features: matched,
      } as unknown as object)
      try {
        const b = matchedLayer.getBounds() as { isValid?: () => boolean }
        if (!b.isValid || b.isValid()) {
          map.fitBounds(b as unknown as object, { padding: [40, 40] } as object)
        }
      } catch { /* пустые bounds */ }
    }
  }, [geojson, matched])

  // ─── CSV export ───────────────────────────────────────────────────────────
  function downloadCsv() {
    const lines: string[] = []
    if (preset === 'objects-no-plots') {
      lines.push('object_code;object_name')
      for (const o of objectsWithoutPlots) {
        lines.push(`${csvField(o.code)};${csvField(o.current_name)}`)
      }
    } else {
      lines.push('plot_code;role;area_m2;zone_code;queue;container_plot;is_container;child_count;objects;masterplan')
      for (const f of matched) {
        const p = f.properties
        lines.push([
          csvField(p.plot_code),
          csvField(p.role),
          p.area_calc_m2 ? Math.round(p.area_calc_m2).toString() : '',
          csvField(p.functional_zone_code ?? ''),
          csvField(p.functional_queue ?? ''),
          csvField(p.container_plot_code ?? ''),
          p.is_container ? '1' : '0',
          p.child_count.toString(),
          csvField((p.objects ?? []).map(o => o.code).join('|')),
          csvField((p.masterplan_objects ?? []).map(o => o.code).join('|')),
        ].join(';'))
      }
    }
    const csv = '﻿' + lines.join('\n')  // BOM для Excel-кириллицы
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-${preset}-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <Script
        src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        strategy="afterInteractive"
        onLoad={() => setLeafletReady(true)}
      />

      <style jsx global>{`
        .leaflet-tooltip.audit-code-label {
          background: rgba(255, 255, 255, 0.85);
          border: 1px solid #fca5a5;
          box-shadow: none;
          padding: 1px 5px;
          font-family: ui-monospace, monospace;
          font-size: 11px;
          font-weight: 600;
          color: #991b1b;
          white-space: nowrap;
          pointer-events: none;
        }
        .leaflet-tooltip.audit-code-label::before { display: none; }
      `}</style>

      <div className="p-4 space-y-4 max-w-[1600px] mx-auto">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-xl font-semibold text-gray-800">
            Аудит данных · Связка Объект ↔ Зона ↔ Участок
          </h1>
          <Link href="/objects" className="text-sm text-blue-700 hover:underline">← К объектам</Link>
        </div>

        <div className="flex gap-4" style={{ height: '70vh', minHeight: 520 }}>
          {/* Карта */}
          <div className="flex-1 relative border border-gray-200 rounded-md overflow-hidden bg-gray-100">
            <div ref={containerRef} className="absolute inset-0" />
            {!leafletReady && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-white/50">
                <p className="text-sm text-gray-500">Загрузка карты…</p>
              </div>
            )}
            {error && (
              <div className="absolute bottom-2 left-2 right-2 bg-red-50 border border-red-300 rounded-md px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>

          {/* Панель */}
          <div className="w-80 shrink-0 flex flex-col gap-3 overflow-y-auto">
            {/* Пресеты */}
            <div className="border border-gray-200 rounded-md bg-white">
              <div className="px-3 py-2 border-b border-gray-200 text-xs font-semibold text-gray-600 bg-gray-50">
                Пресеты
              </div>
              <div className="divide-y divide-gray-100">
                {(Object.keys(PRESET_LABELS) as Preset[]).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPreset(p)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${preset === p ? 'bg-blue-100 font-semibold text-blue-800' : 'text-gray-700'}`}
                    title={PRESET_DESCRIPTIONS[p]}
                  >
                    {PRESET_LABELS[p]}
                  </button>
                ))}
              </div>
              <div className="px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500 leading-snug">
                {PRESET_DESCRIPTIONS[preset]}
              </div>
            </div>

            {/* Условия */}
            <div className="border border-gray-200 rounded-md bg-white">
              <div className="px-3 py-2 border-b border-gray-200 text-xs font-semibold text-gray-600 bg-gray-50">
                Условия
              </div>
              <div className="p-3 space-y-2 text-xs">
                <Row label="Роль">
                  <select
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                    value={filters.role}
                    onChange={e => setFilters({ ...filters, role: e.target.value as Filters['role'] })}
                  >
                    <option value="any">любая</option>
                    <option value="plot">plot</option>
                    <option value="servitude">servitude</option>
                    <option value="partial">partial</option>
                    <option value="cadastral">cadastral</option>
                  </select>
                </Row>
                <Row label="Очередь">
                  <select
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                    value={filters.queueOnly}
                    onChange={e => setFilters({ ...filters, queueOnly: e.target.value as Filters['queueOnly'] })}
                  >
                    <option value="">любая</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                  </select>
                </Row>
                <Row label="Есть зона ППТ">
                  <select
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                    value={filters.hasZone}
                    onChange={e => setFilters({ ...filters, hasZone: e.target.value as Filters['hasZone'] })}
                  >
                    <option value="any">любое</option>
                    <option value="yes">да</option>
                    <option value="no">нет</option>
                  </select>
                </Row>
                <Row label="Контейнер">
                  <select
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                    value={filters.isContainer}
                    onChange={e => setFilters({ ...filters, isContainer: e.target.value as Filters['isContainer'] })}
                  >
                    <option value="any">любое</option>
                    <option value="yes">только контейнеры</option>
                    <option value="no">только не-контейнеры</option>
                  </select>
                </Row>
                <Row label="S от, м²">
                  <input
                    type="number"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                    value={filters.minArea}
                    onChange={e => setFilters({ ...filters, minArea: e.target.value })}
                    placeholder=""
                  />
                </Row>
                <Row label="S до, м²">
                  <input
                    type="number"
                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs"
                    value={filters.maxArea}
                    onChange={e => setFilters({ ...filters, maxArea: e.target.value })}
                    placeholder=""
                  />
                </Row>
                <button
                  type="button"
                  onClick={() => setFilters(FILTERS_DEFAULT)}
                  className="text-[11px] text-gray-500 hover:text-gray-800 underline"
                >
                  Сбросить фильтры
                </button>
              </div>
            </div>

            {/* Сводка */}
            <div className="border border-gray-200 rounded-md bg-white">
              <div className="px-3 py-2 border-b border-gray-200 text-xs font-semibold text-gray-600 bg-gray-50">
                Сводка
              </div>
              <div className="p-3 text-sm">
                <div className="text-2xl font-bold text-red-700">{loading ? '…' : summaryCount}</div>
                <div className="text-xs text-gray-500">
                  {preset === 'objects-no-plots' ? 'бизнес-объектов без участков' : 'участков попадают под условия'}
                </div>
                <button
                  type="button"
                  onClick={downloadCsv}
                  disabled={summaryCount === 0}
                  className="mt-3 w-full px-3 py-1.5 text-xs font-medium border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ↓ CSV для Excel
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Список совпадений ─────────────────────────────────────────── */}
        {preset === 'objects-no-plots' ? (
          <div className="border border-gray-200 rounded-md bg-white">
            <div className="px-3 py-2 border-b border-gray-200 text-xs font-semibold text-gray-600 bg-gray-50">
              Бизнес-объекты без привязанных участков ({objectsWithoutPlots.length})
            </div>
            {objectsWithoutPlots.length === 0 ? (
              <div className="p-4 text-sm text-gray-400 italic">
                Все активные бизнес-объекты имеют хотя бы один привязанный участок (через override или через зону).
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {objectsWithoutPlots.map(o => (
                  <li key={o.id} className="px-3 py-2 text-sm flex items-center gap-3">
                    {o.color && (
                      <span className="w-3 h-3 rounded shrink-0" style={{ background: o.color }} />
                    )}
                    <span className="font-mono font-semibold text-blue-700">{o.code}</span>
                    <span className="text-gray-700 flex-1 truncate">{o.current_name}</span>
                    <Link href={`/objects?focus=${o.id}`} className="text-[11px] text-blue-700 hover:underline shrink-0">
                      открыть →
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="border border-gray-200 rounded-md bg-white">
            <div className="px-3 py-2 border-b border-gray-200 text-xs font-semibold text-gray-600 bg-gray-50">
              Список совпадений ({matched.length})
            </div>
            {matched.length === 0 ? (
              <div className="p-4 text-sm text-gray-400 italic">
                Под условия ничего не попало.
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Код</th>
                      <th className="px-3 py-1.5 text-left">Роль</th>
                      <th className="px-3 py-1.5 text-right">S, м²</th>
                      <th className="px-3 py-1.5 text-left">Зона</th>
                      <th className="px-3 py-1.5 text-left">Контейнер</th>
                      <th className="px-3 py-1.5 text-left">Бизнес</th>
                      <th className="px-3 py-1.5 text-left">Мастерплан</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {matched.slice(0, 200).map(f => {
                      const p = f.properties
                      return (
                        <tr key={p.plot_id} className="hover:bg-blue-50">
                          <td className="px-3 py-1 font-mono font-semibold text-blue-700">{p.plot_code}</td>
                          <td className="px-3 py-1">{p.role}</td>
                          <td className="px-3 py-1 text-right">{p.area_calc_m2 ? Math.round(p.area_calc_m2).toLocaleString('ru') : '—'}</td>
                          <td className="px-3 py-1 font-mono">{p.functional_zone_code ?? '—'}</td>
                          <td className="px-3 py-1 font-mono">{p.is_container ? `📦 ${p.child_count}` : (p.container_plot_code ?? '—')}</td>
                          <td className="px-3 py-1">{(p.objects ?? []).map(o => o.code).join(', ') || '—'}</td>
                          <td className="px-3 py-1">{(p.masterplan_objects ?? []).map(o => o.code).join(', ') || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {matched.length > 200 && (
                  <div className="px-3 py-2 text-[11px] text-gray-500 italic">
                    …показаны первые 200 из {matched.length}. Скачайте CSV для полного списка.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ============================================================================

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-24 shrink-0 text-gray-600">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function csvField(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return ''
  const needs = /[;\n"]/.test(s)
  if (!needs) return s
  return `"${s.replace(/"/g, '""')}"`
}
