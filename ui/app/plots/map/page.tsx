'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import Script from 'next/script'
import { supabase } from '@/lib/supabase'
import type { LeafletGeoJSON, LeafletMap } from '@/lib/leaflet/types'
import { iconHtml, isDataUrl } from '@/lib/objectIcon'

// ============================================================================

type Mode = 'staging' | 'target' | 'zone' | 'cadastrals'
type StagingKind = 'all' | 'участок' | 'контур' | 'сервитут'
type TargetRole  = 'all' | 'plot' | 'servitude'
type ZoneKind    = 'all' | 'hotel' | 'transit_hotel' | 'sport_entertainment' | 'food'
                 | 'transport_infra' | 'utility' | 'promenade' | 'energy' | 'other'

// Аудит-пресеты (работают только в режиме `target`). Подсвечивают красным
// плоты под условие, остальные затемняют серым. См. /audit для подробного
// конструктора (фильтры по очереди / площади / контейнерам / CSV-экспорт).
type Preset = 'none' | 'plots-no-object' | 'container-anomalies' | 'objects-no-plots'

const PRESET_LABELS: Record<Preset, string> = {
  'none':                'Все',
  'plots-no-object':     'Без бизнес-объекта',
  'container-anomalies': 'Аномалии контейнеров',
  'objects-no-plots':    'Объекты без участков',
}

const PRESET_DESCRIPTIONS: Record<Preset, string> = {
  'none':                'Обычный показ — раскраска по бизнес-объекту / зоне ППТ.',
  'plots-no-object':     'Plots с пустым effective_object_ids (нет ни override, ни зоны с объектом). Сервитуты исключены.',
  'container-anomalies': 'is_container=true, child_count=0 — контейнер без нарезки.',
  'objects-no-plots':    'Бизнес-объекты, у которых нет ни одного plot ни через override, ни через зону. Список — в панели справа.',
}

type ObjectRow = { id: string; code: string; current_name: string; color: string | null }

const STAGING_LABELS: Record<StagingKind, string> = {
  all:        'Все ЗУ',
  'участок':  'Участки',
  'контур':   'Контуры',
  'сервитут': 'Сервитуты',
}

const TARGET_LABELS: Record<TargetRole, string> = {
  all:        'Все ЗУ',
  'plot':     'Участки',
  'servitude':'Сервитуты',
}

const ZONE_LABELS: Record<ZoneKind, string> = {
  all:                  'Все зоны',
  hotel:                'Гостиничные / курортные',
  transit_hotel:        'Транзитные',
  sport_entertainment:  'Спорт / развлечения',
  food:                 'Общепит',
  transport_infra:      'Транспорт / парковки',
  utility:              'Хоз / админ',
  promenade:            'Набережные',
  energy:               'Энергетика',
  other:                'Прочее',
}

const STAGING_COLORS: Record<string, string> = {
  'участок':  '#3b82f6',
  'контур':   '#8b5cf6',
  'сервитут': '#f59e0b',
}

const ZONE_KIND_COLORS: Record<string, string> = {
  hotel:               '#3b82f6',
  transit_hotel:       '#6366f1',
  sport_entertainment: '#10b981',
  food:                '#f97316',
  transport_infra:     '#64748b',
  utility:             '#a3a3a3',
  promenade:           '#0ea5e9',
  energy:              '#eab308',
  other:               '#94a3b8',
}

const CADASTRAL_COLORS: Record<string, string> = {
  private:       '#ef4444', // красный — частная
  municipal:     '#3b82f6', // синий — муниципальная
  state_subject: '#10b981', // зелёный — субъект РФ
  state_federal: '#8b5cf6', // фиолетовый — федеральная
  mixed:         '#f59e0b', // оранжевый — совместная
  unknown:       '#94a3b8', // серый — не указана
}

const CADASTRAL_LABELS: Record<string, string> = {
  private:       'Частная',
  municipal:     'Муниципальная',
  state_subject: 'Субъект РФ',
  state_federal: 'Федеральная',
  mixed:         'Совместная',
  unknown:       'Не указана',
}

const UNASSIGNED_COLOR = '#94a3b8' // серый для plots без object_id

// ─── Helpers: per-layer style + popup (вынесены из компонента) ────────────

function layerStyle(
  layerType: Mode,
  feature: unknown,
  preset: Preset,
  matchedPlotIds: Set<string>,
): Record<string, unknown> {
  const f = feature as { properties?: Record<string, unknown> }
  const p = f?.properties ?? {}

  if (layerType === 'target') {
    // Аудит-пресет
    if (preset !== 'none' && preset !== 'objects-no-plots') {
      const id = p.plot_id as string | undefined
      if (id && matchedPlotIds.has(id)) return { color: '#dc2626', weight: 3, fillOpacity: 0.5 }
      if (p.role === 'servitude') return { color: '#f59e0b', weight: 0.7, fillOpacity: 0.05, dashArray: '4,3' }
      return { color: '#cbd5e1', weight: 0.7, fillOpacity: 0.07 }
    }
    const objs = (p.objects as Array<{ color: string | null }> | undefined) ?? []
    if (p.role === 'servitude') return { color: '#f59e0b', weight: 1.5, fillOpacity: 0.3 }
    return { color: objs[0]?.color || UNASSIGNED_COLOR, weight: 1.5, fillOpacity: 0.3 }
  }

  if (layerType === 'zone') {
    const objs = (p.objects as Array<{ color: string | null }> | undefined) ?? []
    const color = objs[0]?.color || ZONE_KIND_COLORS[(p.kind as string) ?? 'other'] || UNASSIGNED_COLOR
    return { color, weight: 2, fillOpacity: 0.4 }
  }

  if (layerType === 'cadastrals') {
    const own = (p.ownership as string | undefined) ?? 'unknown'
    const color = CADASTRAL_COLORS[own] ?? CADASTRAL_COLORS.unknown
    const seizure = p.is_seizure as boolean | undefined
    return { color, weight: seizure ? 3 : 2, fillOpacity: 0.35, dashArray: seizure ? '6,4' : undefined }
  }

  // staging
  const kind = (p.kind as string | undefined) ?? 'участок'
  return { color: STAGING_COLORS[kind] ?? '#64748b', weight: 1.5, fillOpacity: 0.3 }
}

function layerPopup(
  layerType: Mode,
  feature: unknown,
  lyr: unknown,
  preset: Preset,
  matchedPlotIds: Set<string>,
) {
  const f = feature as { properties?: Record<string, unknown> }
  const p = f?.properties ?? {}

  let html = ''

  if (layerType === 'cadastrals') {
    const own = (p.ownership as string | undefined) ?? 'unknown'
    const ownLabel = CADASTRAL_LABELS[own] ?? own
    const seizure = p.is_seizure as boolean | undefined
    const vri = p.vri_changes as Array<Record<string, unknown>> | null
    html = `
      <div style="font-family: ui-monospace, monospace; font-size: 12px; min-width: 240px;">
        <div style="font-weight: 600; color: #1e40af; font-size: 13px;">${p.cadastral_number ?? '—'}</div>
        <div style="margin-top: 4px;">
          <span style="display:inline-block; background:${CADASTRAL_COLORS[own] ?? '#94a3b8'}33; color:${CADASTRAL_COLORS[own] ?? '#94a3b8'}; border:1px solid ${CADASTRAL_COLORS[own] ?? '#94a3b8'}; padding:1px 8px; border-radius:12px; font-size:11px; font-weight:500;">${ownLabel}</span>
          ${seizure ? '<span style="display:inline-block; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; padding:1px 8px; border-radius:12px; font-size:11px; font-weight:500; margin-left:4px;">Изъятие</span>' : ''}
        </div>
        ${p.address ? `<div style="color:#64748b; margin-top:4px; font-size:11px;">${p.address}</div>` : ''}
        ${p.area_m2 ? `<div style="margin-top:4px;"><b>S:</b> ${Number(p.area_m2).toLocaleString('ru')} м²</div>` : ''}
        ${seizure && p.seizure_area_m2 ? `<div><b>S изъятия:</b> ${Number(p.seizure_area_m2).toLocaleString('ru')} м²</div>` : ''}
        ${p.category ? `<div><b>Категория:</b> ${p.category}</div>` : ''}
        ${p.vri ? `<div><b>ВРИ:</b> ${p.vri}</div>` : ''}
        ${vri && vri.length > 0 ? `<div style="margin-top:4px; padding-top:4px; border-top:1px solid #e5e7eb; color:#b45309; font-size:11px;"><b>Смена ВРИ:</b> ${vri.length} этап(ов)</div>` : ''}
      </div>`
  } else if (layerType === 'staging') {
    html = `
      <div style="font-family: ui-monospace, monospace; font-size: 12px; min-width: 200px;">
        <div style="font-weight: 600; color: #1e40af; margin-bottom: 4px;">${p.zu ?? '—'}</div>
        <div><b>Тип:</b> ${p.kind ?? '—'}</div>
        ${p.parent_zu ? `<div><b>Родитель:</b> ${p.parent_zu}</div>` : ''}
        ${p.address ? `<div><b>Адрес:</b> ${p.address}</div>` : ''}
        ${p.permitted_use ? `<div><b>ВРИ:</b> ${p.permitted_use}</div>` : ''}
        ${p.area_m2 ? `<div><b>S:</b> ${Number(p.area_m2).toLocaleString('ru')} м²</div>` : ''}
        <div style="color:#94a3b8; margin-top: 4px;">точек: ${p.points_count ?? '?'}</div>
      </div>`
  } else if (layerType === 'zone') {
    const oksList = (p.oks as Array<Record<string, unknown>>) || []
    const oksHtml = oksList.length > 0
      ? `<div style="margin-top:6px; padding-top:6px; border-top:1px solid #e5e7eb;"><div style="font-weight:600;color:#475569;margin-bottom:2px;">ОКС:</div>${oksList.map(o => `<div style="padding:2px 0;font-size:11px;">${o.name ?? '—'}${o.etazh_max ? ` · ${o.etazh_max} эт.` : ''}</div>`).join('')}</div>` : ''
    const objsBadge = ((p.objects as Array<{ code: string; color: string | null; icon: string | null }>) ?? [])
      .map(o => `<div style="background:${o.color ?? '#e5e7eb'};color:white;padding:2px 8px;border-radius:4px;display:inline-flex;align-items:center;font-weight:500;font-size:11px;">${iconHtml(o.icon, 14)} ${o.code}</div>`).join('')
    const plotCodes = (p.plot_codes as string[] | undefined) ?? []
    html = `
      <div style="font-family: ui-monospace, monospace; font-size: 12px; min-width: 260px;">
        <div style="font-weight: 600; color: #1e40af; font-size: 14px;">${p.zone_code ?? '—'}</div>
        <div style="color: #475569; margin-top: 2px;">${p.zone_name ?? ''}</div>
        ${objsBadge ? `<div style="margin-top:4px;display:flex;flex-direction:column;gap:2px;">${objsBadge}</div>` : '<div style="color:#94a3b8;font-style:italic;margin-top:4px;">без привязки</div>'}
        <div style="margin-top:6px;"><span style="color:#64748b">Тип:</span> ${p.kind ?? '—'}${p.queue ? ` · очередь ${p.queue}` : ''}</div>
        <div><b>Участков:</b> ${p.plots_count ?? 0} ${plotCodes.length > 0 ? `<span style="color:#94a3b8">(${plotCodes.slice(0, 3).join(', ')}${plotCodes.length > 3 ? ` +${plotCodes.length - 3}` : ''})</span>` : ''}</div>
        ${p.area_calc_m2 ? `<div><b>S:</b> ${Number(p.area_calc_m2).toLocaleString('ru', { maximumFractionDigits: 0 })} м²</div>` : ''}
        ${oksHtml}
      </div>`
  } else {
    // target (plots)
    const oksList = (p.oks as Array<Record<string, unknown>>) || []
    const oksHtml = oksList.length > 0
      ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;"><div style="font-weight:600;color:#475569;margin-bottom:2px;">ОКС:</div>${oksList.map(o => `<div style="padding:2px 0;font-size:11px;">${o.name ?? '—'}${o.etazh_max ? ` · ${o.etazh_max} эт.` : ''}</div>`).join('')}</div>` : ''
    const plotObjs = ((p.objects as Array<{ code: string; color: string | null; icon: string | null }>) ?? [])
    const objsBadge = plotObjs.length > 0
      ? plotObjs.map(o => `<div style="background:${o.color ?? '#e5e7eb'};color:white;padding:2px 8px;border-radius:4px;display:inline-flex;align-items:center;font-weight:500;font-size:11px;">${iconHtml(o.icon, 14)} ${o.code}</div>`).join('')
      : '<div style="color:#94a3b8;font-style:italic;margin-top:2px;">без привязки</div>'
    const funcInfo = p.functional_zone_code
      ? `<div style="color:#64748b;margin-top:4px;">Зона ППТ: <b>${p.functional_zone_code}</b>${p.functional_queue ? ` · очередь ${p.functional_queue}` : ''}</div>`
      : ''
    html = `
      <div style="font-family: ui-monospace, monospace; font-size: 12px; min-width: 240px;">
        <div style="font-weight: 600; color: #1e40af;">${p.plot_code ?? '—'}</div>
        <div style="margin-top:2px;display:flex;flex-direction:column;gap:2px;">${objsBadge}</div>
        <div style="margin-top:6px;"><b>Роль:</b> ${p.role ?? '—'}</div>
        ${p.permitted_use ? `<div><b>ВРИ:</b> ${p.permitted_use}</div>` : ''}
        ${p.area_calc_m2 ? `<div><b>S (рассч.):</b> ${Number(p.area_calc_m2).toLocaleString('ru', { maximumFractionDigits: 0 })} м²</div>` : ''}
        ${p.area_declared_m2 ? `<div><b>S (по ПМТ):</b> ${Number(p.area_declared_m2).toLocaleString('ru')} м²</div>` : ''}
        ${funcInfo}${oksHtml}
      </div>`
  }

  ;(lyr as { bindPopup: (h: string) => unknown }).bindPopup(html)

  // Подпись кода для аудит-пресета
  if (layerType === 'target' && preset !== 'none' && preset !== 'objects-no-plots') {
    const id = p.plot_id as string | undefined
    if (id && matchedPlotIds.has(id) && p.role !== 'servitude') {
      ;(lyr as { bindTooltip: (h: string, o?: object) => unknown }).bindTooltip(
        (p.plot_code as string) || '',
        { permanent: true, direction: 'center', className: 'plots-audit-code-label' },
      )
    }
  }
}

// ============================================================================

export default function PmtMapPage() {
  const mapRef = useRef<LeafletMap | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Per-layer Leaflet layers (multi-layer system)
  const layerRefsMap = useRef<Record<Mode, LeafletGeoJSON | null>>({
    target: null, zone: null, cadastrals: null, staging: null,
  })

  const [leafletReady, setLeafletReady] = useState(false)

  // При клиентской навигации Leaflet может быть уже загружен — onLoad не сработает повторно
  useEffect(() => {
    if (window.L) setLeafletReady(true)
  }, [])

  // ─── Граница проекта (overlay, не Mode) ──────────────────────────────────
  const boundaryLayerRef = useRef<LeafletGeoJSON | null>(null)
  const [showBoundary, setShowBoundary] = useState(true)
  const [boundaryData, setBoundaryData] = useState<{ type: string; features: Array<{ properties: Record<string, unknown> }> } | null>(null)

  useEffect(() => {
    let abort = false
    fetch('/api/boundary/geojson')
      .then(r => r.json())
      .then(data => { if (!abort) setBoundaryData(data) })
      .catch(() => {})
    return () => { abort = true }
  }, [])

  // ─── Multi-layer state ────────────────────────────────────────────────────
  // visibleLayers — какие слои видны на карте (чекбоксы)
  const [visibleLayers, setVisibleLayers] = useState<Set<Mode>>(new Set(['target']))
  // mode — активный слой для таблицы внизу
  const [mode, setMode] = useState<Mode>('target')
  // Per-layer GeoJSON data
  type GeoJsonData = { type: string; features: Array<{ properties: Record<string, unknown> }> } | null
  const [layerData, setLayerData] = useState<Record<Mode, GeoJsonData>>({
    target: null, zone: null, cadastrals: null, staging: null,
  })
  const [layerLoading, setLayerLoading] = useState<Record<Mode, boolean>>({
    target: false, zone: false, cadastrals: false, staging: false,
  })
  const [layerError, setLayerError] = useState<Record<Mode, string | null>>({
    target: null, zone: null, cadastrals: null, staging: null,
  })

  // Псевдонимы для обратной совместимости (таблица, пресеты, сводка)
  const geojson = layerData[mode]
  const loading = Object.values(layerLoading).some(v => v)
  const error = layerError[mode]

  // ─── Per-mode filters ─────────────────────────────────────────────────────
  const [stagingFilter, setStagingFilter] = useState<StagingKind>('all')
  const [targetFilter, setTargetFilter] = useState<TargetRole>('all')
  const [zoneFilter, setZoneFilter] = useState<ZoneKind>('all')
  const [cadGeomFilter, setCadGeomFilter] = useState<'all' | 'with_geom' | 'no_geom'>('all')
  const [cadProjectFilter, setCadProjectFilter] = useState<'all' | 'in_project' | 'outside'>('all')
  const [preset, setPreset] = useState<Preset>('none')
  const [objects, setObjects] = useState<ObjectRow[]>([])

  // Таблица под картой: реагирует на тот же режим/пресет/фильтр.
  const [tableOpen, setTableOpen] = useState(true)
  const [tableSearch, setTableSearch] = useState('')
  // Мультиселект строк (cadastrals mode)
  const [selectedKns, setSelectedKns] = useState<Set<string>>(new Set())
  // Полный список кадастров для таблицы (включая без геометрии)
  const [cadastralsList, setCadastralsList] = useState<Array<Record<string, unknown>>>([])
  const [cadastralsLoading, setCadastralsLoading] = useState(false)

  // ─── Cadastral geometry fetch state ───────────────────────────────────────
  const [geomStats, setGeomStats] = useState<{ total: number; with_geom: number; without_geom: number } | null>(null)
  const [pkkRunning, setPkkRunning] = useState(false)
  const [pkkLog, setPkkLog] = useState<Array<{
    kn: string
    status: 'pending' | 'fetching' | 'ok' | 'not_found_pkk' | 'no_geometry' | 'error' | 'skipped'
    polygons?: number
    error?: string
  }>>([])
  const pkkAbortRef = useRef(false)
  const pkkLogEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const kptInputRef = useRef<HTMLInputElement>(null)
  const [kptImporting, setKptImporting] = useState(false)
  const [kptResult, setKptResult] = useState<{
    total: number; created: number; updated: number; geom_set: number; errors: number
  } | null>(null)

  // ─── Переключение слоя (чекбокс) ─────────────────────────────────────────
  const toggleLayer = useCallback((layer: Mode) => {
    setVisibleLayers(prev => {
      const next = new Set(prev)
      if (next.has(layer)) {
        next.delete(layer)
      } else {
        next.add(layer)
        // Включили слой → делаем его активным для таблицы
        setMode(layer)
      }
      return next
    })
  }, [])

  // Если активный слой таблицы выключен — переключить на первый видимый
  useEffect(() => {
    if (!visibleLayers.has(mode)) {
      const order: Mode[] = ['target', 'zone', 'cadastrals', 'staging']
      const first = order.find(m => visibleLayers.has(m))
      if (first) setMode(first)
    }
  }, [visibleLayers, mode])

  const fetchGeomStats = useCallback(async () => {
    try {
      const r = await fetch('/api/cadastrals/geometry')
      setGeomStats(await r.json())
    } catch { /* noop */ }
  }, [])

  // Загрузка статистики и полного списка при переключении на кадастры
  const fetchCadastralsList = useCallback(async () => {
    setCadastralsLoading(true)
    try {
      const r = await fetch('/api/cadastrals?seizure=all')
      const data = await r.json()
      if (Array.isArray(data)) setCadastralsList(data)
    } catch { /* noop */ }
    setCadastralsLoading(false)
  }, [])

  // Загрузка статистики и полного списка при включении кадастров
  useEffect(() => {
    if (visibleLayers.has('cadastrals') || mode === 'cadastrals') {
      fetchGeomStats()
      fetchCadastralsList()
    }
  }, [visibleLayers, mode, fetchGeomStats, fetchCadastralsList])

  // Сбросить выделение при смене режима / фильтра / данных
  useEffect(() => { setSelectedKns(new Set()) }, [mode, geojson])

  /** Зум на feature по свойству (ищем во ВСЕХ видимых слоях) */
  const zoomToFeature = useCallback((propKey: string, propValue: string) => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return
    let found = false
    for (const layer of Object.values(layerRefsMap.current)) {
      if (found || !layer) continue
      layer.eachLayer((sub: any) => {
        if (found) return
        const fp = sub.feature?.properties
        if (fp && fp[propKey] === propValue) {
          found = true
          const bounds = sub.getBounds?.() ?? sub.getLatLng?.()
          if (bounds) {
            try {
              if (typeof bounds.isValid === 'function' && !bounds.isValid()) return
              map.fitBounds(bounds, { padding: [60, 60], maxZoom: 18 })
            } catch {
              map.setView(bounds, 17)
            }
            sub.openPopup?.()
          }
        }
      })
    }
  }, [])

  /** Переключить выделение кадастрового номера */
  const toggleKnSelection = useCallback((kn: string) => {
    setSelectedKns(prev => {
      const next = new Set(prev)
      if (next.has(kn)) next.delete(kn)
      else next.add(kn)
      return next
    })
  }, [])

  // Авто-скролл лога
  useEffect(() => {
    pkkLogEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [pkkLog])

  const handlePkkFetch = async () => {
    // Получить список КН без геометрии
    const res = await fetch('/api/cadastrals?seizure=all')
    const all: Array<{ cadastral_number: string; has_geom?: boolean }> = await res.json()
    const todo = all.filter(c => !c.has_geom)
    if (todo.length === 0) return

    setPkkRunning(true)
    pkkAbortRef.current = false
    const log: Array<{ kn: string; status: 'pending' | 'fetching' | 'ok' | 'not_found_pkk' | 'no_geometry' | 'error' | 'skipped'; polygons?: number; error?: string }> = todo.map(c => ({ kn: c.cadastral_number, status: 'pending' }))
    setPkkLog([...log])

    for (let i = 0; i < log.length; i++) {
      if (pkkAbortRef.current) {
        for (let j = i; j < log.length; j++) log[j] = { ...log[j], status: 'skipped' }
        setPkkLog([...log])
        break
      }
      log[i] = { ...log[i], status: 'fetching' }
      setPkkLog([...log])
      try {
        const r = await fetch('/api/cadastrals/geometry/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cadastral_number: log[i].kn }),
        })
        const result = await r.json()
        log[i] = { kn: log[i].kn, status: result.status, polygons: result.polygons, error: result.error }
      } catch (err) {
        log[i] = { kn: log[i].kn, status: 'error', error: String(err) }
      }
      setPkkLog([...log])
      if (i < log.length - 1 && !pkkAbortRef.current) {
        await new Promise(r => setTimeout(r, 1500))
      }
    }
    setPkkRunning(false)
    fetchGeomStats()
    // Перезагрузить GeoJSON кадастров чтобы увидеть новые контуры на карте
    refreshLayer('cadastrals')
  }

  const handleKptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setKptImporting(true)
    setKptResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const r = await fetch('/api/cadastrals/import-kpt', { method: 'POST', body: formData })
      const result = await r.json()
      if (result.error && !result.total) {
        alert(`Ошибка: ${result.error}`)
      } else {
        setKptResult({
          total: result.total ?? 0,
          created: result.created ?? 0,
          updated: result.updated ?? 0,
          geom_set: result.geom_set ?? 0,
          errors: result.errors ?? 0,
        })
        // Обновить статистику, карту и список
        fetchGeomStats()
        fetchCadastralsList()
        refreshLayer('cadastrals')
      }
    } catch (err) {
      alert(`Ошибка загрузки: ${err}`)
    }
    setKptImporting(false)
    if (kptInputRef.current) kptInputRef.current.value = ''
  }

  const handleGeomFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const json = JSON.parse(await file.text())
      const r = await fetch('/api/cadastrals/geometry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      })
      const result = await r.json()
      alert(`Загружено: ${result.ok} из ${result.total}${result.failed ? `, ошибок: ${result.failed}` : ''}`)
      fetchGeomStats()
      refreshLayer('cadastrals')
    } catch (err) {
      alert(`Ошибка: ${err}`)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ─── Per-layer URL computation ────────────────────────────────────────────
  const layerUrls = useMemo(() => ({
    target: preset !== 'none'
      ? `/api/plots/geojson?role=all`
      : `/api/plots/geojson?role=${encodeURIComponent(targetFilter)}`,
    zone: `/api/functional-objects/geojson?kind=${encodeURIComponent(zoneFilter)}`,
    cadastrals: `/api/cadastrals/geojson`,
    staging: `/api/pmt/geojson?kind=${encodeURIComponent(stagingFilter)}`,
  }), [stagingFilter, targetFilter, zoneFilter, preset])

  /** Принудительно перезагрузить один слой */
  const refreshLayer = useCallback((layer: Mode) => {
    const urls: Record<Mode, string> = {
      target: preset !== 'none'
        ? `/api/plots/geojson?role=all`
        : `/api/plots/geojson?role=${encodeURIComponent(targetFilter)}`,
      zone: `/api/functional-objects/geojson?kind=${encodeURIComponent(zoneFilter)}`,
      cadastrals: `/api/cadastrals/geojson`,
      staging: `/api/pmt/geojson?kind=${encodeURIComponent(stagingFilter)}`,
    }
    fetch(urls[layer])
      .then(r => r.json())
      .then(data => setLayerData(prev => ({ ...prev, [layer]: data })))
      .catch(() => {})
  }, [stagingFilter, targetFilter, zoneFilter, preset])

  // ─── Загрузка списка бизнес-объектов (нужно для пресета objects-no-plots) ──
  useEffect(() => {
    let abort = false
    supabase
      .from('objects')
      .select('id,code,current_name,color')
      .eq('active', true)
      .order('code')
      .then(({ data }) => { if (!abort) setObjects((data ?? []) as ObjectRow[]) })
    return () => { abort = true }
  }, [])

  // ─── Аудит-пресеты: id плотов под условие + бизнес-объекты без участков ───
  const matchedPlotIds = useMemo(() => {
    const set = new Set<string>()
    if (!geojson || mode !== 'target' || preset === 'none' || preset === 'objects-no-plots') return set
    for (const f of geojson.features) {
      const p = f.properties as Record<string, unknown>
      const id = p.plot_id as string | undefined
      if (!id) continue
      if (preset === 'plots-no-object') {
        if (p.role === 'servitude') continue
        const ids = (p.effective_object_ids as string[] | undefined) ?? []
        const mp = (p.masterplan_objects as unknown[] | undefined) ?? []
        if (ids.length === 0 && mp.length === 0) set.add(id)
      } else if (preset === 'container-anomalies') {
        if (p.is_container && (p.child_count as number) === 0) set.add(id)
      }
    }
    return set
  }, [geojson, preset, mode])

  const objectIdsWithPlots = useMemo(() => {
    const set = new Set<string>()
    if (!geojson || mode !== 'target') return set
    for (const f of geojson.features) {
      const ids = ((f.properties as Record<string, unknown>).effective_object_ids as string[] | undefined) ?? []
      for (const id of ids) set.add(id)
    }
    return set
  }, [geojson, mode])

  const objectsWithoutPlots = useMemo(
    () => objects.filter(o => !objectIdsWithPlots.has(o.id)),
    [objects, objectIdsWithPlots]
  )

  // Сводный счётчик для отображения в тулбаре.
  const presetCount = preset === 'objects-no-plots'
    ? objectsWithoutPlots.length
    : matchedPlotIds.size

  // ─── Строки таблицы под картой ────────────────────────────────────────────
  // В режиме target таблица фильтруется ровно тем же matchedPlotIds, что и
  // подсветка на карте — поэтому пользователь видит то же самое в двух
  // представлениях. В zone / staging / cadastrals — все feature.
  const tableRows = useMemo(() => {
    // Кадастры: полный список из отдельного API (включая без геометрии)
    if (mode === 'cadastrals') {
      let rows = cadastralsList
      // Фильтр по контуру (независимый)
      if (cadGeomFilter === 'with_geom') rows = rows.filter(p => p.has_geom === true)
      else if (cadGeomFilter === 'no_geom') rows = rows.filter(p => !p.has_geom)
      // Фильтр по проекту (независимый)
      if (cadProjectFilter === 'in_project') rows = rows.filter(p => p.in_project === true)
      else if (cadProjectFilter === 'outside') rows = rows.filter(p => p.in_project === false)
      if (tableSearch.trim()) {
        const q = tableSearch.trim().toLowerCase()
        rows = rows.filter(p => {
          const kn = ((p.cadastral_number as string) ?? '').toLowerCase()
          const addr = ((p.address as string) ?? '').toLowerCase()
          const vri = ((p.vri as string) ?? '').toLowerCase()
          return kn.includes(q) || addr.includes(q) || vri.includes(q)
        })
      }
      return rows
    }
    if (!geojson?.features) return [] as Array<Record<string, unknown>>
    const features = geojson.features as Array<{ properties: Record<string, unknown> }>
    let filtered = features
    if (mode === 'target' && preset !== 'none' && preset !== 'objects-no-plots') {
      filtered = features.filter(f => {
        const id = (f.properties.plot_id as string | undefined) ?? ''
        return matchedPlotIds.has(id)
      })
    }
    if (tableSearch.trim()) {
      const q = tableSearch.trim().toLowerCase()
      filtered = filtered.filter(f => {
        const p = f.properties
        const code = (p.plot_code ?? p.zone_code ?? p.zu ?? p.cadastral_number ?? '') as string
        const name = (p.plot_name ?? p.zone_name ?? p.permitted_use ?? '') as string
        return code.toLowerCase().includes(q) || name.toLowerCase().includes(q)
      })
    }
    return filtered.map(f => f.properties)
  }, [geojson, mode, preset, matchedPlotIds, tableSearch, cadastralsList, cadGeomFilter, cadProjectFilter])

  // CSV-экспорт текущей таблицы (то, что пользователь видит).
  function downloadTableCsv() {
    const lines: string[] = []
    if (preset === 'objects-no-plots' && mode === 'target') {
      lines.push('object_code;object_name')
      for (const o of objectsWithoutPlots) lines.push(`${csvField(o.code)};${csvField(o.current_name)}`)
    } else if (mode === 'target') {
      lines.push('plot_code;role;area_m2;zone_code;queue;container_plot;is_container;child_count;objects;masterplan')
      for (const p of tableRows) {
        const area = p.area_calc_m2 ?? p.area_declared_m2 ?? null
        lines.push([
          csvField(p.plot_code as string),
          csvField(p.role as string),
          area ? Math.round(area as number).toString() : '',
          csvField((p.functional_zone_code as string) ?? ''),
          csvField((p.functional_queue as string) ?? ''),
          csvField((p.container_plot_code as string) ?? ''),
          p.is_container ? '1' : '0',
          (p.child_count ?? 0).toString(),
          csvField(((p.objects as Array<{ code: string }>) ?? []).map(o => o.code).join('|')),
          csvField(((p.masterplan_objects as Array<{ code: string }>) ?? []).map(o => o.code).join('|')),
        ].join(';'))
      }
    } else if (mode === 'zone') {
      lines.push('zone_code;zone_name;kind;queue;plots_count;area_calc_m2;objects')
      for (const p of tableRows) {
        lines.push([
          csvField((p.zone_code as string) ?? ''),
          csvField((p.zone_name as string) ?? ''),
          csvField((p.kind as string) ?? ''),
          csvField((p.queue as string) ?? ''),
          (p.plots_count ?? 0).toString(),
          p.area_calc_m2 ? Math.round(p.area_calc_m2 as number).toString() : '',
          csvField(((p.objects as Array<{ code: string }>) ?? []).map(o => o.code).join('|')),
        ].join(';'))
      }
    } else if (mode === 'staging') {
      lines.push('zu;kind;parent_zu;address;permitted_use;area_m2')
      for (const p of tableRows) {
        lines.push([
          csvField((p.zu as string) ?? ''),
          csvField((p.kind as string) ?? ''),
          csvField((p.parent_zu as string) ?? ''),
          csvField((p.address as string) ?? ''),
          csvField((p.permitted_use as string) ?? ''),
          p.area_m2 ? Math.round(p.area_m2 as number).toString() : '',
        ].join(';'))
      }
    } else if (mode === 'cadastrals') {
      lines.push('cad_number;ownership;area_m2;vri;cadastral_cost;source;has_geom;in_project;address')
      for (const p of tableRows) {
        lines.push([
          csvField((p.cadastral_number as string) ?? ''),
          csvField((p.ownership as string) ?? ''),
          p.area_m2 ? Math.round(p.area_m2 as number).toString() : '',
          csvField((p.vri as string) ?? ''),
          p.cadastral_cost ? Math.round(p.cadastral_cost as number).toString() : '',
          csvField((p.source as string) ?? ''),
          p.has_geom ? '1' : '0',
          p.in_project === false ? '0' : '1',
          csvField((p.address as string) ?? ''),
        ].join(';'))
      }
    }
    const csv = '﻿' + lines.join('\n')  // BOM для Excel-кириллицы
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const link = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = link
    a.download = `plots-${mode}${preset !== 'none' ? '-' + preset : ''}-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(link)
  }

  // ─── Per-layer data fetch ───────────────────────────────────────────────
  // Для каждого видимого слоя грузим GeoJSON. При изменении фильтра слоя —
  // перезагружается только этот слой.
  useEffect(() => {
    const aborts: Record<string, boolean> = {}
    const allModes: Mode[] = ['target', 'zone', 'cadastrals', 'staging']

    for (const layer of allModes) {
      if (!visibleLayers.has(layer)) {
        // Очищаем данные невидимых слоёв
        setLayerData(prev => prev[layer] ? { ...prev, [layer]: null } : prev)
        continue
      }
      const layerUrl = layerUrls[layer]
      aborts[layer] = false
      setLayerLoading(prev => ({ ...prev, [layer]: true }))
      setLayerError(prev => ({ ...prev, [layer]: null }))

      fetch(layerUrl)
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}))
            throw new Error(body.error || `HTTP ${r.status}`)
          }
          return r.json()
        })
        .then((data) => {
          if (!aborts[layer]) setLayerData(prev => ({ ...prev, [layer]: data }))
        })
        .catch((e) => {
          if (!aborts[layer]) setLayerError(prev => ({ ...prev, [layer]: e instanceof Error ? e.message : 'Ошибка' }))
        })
        .finally(() => {
          if (!aborts[layer]) setLayerLoading(prev => ({ ...prev, [layer]: false }))
        })
    }

    return () => {
      for (const key of Object.keys(aborts)) aborts[key] = true
    }
  }, [visibleLayers, layerUrls])

  useEffect(() => {
    if (!leafletReady || !containerRef.current || mapRef.current) return
    const L = window.L
    if (!L) return

    const map = L.map(containerRef.current, { center: [45.18, 33.44], zoom: 14 })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)

    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRefsMap.current = { target: null, zone: null, cadastrals: null, staging: null }
      boundaryLayerRef.current = null
    }
  }, [leafletReady])

  // ─── Multi-layer render ─────────────────────────────────────────────────
  // Рисует ВСЕ видимые слои. Порядок: staging → target → zone → cadastrals
  // (кадастры поверх остальных для лучшей читаемости наложения).
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return

    // Порядок отрисовки (нижний → верхний)
    const renderOrder: Mode[] = ['staging', 'target', 'zone', 'cadastrals']
    let fitDone = false

    for (const layerType of renderOrder) {
      // Удалить старый слой этого типа
      const existing = layerRefsMap.current[layerType]
      if (existing) {
        map.removeLayer(existing)
        layerRefsMap.current[layerType] = null
      }

      // Если слой не видим или нет данных — пропускаем
      const data = layerData[layerType]
      if (!visibleLayers.has(layerType) || !data?.features?.length) continue

      const layer = L.geoJSON(data, {
        style: (feature: unknown) => layerStyle(layerType, feature, preset, matchedPlotIds),
        onEachFeature: (feature: unknown, lyr: unknown) => {
          layerPopup(layerType, feature, lyr, preset, matchedPlotIds)
        },
      })

      layer.addTo(map)
      layerRefsMap.current[layerType] = layer

      // Зум: для target с пресетом — на совпавшие; иначе на первый добавленный слой
      if (!fitDone) {
        try {
          if (layerType === 'target' && preset !== 'none' && preset !== 'objects-no-plots' && matchedPlotIds.size > 0) {
            const matched = data.features.filter((f: { properties: Record<string, unknown> }) => {
              const id = f.properties.plot_id as string | undefined
              return id && matchedPlotIds.has(id)
            })
            if (matched.length > 0) {
              const matchedLayer = L.geoJSON({ type: 'FeatureCollection', features: matched } as unknown as object)
              const b = matchedLayer.getBounds() as { isValid?: () => boolean }
              if (!b.isValid || b.isValid()) {
                map.fitBounds(b as unknown as object, { padding: [40, 40] } as object)
                fitDone = true
              }
            }
          }
          if (!fitDone) {
            map.fitBounds(layer.getBounds(), { padding: [20, 20] } as object)
            fitDone = true
          }
        } catch { /* empty bounds */ }
      }
    }
  }, [layerData, visibleLayers, preset, matchedPlotIds])

  // ─── Boundary overlay render ─────────────────────────────────────────────
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map) return

    // Удалить старый слой
    if (boundaryLayerRef.current) {
      map.removeLayer(boundaryLayerRef.current)
      boundaryLayerRef.current = null
    }

    if (!showBoundary || !boundaryData?.features?.length) return

    const layer = L.geoJSON(boundaryData, {
      style: () => ({
        color: '#dc2626',
        weight: 2.5,
        fillOpacity: 0.03,
        dashArray: '8,6',
        fillColor: '#fee2e2',
      }),
      onEachFeature: (feature: unknown, lyr: unknown) => {
        const f = feature as { properties?: Record<string, unknown> }
        const p = f?.properties ?? {}
        const area = Number(p.area_m2 ?? 0)
        const ha = area > 0 ? (area / 10000).toFixed(1) : '—'
        ;(lyr as { bindPopup: (h: string) => void }).bindPopup(
          `<div style="font-family:ui-monospace,monospace;font-size:12px;">
            <div style="font-weight:600;color:#dc2626;">Граница территории проектирования</div>
            <div style="margin-top:4px;"><b>S:</b> ${area > 0 ? area.toLocaleString('ru', { maximumFractionDigits: 0 }) : '—'} м² (${ha} га)</div>
          </div>`
        )
      },
    })

    // Добавляем на самый нижний z-уровень (перед всеми слоями данных)
    layer.addTo(map)
    layer.bringToBack()
    boundaryLayerRef.current = layer
  }, [boundaryData, showBoundary])

  // Сводка для легенды
  const targetSummary = useMemo(() => {
    if (mode !== 'target' || !geojson?.features) return null
    const byObject = new Map<string, { count: number; color: string; name: string; icon: string }>()
    let unassigned = 0
    let servitudes = 0
    for (const f of geojson.features) {
      const p = f.properties as Record<string, unknown>
      if (p.role === 'servitude') { servitudes++; continue }
      // M:N: feature может быть связан с несколькими объектами — учитываем все
      const objs = (p.objects as Array<{ code: string; name: string; color: string | null; icon: string | null }> | undefined) ?? []
      if (objs.length === 0) {
        unassigned++
      } else {
        for (const o of objs) {
          const existing = byObject.get(o.code)
          if (existing) existing.count++
          else byObject.set(o.code, {
            count: 1,
            color: o.color || UNASSIGNED_COLOR,
            name: o.name || o.code,
            icon: o.icon || '',
          })
        }
      }
    }
    return {
      objects: Array.from(byObject.entries()).map(([code, v]) => ({ code, ...v })).sort((a, b) => a.code.localeCompare(b.code)),
      unassigned,
      servitudes,
    }
  }, [geojson, mode])

  const zoneSummary = useMemo(() => {
    if (mode !== 'zone' || !geojson?.features) return null
    const byKind = new Map<string, number>()
    let withObject = 0
    let withoutObject = 0
    for (const f of geojson.features) {
      const p = f.properties as Record<string, unknown>
      const k = (p.kind as string) || 'other'
      byKind.set(k, (byKind.get(k) ?? 0) + 1)
      const objs = (p.objects as Array<unknown> | undefined) ?? []
      if (objs.length > 0) withObject++
      else withoutObject++
    }
    return {
      kinds: Array.from(byKind.entries()).sort((a, b) => b[1] - a[1]),
      withObject,
      withoutObject,
    }
  }, [geojson, mode])

  return (
    <>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <Script
        src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        strategy="afterInteractive"
        onLoad={() => setLeafletReady(true)}
      />

      <style jsx global>{`
        .leaflet-tooltip.plots-audit-code-label {
          background: rgba(255, 255, 255, 0.88);
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
        .leaflet-tooltip.plots-audit-code-label::before { display: none; }
      `}</style>

      <div className="flex flex-col h-full overflow-hidden">
        {/* Компактная шапка раздела. */}
        <div className="px-6 py-2.5 border-b border-gray-200 bg-white flex items-baseline gap-4">
          <h1 className="text-lg font-semibold text-gray-800">Карта</h1>
          <p className="text-xs text-gray-500">
            Слои, фильтры и аудит-пресеты — справа. Чекбокс = видимость, клик по названию = таблица.
          </p>
          <div className="flex-1" />
          <div className="text-xs text-gray-600 tabular-nums flex items-center gap-3">
            {loading && <span className="text-gray-400">Загрузка…</span>}
            {visibleLayers.has('target') && layerData.target && (
              <span>ЗУ: <b>{layerData.target.features?.length ?? 0}</b></span>
            )}
            {visibleLayers.has('zone') && layerData.zone && (
              <span>Зон: <b>{layerData.zone.features?.length ?? 0}</b></span>
            )}
            {visibleLayers.has('cadastrals') && layerData.cadastrals && (
              <span>КН: <b>{layerData.cadastrals.features?.length ?? 0}</b></span>
            )}
            {visibleLayers.has('staging') && layerData.staging && (
              <span>СТ: <b>{layerData.staging.features?.length ?? 0}</b></span>
            )}
          </div>
        </div>

        {error && (
          <div className="px-6 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 shrink-0">
            {error}
          </div>
        )}

        {/* Карта + правая панель в горизонтальном flex. */}
        <div className="flex flex-1 overflow-hidden">
          <div className="relative flex-1">
            <div ref={containerRef} className="absolute inset-0 bg-gray-100" />

            {visibleLayers.has('target') && preset !== 'none' && preset !== 'objects-no-plots' && !loading && matchedPlotIds.size === 0 && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white border border-gray-300 rounded-md shadow-sm text-xs text-gray-600 z-[400]">
                Под пресет «{PRESET_LABELS[preset]}» ничего не попало
              </div>
            )}

            {!leafletReady && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-white/50">
                <p className="text-sm text-gray-500">Загрузка Leaflet…</p>
              </div>
            )}
          </div>

          {/* ─── Правая панель: режим + фильтры + аудит + сводка ─────── */}
          <aside className="w-80 shrink-0 border-l border-gray-200 bg-gray-50 overflow-y-auto flex flex-col gap-3 p-3 text-xs">
            {/* ─── Граница проекта (overlay toggle) ─────────────────── */}
            <label className="flex items-center gap-2 cursor-pointer px-3 py-2 border border-gray-200 rounded-md bg-white hover:bg-red-50/30 transition-colors">
              <input type="checkbox" className="accent-red-600"
                checked={showBoundary}
                onChange={() => setShowBoundary(v => !v)}
              />
              <span className={`font-medium text-[11px] ${showBoundary ? 'text-red-700' : 'text-gray-500'}`}>Граница проекта</span>
              {boundaryData && (
                <span className="ml-auto text-[10px] text-gray-400">
                  {((Number(boundaryData.features?.[0]?.properties?.area_m2) || 0) / 10000).toFixed(1)} га
                </span>
              )}
            </label>

            {/* ─── Слои карты (чекбоксы + фильтры) ───────────────────── */}
            <div className="border border-gray-200 rounded-md bg-white">
              <div className="px-3 py-2 border-b border-gray-200 text-[11px] font-semibold text-gray-600 bg-gray-50 uppercase tracking-wide">
                Слои карты
              </div>
              <div className="divide-y divide-gray-100">
                {/* ── Участки ──────────────────────────────────────────── */}
                <div className="p-2 space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-blue-600"
                      checked={visibleLayers.has('target')}
                      onChange={() => toggleLayer('target')}
                    />
                    <button
                      onClick={() => setMode('target')}
                      className={`font-medium ${mode === 'target' ? 'text-blue-700 underline underline-offset-2' : 'text-gray-700 hover:text-blue-600'}`}
                    >Участки</button>
                    {layerLoading.target && <span className="text-blue-400 animate-pulse ml-auto text-[10px]">…</span>}
                    {layerData.target && <span className="ml-auto text-[10px] text-gray-400">{layerData.target.features?.length ?? 0}</span>}
                  </label>
                  {visibleLayers.has('target') && (
                    <div className="pl-6 flex flex-wrap gap-1">
                      {(Object.keys(TARGET_LABELS) as TargetRole[]).map((k) => (
                        <button key={k} onClick={() => setTargetFilter(k)}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                            targetFilter === k
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                          }`}>{TARGET_LABELS[k]}</button>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Зоны ППТ ─────────────────────────────────────────── */}
                <div className="p-2 space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-indigo-600"
                      checked={visibleLayers.has('zone')}
                      onChange={() => toggleLayer('zone')}
                    />
                    <button
                      onClick={() => setMode('zone')}
                      className={`font-medium ${mode === 'zone' ? 'text-indigo-700 underline underline-offset-2' : 'text-gray-700 hover:text-indigo-600'}`}
                    >Зоны ППТ</button>
                    {layerLoading.zone && <span className="text-indigo-400 animate-pulse ml-auto text-[10px]">…</span>}
                    {layerData.zone && <span className="ml-auto text-[10px] text-gray-400">{layerData.zone.features?.length ?? 0}</span>}
                  </label>
                  {visibleLayers.has('zone') && (
                    <div className="pl-6 flex flex-wrap gap-1">
                      {(Object.keys(ZONE_LABELS) as ZoneKind[]).map((k) => (
                        <button key={k} onClick={() => setZoneFilter(k)}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                            zoneFilter === k
                              ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                          }`}>{ZONE_LABELS[k]}</button>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Кадастры ─────────────────────────────────────────── */}
                <div className="p-2 space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-amber-600"
                      checked={visibleLayers.has('cadastrals')}
                      onChange={() => toggleLayer('cadastrals')}
                    />
                    <button
                      onClick={() => setMode('cadastrals')}
                      className={`font-medium ${mode === 'cadastrals' ? 'text-amber-700 underline underline-offset-2' : 'text-gray-700 hover:text-amber-600'}`}
                    >Кадастры</button>
                    {layerLoading.cadastrals && <span className="text-amber-400 animate-pulse ml-auto text-[10px]">…</span>}
                    {layerData.cadastrals && <span className="ml-auto text-[10px] text-gray-400">{layerData.cadastrals.features?.length ?? 0}</span>}
                  </label>
                  {(visibleLayers.has('cadastrals') || mode === 'cadastrals') && (
                    <div className="pl-6 space-y-1">
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400 uppercase tracking-wide w-12 shrink-0">Контур</span>
                        {(['all', 'with_geom', 'no_geom'] as const).map((k) => (
                          <button key={k} onClick={() => setCadGeomFilter(k)}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                              cadGeomFilter === k
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                            }`}>{k === 'all' ? 'Все' : k === 'with_geom' ? 'Есть' : 'Нет'}</button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400 uppercase tracking-wide w-12 shrink-0">Проект</span>
                        {(['all', 'in_project', 'outside'] as const).map((k) => (
                          <button key={k} onClick={() => setCadProjectFilter(k)}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                              cadProjectFilter === k
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                            }`}>{k === 'all' ? 'Все' : k === 'in_project' ? 'В проекте' : 'Вне'}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Стейджинг ────────────────────────────────────────── */}
                <div className="p-2 space-y-1.5">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-gray-600"
                      checked={visibleLayers.has('staging')}
                      onChange={() => toggleLayer('staging')}
                    />
                    <button
                      onClick={() => setMode('staging')}
                      className={`font-medium ${mode === 'staging' ? 'text-gray-800 underline underline-offset-2' : 'text-gray-700 hover:text-gray-900'}`}
                    >Стейджинг</button>
                    {layerLoading.staging && <span className="text-gray-400 animate-pulse ml-auto text-[10px]">…</span>}
                    {layerData.staging && <span className="ml-auto text-[10px] text-gray-400">{layerData.staging.features?.length ?? 0}</span>}
                  </label>
                  {visibleLayers.has('staging') && (
                    <div className="pl-6 flex flex-wrap gap-1">
                      {(Object.keys(STAGING_LABELS) as StagingKind[]).map((k) => (
                        <button key={k} onClick={() => setStagingFilter(k)}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                            stagingFilter === k
                              ? 'bg-gray-200 text-gray-800 border-gray-300'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                          }`}>{STAGING_LABELS[k]}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Загрузка геометрии — только когда кадастры включены */}
            {(visibleLayers.has('cadastrals') || mode === 'cadastrals') && (
              <div className="border border-amber-200 rounded-md bg-amber-50/50">
                <div className="px-3 py-2 border-b border-amber-200 text-[11px] font-semibold text-amber-700 bg-amber-50 uppercase tracking-wide">
                  Контуры ПКК
                </div>
                <div className="p-2 space-y-2">
                  {/* Stats line */}
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-gray-600">
                      Контуры: <b className={geomStats?.with_geom ? 'text-green-600' : 'text-gray-400'}>{geomStats?.with_geom ?? '—'}</b>
                      <span className="text-gray-400"> / {geomStats?.total ?? '—'}</span>
                    </span>
                    {geomStats && geomStats.without_geom > 0 && (
                      <span className="text-amber-600">({geomStats.without_geom} без контура)</span>
                    )}
                  </div>

                  {/* Buttons row 1: PKK + JSON */}
                  <div className="flex gap-1.5">
                    {!pkkRunning ? (
                      <button
                        onClick={handlePkkFetch}
                        disabled={!geomStats || geomStats.without_geom === 0}
                        className="flex-1 px-2 py-1.5 bg-amber-500 text-white text-[11px] font-medium rounded hover:bg-amber-600 disabled:opacity-40 transition-colors"
                      >
                        Загрузить из ПКК
                      </button>
                    ) : (
                      <button
                        onClick={() => { pkkAbortRef.current = true }}
                        className="flex-1 px-2 py-1.5 bg-red-500 text-white text-[11px] font-medium rounded hover:bg-red-600 transition-colors"
                      >
                        Остановить
                      </button>
                    )}
                    <input ref={fileInputRef} type="file" accept=".json,.geojson" onChange={handleGeomFileUpload} className="hidden" />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={pkkRunning}
                      className="px-2 py-1.5 bg-white text-amber-700 border border-amber-300 text-[11px] rounded hover:bg-amber-50 disabled:opacity-40 transition-colors"
                      title="Загрузить контуры из JSON/GeoJSON файла"
                    >
                      JSON
                    </button>
                  </div>

                  {/* Button row 2: KPT XML upload */}
                  <div className="flex gap-1.5">
                    <input ref={kptInputRef} type="file" accept=".xml,.zip" onChange={handleKptUpload} className="hidden" />
                    <button
                      onClick={() => kptInputRef.current?.click()}
                      disabled={kptImporting || pkkRunning}
                      className="flex-1 px-2 py-1.5 bg-blue-500 text-white text-[11px] font-medium rounded hover:bg-blue-600 disabled:opacity-40 transition-colors"
                      title="Импорт участков из КПТ XML (.xml или .xml.zip) — геометрия + метаданные"
                    >
                      {kptImporting ? 'Импорт КПТ…' : '📄 Импорт из КПТ XML'}
                    </button>
                  </div>

                  {/* KPT import result */}
                  {kptResult && (
                    <div className="bg-white rounded border border-blue-100 p-2 text-[10px] space-y-0.5">
                      <div className="font-semibold text-blue-700">Результат импорта КПТ:</div>
                      <div className="grid grid-cols-2 gap-x-3">
                        <span className="text-gray-500">Всего в XML:</span><span className="font-medium">{kptResult.total}</span>
                        <span className="text-gray-500">Создано новых:</span><span className="font-medium text-green-600">{kptResult.created}</span>
                        <span className="text-gray-500">Обновлено:</span><span className="font-medium text-blue-600">{kptResult.updated}</span>
                        <span className="text-gray-500">С геометрией:</span><span className="font-medium">{kptResult.geom_set}</span>
                        {kptResult.errors > 0 && (
                          <><span className="text-gray-500">Ошибки:</span><span className="font-medium text-red-600">{kptResult.errors}</span></>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Live log */}
                  {pkkLog.length > 0 && (
                    <div className="space-y-1.5">
                      {/* Summary counters */}
                      <div className="flex items-center gap-2 text-[10px] font-medium">
                        <span className="text-green-600">{pkkLog.filter(l => l.status === 'ok').length}</span>
                        <span className="text-amber-500">{pkkLog.filter(l => l.status === 'not_found_pkk' || l.status === 'no_geometry').length} нет</span>
                        <span className="text-red-500">{pkkLog.filter(l => l.status === 'error').length} ош.</span>
                        {/* Progress bar */}
                        <div className="flex-1 h-1 bg-amber-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-500 transition-all duration-300"
                            style={{
                              width: `${Math.round(
                                (pkkLog.filter(l => !['pending', 'fetching'].includes(l.status)).length / pkkLog.length) * 100
                              )}%`,
                            }}
                          />
                        </div>
                      </div>

                      {/* Scroll log */}
                      <div className="max-h-36 overflow-y-auto bg-white rounded border border-amber-100 divide-y divide-amber-50 text-[10px]">
                        {pkkLog.map((entry, i) => {
                          const colors: Record<string, string> = {
                            pending: 'text-gray-300', fetching: 'text-blue-500',
                            ok: 'text-green-600', not_found_pkk: 'text-amber-500',
                            no_geometry: 'text-amber-500', error: 'text-red-500', skipped: 'text-gray-300',
                          }
                          const labels: Record<string, string> = {
                            pending: '...', fetching: 'запрос', ok: 'OK',
                            not_found_pkk: 'нет', no_geometry: 'пусто', error: 'ERR', skipped: 'skip',
                          }
                          return (
                            <div key={i} className={`px-2 py-0.5 flex items-center gap-1.5 ${entry.status === 'fetching' ? 'bg-blue-50' : ''}`}>
                              <span className="text-gray-400 w-5 text-right tabular-nums">{i + 1}</span>
                              <span className="font-mono text-gray-600 truncate flex-1" title={entry.kn}>{entry.kn}</span>
                              <span className={`font-semibold ${colors[entry.status] ?? 'text-gray-500'}`}>
                                {entry.status === 'fetching' && <span className="animate-pulse">●</span>}
                                {labels[entry.status] ?? entry.status}
                                {entry.polygons ? ` ${entry.polygons}p` : ''}
                              </span>
                            </div>
                          )
                        })}
                        <div ref={pkkLogEndRef} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Аудит-пресеты — видны когда target включён */}
            {visibleLayers.has('target') && (
              <div className="border border-gray-200 rounded-md bg-white">
                <div className="px-3 py-2 border-b border-gray-200 text-[11px] font-semibold text-gray-600 bg-gray-50 uppercase tracking-wide flex items-center justify-between">
                  <span>Аудит-пресеты</span>
                  <Link href="/audit" className="text-[10px] text-blue-700 hover:underline normal-case font-normal">
                    Расширенный →
                  </Link>
                </div>
                <div className="divide-y divide-gray-100">
                  {(Object.keys(PRESET_LABELS) as Preset[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => setPreset(k)}
                      className={`w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between ${
                        preset === k
                          ? (k === 'none' ? 'bg-gray-100 font-semibold text-gray-900' : 'bg-red-50 font-semibold text-red-800')
                          : 'text-gray-700'
                      }`}
                      title={PRESET_DESCRIPTIONS[k]}
                    >
                      <span>{PRESET_LABELS[k]}</span>
                      {preset === k && k !== 'none' && (
                        <span className="tabular-nums text-[11px]">· {presetCount}</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-500 leading-snug">
                  {PRESET_DESCRIPTIONS[preset]}
                </div>
              </div>
            )}

            {/* Сводка / легенда */}
            <div className="border border-gray-200 rounded-md bg-white">
              <div className="px-3 py-2 border-b border-gray-200 text-[11px] font-semibold text-gray-600 bg-gray-50 uppercase tracking-wide">
                Сводка
              </div>
              <div className="p-3 space-y-2">
                {mode === 'target' && preset !== 'none' && preset !== 'objects-no-plots' && (
                  <>
                    <div>
                      <div className="text-2xl font-bold text-red-700 tabular-nums">{presetCount}</div>
                      <div className="text-[11px] text-gray-500">участков под пресет</div>
                    </div>
                    <div className="flex flex-col gap-1 pt-1 border-t border-gray-100">
                      <Swatch color="#dc2626" label={`под пресет · ${matchedPlotIds.size}`} />
                      <Swatch color="#cbd5e1" label="остальные (фон)" />
                      <Swatch color="#f59e0b" label="сервитуты" />
                    </div>
                  </>
                )}

                {mode === 'target' && preset === 'objects-no-plots' && (
                  <>
                    <div>
                      <div className="text-2xl font-bold text-red-700 tabular-nums">{objectsWithoutPlots.length}</div>
                      <div className="text-[11px] text-gray-500">бизнес-объектов без участков</div>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-snug pt-1 border-t border-gray-100">
                      Карта в обычной раскраске — список объектов в таблице внизу.
                    </p>
                  </>
                )}

                {mode === 'target' && preset === 'none' && targetSummary && (
                  <div className="flex flex-col gap-1">
                    {targetSummary.objects.slice(0, 14).map((o) => (
                      <Swatch key={o.code} color={o.color} icon={o.icon} label={`${o.code} · ${o.count}`} title={o.name} />
                    ))}
                    {targetSummary.unassigned > 0 && <Swatch color={UNASSIGNED_COLOR} label={`без привязки · ${targetSummary.unassigned}`} />}
                    {targetSummary.servitudes > 0 && <Swatch color="#f59e0b" label={`сервитуты · ${targetSummary.servitudes}`} />}
                  </div>
                )}

                {mode === 'zone' && zoneSummary && (
                  <div className="flex flex-col gap-1">
                    {zoneSummary.kinds.map(([kind, count]) => (
                      <Swatch key={kind} color={ZONE_KIND_COLORS[kind] ?? UNASSIGNED_COLOR} label={`${kind} · ${count}`} />
                    ))}
                    <div className="pt-1 border-t border-gray-100 mt-1 text-gray-500">
                      с объектом: <b className="text-gray-700">{zoneSummary.withObject}</b> · без: <b className="text-gray-700">{zoneSummary.withoutObject}</b>
                    </div>
                  </div>
                )}

                {mode === 'cadastrals' && (
                  <div className="flex flex-col gap-1">
                    {Object.entries(CADASTRAL_COLORS).map(([key, color]) => (
                      <Swatch key={key} color={color} label={CADASTRAL_LABELS[key] ?? key} />
                    ))}
                    <span className="text-gray-500 pt-1 border-t border-gray-100 mt-1">пунктир = изъятие</span>
                  </div>
                )}

                {mode === 'staging' && (
                  <div className="flex flex-col gap-1">
                    <Swatch color={STAGING_COLORS['участок']} label="участок" />
                    <Swatch color={STAGING_COLORS['контур']} label="контур" />
                    <Swatch color={STAGING_COLORS['сервитут']} label="сервитут" />
                  </div>
                )}
              </div>
            </div>

            {/* ─── Синхронизация GIS → ArcGIS ────────────────────────── */}
            <GisSyncButton />
          </aside>
        </div>

        {/* ─── Таблица под картой ───────────────────────────────────────────
            Реагирует на mode + preset + поисковую строку. Высота фиксирована
            (h-72), карта сжимается на её высоту. Свернуть/развернуть кнопкой
            в заголовке. */}
        <div
          className="border-t border-gray-200 bg-white flex flex-col shrink-0"
          style={{ height: tableOpen ? 320 : 36 }}
        >
          <div className="flex items-center gap-3 px-4 py-1.5 border-b border-gray-100 bg-gray-50">
            <button
              onClick={() => setTableOpen(!tableOpen)}
              className="text-xs font-semibold text-gray-700 hover:text-blue-700 flex items-center gap-1"
              title={tableOpen ? 'Свернуть таблицу' : 'Развернуть таблицу'}
            >
              <span className="inline-block w-3 text-gray-400">{tableOpen ? '▼' : '▶'}</span>
              {mode === 'target' && preset === 'objects-no-plots'
                ? `Бизнес-объекты без участков · ${objectsWithoutPlots.length}`
                : mode === 'target'
                  ? (preset === 'none'
                      ? `Участки · ${tableRows.length}`
                      : `Совпадения «${PRESET_LABELS[preset]}» · ${tableRows.length}`)
                  : mode === 'zone'
                    ? `Зоны ППТ · ${tableRows.length}`
                    : mode === 'cadastrals'
                      ? `Кадастры · ${tableRows.length}`
                      : `Стейджинг · ${tableRows.length}`}
            </button>
            {tableOpen && (
              <>
                <input
                  type="text"
                  value={tableSearch}
                  onChange={e => setTableSearch(e.target.value)}
                  placeholder="Поиск по коду / названию…"
                  className="text-xs border border-gray-300 rounded px-2 py-1 w-56"
                />
                {tableSearch && (
                  <button
                    onClick={() => setTableSearch('')}
                    className="text-[11px] text-gray-500 hover:text-gray-800 underline"
                  >
                    сбросить
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={downloadTableCsv}
                  disabled={tableRows.length === 0 && objectsWithoutPlots.length === 0}
                  className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-white disabled:opacity-40"
                  title="Скачать текущий список в CSV (Excel)"
                >
                  ↓ CSV
                </button>
              </>
            )}
          </div>

          {tableOpen && (
            <div className="flex-1 overflow-auto">
              {mode === 'target' && preset === 'objects-no-plots' ? (
                objectsWithoutPlots.length === 0 ? (
                  <div className="p-4 text-sm text-gray-400 italic">
                    Все активные бизнес-объекты имеют хотя бы один привязанный участок.
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-gray-600 sticky top-0">
                      <tr>
                        <th className="px-3 py-1.5 text-left w-6"></th>
                        <th className="px-3 py-1.5 text-left">Код</th>
                        <th className="px-3 py-1.5 text-left">Наименование</th>
                        <th className="px-3 py-1.5 text-left w-12"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {objectsWithoutPlots
                        .filter(o => !tableSearch || o.code.toLowerCase().includes(tableSearch.toLowerCase()) || o.current_name.toLowerCase().includes(tableSearch.toLowerCase()))
                        .map(o => (
                          <tr key={o.id} className="hover:bg-blue-50">
                            <td className="px-3 py-1">{o.color && <span className="inline-block w-2.5 h-2.5 rounded" style={{ background: o.color }} />}</td>
                            <td className="px-3 py-1 font-mono font-semibold text-blue-700">{o.code}</td>
                            <td className="px-3 py-1 text-gray-700">{o.current_name}</td>
                            <td className="px-3 py-1"><Link href={`/objects?focus=${o.id}`} className="text-[11px] text-blue-700 hover:underline">↗</Link></td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )
              ) : tableRows.length === 0 ? (
                <div className="p-4 text-sm text-gray-400 italic">
                  {loading ? 'Загрузка…' : 'Под условия ничего не попало.'}
                </div>
              ) : mode === 'target' ? (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600 sticky top-0">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Код</th>
                      <th className="px-3 py-1.5 text-left">Роль</th>
                      <th className="px-3 py-1.5 text-right">S, м²</th>
                      <th className="px-3 py-1.5 text-left">Зона</th>
                      <th className="px-3 py-1.5 text-left">Очередь</th>
                      <th className="px-3 py-1.5 text-left">Контейнер</th>
                      <th className="px-3 py-1.5 text-left">Бизнес-объект</th>
                      <th className="px-3 py-1.5 text-left">Мастерплан</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {tableRows.slice(0, 400).map((p, idx) => {
                      const area = (p.area_calc_m2 ?? p.area_declared_m2 ?? null) as number | null
                      const objs = (p.objects as Array<{ code: string; color?: string | null }>) ?? []
                      const mp = (p.masterplan_objects as Array<{ code: string }>) ?? []
                      const highlighted = preset !== 'none' && preset !== 'objects-no-plots' && matchedPlotIds.has((p.plot_id as string) ?? '')
                      return (
                        <tr key={(p.plot_id as string) ?? idx}
                          className={`hover:bg-blue-50 cursor-pointer ${highlighted ? 'bg-red-50/40' : ''}`}
                          onClick={() => zoomToFeature('plot_id', (p.plot_id as string) ?? '')}
                        >
                          <td className="px-3 py-1 font-mono font-semibold text-blue-700">{(p.plot_code as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-gray-600">{(p.role as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-right tabular-nums text-gray-700">{area !== null ? Math.round(area).toLocaleString('ru') : '—'}</td>
                          <td className="px-3 py-1 font-mono text-gray-700">{(p.functional_zone_code as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-gray-700">{(p.functional_queue as string) ?? '—'}</td>
                          <td className="px-3 py-1 font-mono text-gray-700">
                            {p.is_container
                              ? <span title="Контейнер с нарезкой">📦 {(p.child_count ?? 0) as number}</span>
                              : ((p.container_plot_code as string) ?? '—')}
                          </td>
                          <td className="px-3 py-1">
                            {objs.length === 0
                              ? <span className="text-gray-400 italic">—</span>
                              : objs.map(o => o.code).join(', ')}
                          </td>
                          <td className="px-3 py-1 text-gray-600">{mp.length === 0 ? '—' : mp.map(o => o.code).join(', ')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t border-gray-200 sticky bottom-0">
                    <tr className="text-[11px] font-medium text-gray-600">
                      <td className="px-3 py-1.5" colSpan={2}>Итого: {tableRows.length}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {(() => {
                          const total = tableRows.reduce((s, p) => s + ((p.area_calc_m2 ?? p.area_declared_m2 ?? 0) as number), 0)
                          return total > 0 ? <><b>{Math.round(total).toLocaleString('ru')}</b>{total > 10000 && <span className="text-gray-400 ml-1">({(total / 10000).toFixed(2)} га)</span>}</> : '—'
                        })()}
                      </td>
                      <td colSpan={5} />
                    </tr>
                  </tfoot>
                </table>
              ) : mode === 'zone' ? (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600 sticky top-0">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Код зоны</th>
                      <th className="px-3 py-1.5 text-left">Название</th>
                      <th className="px-3 py-1.5 text-left">Тип</th>
                      <th className="px-3 py-1.5 text-left">Очередь</th>
                      <th className="px-3 py-1.5 text-right">Участков</th>
                      <th className="px-3 py-1.5 text-right">S, м²</th>
                      <th className="px-3 py-1.5 text-left">Бизнес-объекты</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {tableRows.slice(0, 400).map((p, idx) => {
                      const objs = (p.objects as Array<{ code: string }>) ?? []
                      return (
                        <tr key={((p.zone_code as string) ?? '') + idx}
                          className="hover:bg-blue-50 cursor-pointer"
                          onClick={() => zoomToFeature('zone_code', (p.zone_code as string) ?? '')}
                        >
                          <td className="px-3 py-1 font-mono font-semibold text-blue-700">{(p.zone_code as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-gray-700">{(p.zone_name as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-gray-600">{(p.kind as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-gray-600">{(p.queue as string) ?? '—'}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{(p.plots_count ?? 0) as number}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{p.area_calc_m2 ? Math.round(p.area_calc_m2 as number).toLocaleString('ru') : '—'}</td>
                          <td className="px-3 py-1">{objs.length === 0 ? <span className="text-gray-400 italic">—</span> : objs.map(o => o.code).join(', ')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t border-gray-200 sticky bottom-0">
                    <tr className="text-[11px] font-medium text-gray-600">
                      <td className="px-3 py-1.5" colSpan={4}>Итого: {tableRows.length} зон</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{tableRows.reduce((s, p) => s + ((p.plots_count ?? 0) as number), 0)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {(() => {
                          const total = tableRows.reduce((s, p) => s + ((p.area_calc_m2 ?? 0) as number), 0)
                          return total > 0 ? <><b>{Math.round(total).toLocaleString('ru')}</b>{total > 10000 && <span className="text-gray-400 ml-1">({(total / 10000).toFixed(2)} га)</span>}</> : '—'
                        })()}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              ) : mode === 'staging' ? (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600 sticky top-0">
                    <tr>
                      <th className="px-3 py-1.5 text-left">ЗУ</th>
                      <th className="px-3 py-1.5 text-left">Тип</th>
                      <th className="px-3 py-1.5 text-left">Родитель</th>
                      <th className="px-3 py-1.5 text-left">Адрес</th>
                      <th className="px-3 py-1.5 text-left">ВРИ</th>
                      <th className="px-3 py-1.5 text-right">S, м²</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {tableRows.slice(0, 400).map((p, idx) => (
                      <tr key={((p.zu as string) ?? '') + idx}
                        className="hover:bg-blue-50 cursor-pointer"
                        onClick={() => zoomToFeature('zu', (p.zu as string) ?? '')}
                      >
                        <td className="px-3 py-1 font-mono font-semibold text-blue-700">{(p.zu as string) ?? '—'}</td>
                        <td className="px-3 py-1 text-gray-600">{(p.kind as string) ?? '—'}</td>
                        <td className="px-3 py-1 font-mono text-gray-600">{(p.parent_zu as string) ?? '—'}</td>
                        <td className="px-3 py-1 text-gray-700">{(p.address as string) ?? '—'}</td>
                        <td className="px-3 py-1 text-gray-600">{(p.permitted_use as string) ?? '—'}</td>
                        <td className="px-3 py-1 text-right tabular-nums">{p.area_m2 ? Math.round(p.area_m2 as number).toLocaleString('ru') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t border-gray-200 sticky bottom-0">
                    <tr className="text-[11px] font-medium text-gray-600">
                      <td className="px-3 py-1.5" colSpan={5}>Итого: {tableRows.length} ЗУ</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {(() => {
                          const total = tableRows.reduce((s, p) => s + ((p.area_m2 ?? 0) as number), 0)
                          return total > 0 ? <><b>{Math.round(total).toLocaleString('ru')}</b>{total > 10000 && <span className="text-gray-400 ml-1">({(total / 10000).toFixed(2)} га)</span>}</> : '—'
                        })()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              ) : mode === 'cadastrals' ? (
                <div className="flex flex-col h-full">
                  <div className="flex-1 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-gray-600 sticky top-0 z-10">
                        <tr>
                          <th className="px-1.5 py-1.5 text-center w-8">
                            <input
                              type="checkbox"
                              className="accent-blue-600"
                              checked={tableRows.length > 0 && selectedKns.size === tableRows.length}
                              onChange={() => {
                                if (selectedKns.size === tableRows.length) {
                                  setSelectedKns(new Set())
                                } else {
                                  setSelectedKns(new Set(tableRows.map(p => (p.cadastral_number as string) ?? '')))
                                }
                              }}
                              title="Выделить все / снять"
                            />
                          </th>
                          <th className="px-3 py-1.5 text-center w-8" title="Контур на карте">
                            <span className="text-gray-400">&#9679;</span>
                          </th>
                          <th className="px-3 py-1.5 text-left">Кадастровый №</th>
                          <th className="px-3 py-1.5 text-left">Собственность</th>
                          <th className="px-3 py-1.5 text-right">S, м²</th>
                          <th className="px-3 py-1.5 text-left">ВРИ</th>
                          <th className="px-3 py-1.5 text-right">Стоимость</th>
                          <th className="px-3 py-1.5 text-center w-16">Источник</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {tableRows.slice(0, 500).map((p, idx) => {
                          const kn = (p.cadastral_number as string) ?? ''
                          const isSelected = selectedKns.has(kn)
                          const hasGeom = p.has_geom as boolean | undefined
                          const src = (p.source as string) ?? 'pmt_ppt'
                          const inProj = p.in_project as boolean | undefined
                          return (
                            <tr
                              key={kn + idx}
                              className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-50' : inProj === false ? 'bg-gray-50/50 hover:bg-gray-100' : 'hover:bg-gray-50'}`}
                              onClick={() => zoomToFeature('cadastral_number', kn)}
                            >
                              <td className="px-1.5 py-1 text-center" onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  className="accent-blue-600"
                                  checked={isSelected}
                                  onChange={() => toggleKnSelection(kn)}
                                />
                              </td>
                              <td className="px-3 py-1 text-center">
                                {hasGeom
                                  ? <span className="text-green-500" title="Есть контур">&#9679;</span>
                                  : <span className="text-gray-300" title="Нет контура">&#9675;</span>}
                              </td>
                              <td className="px-3 py-1 font-mono font-semibold text-blue-700">
                                {kn || '—'}
                                {inProj === false && <span className="ml-1 text-[9px] text-gray-400 font-normal" title="Не в проекте ЗПР">(вне)</span>}
                              </td>
                              <td className="px-3 py-1 text-gray-700">{CADASTRAL_LABELS[(p.ownership as string) ?? 'unknown'] ?? '—'}</td>
                              <td className="px-3 py-1 text-right tabular-nums">{p.area_m2 ? Math.round(p.area_m2 as number).toLocaleString('ru') : '—'}</td>
                              <td className="px-3 py-1 text-gray-600 max-w-[200px] truncate" title={(p.vri as string) ?? ''}>{(p.vri as string) ?? '—'}</td>
                              <td className="px-3 py-1 text-right tabular-nums text-gray-500">{p.cadastral_cost ? Math.round(p.cadastral_cost as number).toLocaleString('ru') : '—'}</td>
                              <td className="px-3 py-1 text-center">
                                {src === 'kpt_xml'
                                  ? <span className="inline-block px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-medium">КПТ</span>
                                  : src === 'pkk'
                                    ? <span className="inline-block px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[10px] font-medium">ПКК</span>
                                    : src === 'manual'
                                      ? <span className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px] font-medium">Руч.</span>
                                      : <span className="text-[10px] text-gray-400">ПМТ</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {/* Подвал с итогами по выделенным */}
                  {selectedKns.size > 0 && (() => {
                    const sel = tableRows.filter(p => selectedKns.has((p.cadastral_number as string) ?? ''))
                    const totalArea = sel.reduce((s, p) => s + ((p.area_m2 as number) || 0), 0)
                    const totalCost = sel.reduce((s, p) => s + ((p.cadastral_cost as number) || 0), 0)
                    return (
                      <div className="border-t border-blue-200 bg-blue-50 px-4 py-2 flex items-center gap-4 text-xs shrink-0">
                        <span className="font-semibold text-blue-800">Выбрано: {selectedKns.size}</span>
                        <span className="text-gray-600">
                          S = <b className="text-gray-900">{Math.round(totalArea).toLocaleString('ru')}</b> м²
                          {totalArea > 10000 && <span className="text-gray-400 ml-1">({(totalArea / 10000).toFixed(2)} га)</span>}
                        </span>
                        {totalCost > 0 && (
                          <span className="text-gray-600">
                            Кад. стоимость = <b className="text-gray-900">{Math.round(totalCost).toLocaleString('ru')}</b> руб.
                          </span>
                        )}
                        <button
                          className="ml-auto text-[11px] text-blue-600 hover:underline"
                          onClick={() => setSelectedKns(new Set())}
                        >
                          Сбросить
                        </button>
                      </div>
                    )
                  })()}
                </div>
              ) : null}

              {tableRows.length > 400 && (
                <div className="px-3 py-2 text-[11px] text-gray-500 italic border-t border-gray-100 bg-gray-50">
                  …показаны первые 400 из {tableRows.length}. Скачайте CSV для полного списка.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// CSV helper.
function csvField(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return ''
  const needs = /[;\n"]/.test(s)
  if (!needs) return s
  return `"${s.replace(/"/g, '""')}"`
}

function Swatch({ color, label, title, icon }: { color: string; label: string; title?: string; icon?: string }) {
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span
        className="inline-block w-3 h-3 rounded-sm shrink-0"
        style={{ backgroundColor: color + '4D', border: `1.5px solid ${color}` }}
      />
      {icon && (
        isDataUrl(icon)
          ? <img src={icon} alt="" style={{ width: 14, height: 14, objectFit: 'contain' }} />
          : <span>{icon}</span>
      )}
      <span>{label}</span>
    </span>
  )
}

// ============================================================================
// GIS Sync Button — синхронизация postgres → zpr_gis для ArcGIS
// ============================================================================

function GisSyncButton() {
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    totalRows?: number
    error?: string
    tables?: Array<{ table: string; rows: number; durationMs: number; error?: string }>
  } | null>(null)

  const handleSync = async () => {
    setSyncing(true)
    setResult(null)
    try {
      const res = await fetch('/api/gis/sync', { method: 'POST' })
      const data = await res.json()
      setResult(data)
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-md bg-white mt-auto">
      <div className="px-3 py-2 border-b border-gray-200 text-[11px] font-semibold text-gray-600 bg-gray-50 uppercase tracking-wide flex items-center justify-between">
        <span>GIS → ArcGIS</span>
        <button
          onClick={handleSync}
          disabled={syncing}
          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
            syncing
              ? 'bg-gray-200 text-gray-400 cursor-wait'
              : 'bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer'
          }`}
        >
          {syncing ? 'Синхронизация...' : 'Синхронизировать'}
        </button>
      </div>
      {result && (
        <div className="p-2 text-[10px]">
          {result.ok ? (
            <div className="text-emerald-700">
              ✓ {result.totalRows} строк · {result.tables?.length} таблиц
            </div>
          ) : (
            <div className="text-red-600">✗ {result.error}</div>
          )}
        </div>
      )}
    </div>
  )
}
