'use client'

/**
 * PlotsTab — универсальная вкладка «Участки и ОКС» для карточек двух типов сущностей:
 *
 *   • `objects` (бизнес-объекты ЗПР) → ownerType='object'
 *   • `masterplan_objects` (объекты мастерплана) → ownerType='masterplan'
 *
 * Геометрия и popup'ы для участков и зон одинаковые, отличается:
 *   - источник принадлежности: `effective_object_ids[]` vs `masterplan_objects[].id`
 *   - API привязки/отвязки:
 *       object   ↔ plot:  PATCH /api/plots/[id] {bind_to_object|unbind_from_object}
 *       object   ↔ zone:  PATCH /api/functional-objects/[id] {add_object_id|remove_object_id}
 *       masterplan ↔ plot:  PATCH /api/masterplan-objects/[ownerId] {add_plot_id|remove_plot_id}
 *       masterplan ↔ zone:  PATCH /api/masterplan-objects/[ownerId] {add_functional_object_id|remove_functional_object_id}
 *
 * Карта: Leaflet через CDN (как `/plots/map`). Без npm-зависимости.
 *
 * Источник данных:
 *   - Участки:  GET /api/plots/geojson?role=all                — properties.objects[] + .masterplan_objects[]
 *   - Зоны:    GET /api/functional-objects/geojson?kind=all   — properties.objects[] + .masterplan_objects[]
 *   - Список зон для «+ Привязать зону»: GET /api/functional-objects
 *
 * См. WIKI 25/29/33 и миграцию 20260525000001_geojson_with_masterplan.sql.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Script from 'next/script'
import type { LeafletGeoJSON, LeafletMap } from '@/lib/leaflet/types'

// ============================================================================
// Типы

type OksItem = {
  name: string | null
  etazh_max: number | null
  queue: string | null
  status: string | null
  value: string | null
}

// Бизнес-объект ЗПР (приходит в features через массив — M:N).
type ObjectInfo = {
  id: string
  code: string
  name: string
  color: string | null
  icon: string | null
}

// Мастерплан-объект (приходит в features через массив — M:N через junction).
type MasterplanInfo = {
  id: string
  code: string
  queue: string | null
  name_ppt: string
  name_contract: string | null
}

type PlotFeatureProps = {
  plot_id: string
  plot_code: string
  plot_name: string
  role: 'plot' | 'servitude' | 'partial' | 'cadastral'
  permitted_use: string | null
  area_calc_m2: number | null
  area_declared_m2: number | null
  polygon_count: number | null
  functional_zone_code: string | null
  functional_queue: string | null
  functional_kind: string | null
  functional_name: string | null
  effective_object_ids: string[]
  // Иерархия (см. миграцию 20260525000003_plot_hierarchy.sql):
  // container_plot_id указывает на «контейнерный» ЗУ, который геометрически
  // полностью включает этот plot. is_container = true если у этого plot есть дети.
  container_plot_id: string | null
  container_plot_code: string | null
  is_container: boolean
  child_count: number
  objects: ObjectInfo[]
  masterplan_objects: MasterplanInfo[]
  oks: OksItem[]
}

type ZoneFeatureProps = {
  functional_object_id: string
  zone_code: string
  zone_name: string | null
  queue: string | null
  kind: string | null
  objects: ObjectInfo[]
  masterplan_objects: MasterplanInfo[]
  plots_count: number | null
  area_calc_m2: number | null
  oks: OksItem[]
}

type GeoJSONFeature = {
  type: 'Feature'
  id?: string
  geometry: { type: string; coordinates: unknown }
  properties: PlotFeatureProps
}

type GeoJSON = { type: 'FeatureCollection'; features: GeoJSONFeature[] }

type ZoneGroup = {
  zone_code: string
  zone_name: string | null
  zone_kind: string | null
  zone_queue: string | null
  functional_object_id: string | null
  /** Top-level: контейнеры зоны + own-plots без контейнера. */
  plots: GeoJSONFeature[]
  /** Дети контейнера. Ключ — plot_id контейнера. Включаются автоматически
   *  если их контейнер вошёл в `plots` (или если они сами own).             */
  children: Record<string, GeoJSONFeature[]>
  oks: OksItem[]
}

type FunctionalObjectRow = {
  id: string
  zone_code: string
  name: string
  kind: string
  queue: string | null
  // M:N массивы — для obj-режима используем object_ids, для мастерплана читаем позже.
  object_ids: string[]
}

// Подслои geoJSON для зума на конкретный feature.
type LeafletSubLayer = {
  getBounds?: () => { isValid?: () => boolean } & unknown
  openPopup?: () => void
  feature?: { properties?: Record<string, unknown> }
}

// ============================================================================
// Цвета и константы

const UNASSIGNED_COLOR = '#94a3b8'
const SERVITUDE_COLOR  = '#f59e0b'
const OWN_COLOR_BUSINESS = '#2563eb'    // синий — бизнес-объект
const OWN_COLOR_MASTERPLAN = '#a16207'  // янтарный — мастерплан-объект (визуально другой)

type ViewMode = 'plots' | 'zones'

// ============================================================================
// Props

export type OwnerType = 'object' | 'masterplan'

type Props = {
  /** Тип владельца карточки */
  ownerType: OwnerType
  /** UUID владельца — objects.id или masterplan_objects.id */
  ownerId: string
  /** Короткий код для заголовков и подписи в popup'ах */
  ownerCode: string
  /** Цвет владельца (objects.color). null для masterplan — берём дефолт по типу */
  ownerColor: string | null
  /** Активный ли таб — для invalidateSize карты при первом показе */
  active: boolean
}

// ============================================================================
// Универсальное «свой ли этот feature?»

function isOwnPlot(p: PlotFeatureProps, owner: { type: OwnerType; id: string }): boolean {
  if (owner.type === 'object') {
    return (p.effective_object_ids ?? []).includes(owner.id)
  }
  return (p.masterplan_objects ?? []).some(mo => mo.id === owner.id)
}

function isOwnZone(z: ZoneFeatureProps, owner: { type: OwnerType; id: string }): boolean {
  if (owner.type === 'object') {
    return (z.objects ?? []).some(o => o.id === owner.id)
  }
  return (z.masterplan_objects ?? []).some(mo => mo.id === owner.id)
}

// ============================================================================

export default function PlotsTab({ ownerType, ownerId, ownerCode, ownerColor, active }: Props) {
  const owner = useMemo(() => ({ type: ownerType, id: ownerId }), [ownerType, ownerId])
  const OWN_COLOR_FALLBACK = ownerType === 'masterplan' ? OWN_COLOR_MASTERPLAN : OWN_COLOR_BUSINESS

  // ─── Leaflet bootstrap ────────────────────────────────────────────────────
  const mapRef = useRef<LeafletMap | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<LeafletGeoJSON | null>(null)
  const layersByPlotIdRef = useRef<Map<string, LeafletSubLayer>>(new Map())
  const [leafletReady, setLeafletReady] = useState<boolean>(typeof window !== 'undefined' && !!window.L)

  // ─── Данные ───────────────────────────────────────────────────────────────
  const [geojson, setGeojson] = useState<GeoJSON | null>(null)
  const [functionalObjects, setFunctionalObjects] = useState<FunctionalObjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // ─── UI state ─────────────────────────────────────────────────────────────
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null)
  const [showAddZone, setShowAddZone] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('plots')

  // ─── Загрузка ─────────────────────────────────────────────────────────────
  const geojsonUrl = viewMode === 'zones'
    ? '/api/functional-objects/geojson?kind=all'
    : '/api/plots/geojson?role=all'
  useEffect(() => {
    let abort = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    Promise.all([
      fetch(geojsonUrl).then(async (r) => {
        if (!r.ok) throw new Error(`GeoJSON HTTP ${r.status}`)
        return r.json() as Promise<GeoJSON>
      }),
      fetch('/api/functional-objects', { cache: 'no-store' })
        .then(async (r) => (r.ok ? (r.json() as Promise<{ items: FunctionalObjectRow[] }>) : { items: [] }))
        .catch(() => ({ items: [] as FunctionalObjectRow[] })),
    ])
      .then(([gj, fo]) => {
        if (abort) return
        setGeojson(gj)
        setFunctionalObjects(fo.items ?? [])
      })
      .catch((e) => {
        if (!abort) setError(e instanceof Error ? e.message : 'Ошибка загрузки')
      })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [reloadKey, geojsonUrl])

  // ─── Инициализация карты ──────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !active || !containerRef.current || mapRef.current) return
    const L = window.L
    if (!L) return

    const map = L.map(containerRef.current, { center: [45.18, 33.44], zoom: 13 })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [leafletReady, active])

  useEffect(() => {
    if (active && mapRef.current) {
      setTimeout(() => mapRef.current?.invalidateSize(), 50)
    }
  }, [active])

  // ─── Перерисовка слоя ─────────────────────────────────────────────────────
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map || !geojson) return

    if (layerRef.current) {
      map.removeLayer(layerRef.current)
      layerRef.current = null
    }
    if (geojson.features.length === 0) return

    const renderIconHtml = (ic: string | null | undefined): string => {
      if (!ic) return ''
      if (ic.startsWith('data:image/') || /^https?:\/\//.test(ic)) {
        return `<img src="${ic}" alt="" style="width:14px;height:14px;object-fit:contain;display:inline-block;vertical-align:-3px;margin-right:4px;" />`
      }
      return `<span style="margin-right:4px;">${ic}</span>`
    }

    // Универсальный рендер бейджей связанных сущностей (object или masterplan).
    const renderOwnerBadges = (
      bizObjs: ObjectInfo[],
      mpObjs: MasterplanInfo[],
      emptyText: string,
    ): string => {
      const total = (bizObjs?.length ?? 0) + (mpObjs?.length ?? 0)
      if (total === 0) {
        return `<div style="color:#94a3b8;font-style:italic;margin-top:2px;">${emptyText}</div>`
      }
      const parts: string[] = []
      // Сначала бизнес-объекты, потом мастерплан-объекты
      for (const o of bizObjs ?? []) {
        const isOwn = ownerType === 'object' && o.id === ownerId
        const bg = o.color ?? '#e5e7eb'
        const border = isOwn ? `box-shadow:0 0 0 2px #1d4ed8;` : ''
        parts.push(
          `<div style="background:${bg};color:#fff;padding:2px 8px;border-radius:4px;display:inline-flex;align-items:center;font-weight:500;font-size:11px;${border}">
             ${renderIconHtml(o.icon)}<span>${o.code}</span>${isOwn ? '  <span style="margin-left:4px;font-size:9px;opacity:0.85;">(этот)</span>' : ''}
           </div>`
        )
      }
      for (const mo of mpObjs ?? []) {
        const isOwn = ownerType === 'masterplan' && mo.id === ownerId
        const border = isOwn ? `box-shadow:0 0 0 2px #92400e;` : ''
        parts.push(
          `<div style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;display:inline-flex;align-items:center;font-weight:500;font-size:11px;${border}">
             <span>📋 ${mo.code}</span>${mo.queue ? `<span style="margin-left:4px;opacity:0.7;">оч.${mo.queue}</span>` : ''}${isOwn ? '  <span style="margin-left:4px;font-size:9px;opacity:0.85;">(этот)</span>' : ''}
           </div>`
        )
      }
      return `<div style="margin-top:2px;display:flex;flex-direction:column;gap:2px;">${parts.join('')}</div>`
    }

    const layer = L.geoJSON(geojson, {
      style: (feature: unknown) => {
        const f = feature as { properties?: Record<string, unknown> }
        const props = f.properties ?? {}

        if (viewMode === 'zones') {
          const z = props as unknown as ZoneFeatureProps
          if (isOwnZone(z, owner)) {
            const matchedColor = ownerType === 'object'
              ? z.objects.find(o => o.id === ownerId)?.color
              : null
            return { color: matchedColor || ownerColor || OWN_COLOR_FALLBACK, weight: 3, fillOpacity: 0.4 }
          }
          // Если у зоны есть кто-то ещё (любой тип)
          const hasAny = (z.objects?.length ?? 0) + (z.masterplan_objects?.length ?? 0) > 0
          if (hasAny) {
            const firstColor = z.objects?.[0]?.color
            return { color: firstColor || UNASSIGNED_COLOR, weight: 1, fillOpacity: 0.1 }
          }
          return { color: UNASSIGNED_COLOR, weight: 1.5, fillOpacity: 0.25 }
        }

        // viewMode === 'plots'
        const p = (props as unknown) as PlotFeatureProps
        if (p.role === 'servitude') {
          return { color: SERVITUDE_COLOR, weight: 1, fillOpacity: 0.15, dashArray: '4,3' }
        }
        // Контейнер: пунктирная обводка, без заливки — чтобы видеть «нарезку» внутри.
        if (p.is_container) {
          const isOwn = isOwnPlot(p, owner)
          const ownColor = ownerType === 'object'
            ? p.objects.find(o => o.id === ownerId)?.color
            : null
          const color = isOwn ? (ownColor || ownerColor || OWN_COLOR_FALLBACK) : '#475569'
          return { color, weight: isOwn ? 4 : 2.5, fillOpacity: 0, dashArray: '6,4' }
        }
        if (isOwnPlot(p, owner)) {
          const matchedColor = ownerType === 'object'
            ? p.objects.find(o => o.id === ownerId)?.color
            : null
          return { color: matchedColor || ownerColor || OWN_COLOR_FALLBACK, weight: 3, fillOpacity: 0.45 }
        }
        const hasAny = (p.objects?.length ?? 0) + (p.masterplan_objects?.length ?? 0) > 0
        if (hasAny) {
          const firstColor = p.objects?.[0]?.color
          return { color: firstColor || UNASSIGNED_COLOR, weight: 1, fillOpacity: 0.1 }
        }
        return { color: UNASSIGNED_COLOR, weight: 1.5, fillOpacity: 0.25 }
      },
      onEachFeature: (feature: unknown, lyr: unknown) => {
        const f = feature as { properties?: Record<string, unknown> }
        const props = f.properties ?? {}

        let html = ''
        if (viewMode === 'zones') {
          const z = props as unknown as ZoneFeatureProps
          const isOwn = isOwnZone(z, owner)
          const oksHtml = z.oks?.length
            ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;">
                 <div style="font-weight:600;color:#475569;margin-bottom:2px;">ОКС: ${z.oks.length}</div>
                 ${z.oks.slice(0, 3).map(o => `<div style="font-size:11px;color:#475569;">${o.name ?? '—'}${o.etazh_max ? ` · ${o.etazh_max} эт.` : ''}</div>`).join('')}
                 ${z.oks.length > 3 ? `<div style="font-size:11px;color:#94a3b8;">…ещё ${z.oks.length - 3}</div>` : ''}
               </div>`
            : ''

          const actionBtn = isOwn
            ? `<button data-action="unbind-zone" data-fid="${z.functional_object_id}" style="margin-top:8px;padding:4px 10px;background:#fee2e2;color:#b91c1c;border:none;border-radius:4px;cursor:pointer;font-size:12px;">× Убрать ${ownerCode} из зоны</button>`
            : `<button data-action="bind-zone" data-fid="${z.functional_object_id}" style="margin-top:8px;padding:4px 10px;background:#dbeafe;color:#1d4ed8;border:none;border-radius:4px;cursor:pointer;font-size:12px;">⊕ Добавить ${ownerCode} в зону</button>`

          const ownersTotal = (z.objects?.length ?? 0) + (z.masterplan_objects?.length ?? 0)
          html = `
            <div style="font-family:ui-monospace,monospace;font-size:12px;min-width:260px;">
              <div style="font-weight:600;color:#1e40af;">${z.zone_code}${z.queue ? `  <span style="background:#fef3c7;color:#92400e;padding:1px 4px;border-radius:3px;font-size:10px;">оч. ${z.queue}</span>` : ''}</div>
              ${z.zone_name ? `<div style="color:#475569;margin-top:2px;">${z.zone_name}</div>` : ''}
              <div style="margin-top:6px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Связи в зоне (${ownersTotal}):</div>
              ${renderOwnerBadges(z.objects ?? [], z.masterplan_objects ?? [], 'нет связей')}
              <div style="margin-top:6px;color:#64748b;">участков: <b>${z.plots_count ?? 0}</b>${z.area_calc_m2 ? `  ·  S: ${Number(z.area_calc_m2).toLocaleString('ru', { maximumFractionDigits: 0 })} м²` : ''}</div>
              ${oksHtml}
              ${actionBtn}
            </div>
          `
        } else {
          const p = (props as unknown) as PlotFeatureProps
          const isOwn = isOwnPlot(p, owner)
          const oksHtml = p.oks.length
            ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;">
                 <div style="font-weight:600;color:#475569;margin-bottom:2px;">ОКС: ${p.oks.length}</div>
                 ${p.oks.slice(0, 3).map(o => `<div style="font-size:11px;color:#475569;">${o.name ?? '—'}${o.etazh_max ? ` · ${o.etazh_max} эт.` : ''}</div>`).join('')}
                 ${p.oks.length > 3 ? `<div style="font-size:11px;color:#94a3b8;">…ещё ${p.oks.length - 3}</div>` : ''}
               </div>`
            : ''

          let actionBtn = ''
          if (p.role !== 'servitude') {
            if (isOwn) {
              actionBtn = `<button data-action="unbind-plot" data-plot-id="${p.plot_id}" style="margin-top:8px;padding:4px 10px;background:#fee2e2;color:#b91c1c;border:none;border-radius:4px;cursor:pointer;font-size:12px;">× Отвязать участок</button>`
            } else {
              actionBtn = `<button data-action="bind-plot" data-plot-id="${p.plot_id}" style="margin-top:8px;padding:4px 10px;background:#dbeafe;color:#1d4ed8;border:none;border-radius:4px;cursor:pointer;font-size:12px;">⊕ Привязать к ${ownerCode}</button>`
            }
          }

          // Подсказка иерархии: контейнер VS внутренний / самостоятельный
          let hierarchyHtml = ''
          if (p.is_container) {
            hierarchyHtml = `<div style="margin-top:4px;padding:3px 6px;background:#eff6ff;border-left:3px solid #2563eb;color:#1e40af;font-size:11px;">📦 Контейнер зоны — нарезан на ${p.child_count} внутренних участков</div>`
          } else if (p.container_plot_code) {
            hierarchyHtml = `<div style="margin-top:4px;padding:3px 6px;background:#f1f5f9;border-left:3px solid #64748b;color:#334155;font-size:11px;">↳ Внутри контейнера <b>${p.container_plot_code}</b></div>`
          }

          html = `
            <div style="font-family:ui-monospace,monospace;font-size:12px;min-width:240px;">
              <div style="font-weight:600;color:#1e40af;">${p.plot_code}</div>
              ${renderOwnerBadges(p.objects ?? [], p.masterplan_objects ?? [], 'без привязки')}
              ${hierarchyHtml}
              <div style="margin-top:6px;"><b>Роль:</b> ${p.role}</div>
              ${p.functional_zone_code ? `<div style="color:#64748b;margin-top:4px;">Зона ППТ: <b>${p.functional_zone_code}</b>${p.functional_name ? ` — ${p.functional_name}` : ''}</div>` : ''}
              ${p.area_calc_m2 ? `<div><b>S:</b> ${Number(p.area_calc_m2).toLocaleString('ru', { maximumFractionDigits: 0 })} м²</div>` : ''}
              ${oksHtml}
              ${actionBtn}
            </div>
          `
        }
        ;(lyr as { bindPopup: (h: string) => unknown }).bindPopup(html)

        // ─── Постоянная подпись кода на полигоне ───────────────────────────
        // Чтобы пользователь сразу видел, какой это ЗУ/зона, без клика.
        let labelText = ''
        if (viewMode === 'zones') {
          const z = props as unknown as ZoneFeatureProps
          labelText = z.zone_code
        } else {
          const p = (props as unknown) as PlotFeatureProps
          // Сервитуты не подписываем — их много и они визуально мешают.
          if (p.role !== 'servitude') labelText = p.plot_code
        }
        if (labelText) {
          ;(lyr as { bindTooltip: (h: string, opts?: object) => unknown }).bindTooltip(labelText, {
            permanent: true,
            direction: 'center',
            className: 'plot-code-label',
            opacity: 0.9,
          })
        }
      },
    })
    layer.addTo(map)
    layerRef.current = layer

    layersByPlotIdRef.current.clear()
    layer.eachLayer((sub: unknown) => {
      const s = sub as LeafletSubLayer
      const idKey = viewMode === 'zones'
        ? (s.feature?.properties?.functional_object_id as string | undefined)
        : (s.feature?.properties?.plot_id as string | undefined)
      if (idKey) layersByPlotIdRef.current.set(idKey, s)
    })

    try {
      map.fitBounds(layer.getBounds(), { padding: [20, 20] } as object)
    } catch { /* пустые bounds */ }
  }, [geojson, ownerType, ownerId, ownerCode, ownerColor, viewMode, functionalObjects, OWN_COLOR_FALLBACK, owner])

  // ─── Зум на участок / группу участков ─────────────────────────────────────
  function zoomToPlots(plotIds: string[], openPopupIfSingle = false) {
    const map = mapRef.current
    const L = window.L
    if (!map || !L) return
    const subs = plotIds
      .map(id => layersByPlotIdRef.current.get(id))
      .filter((s): s is LeafletSubLayer => !!s?.getBounds)
    if (subs.length === 0) return
    if (subs.length === 1 && openPopupIfSingle) subs[0].openPopup?.()
    const featureGroup = (L as unknown as { featureGroup: (l: unknown[]) => { getBounds: () => unknown } })
      .featureGroup(subs)
    try {
      map.fitBounds(featureGroup.getBounds(), { padding: [40, 40], maxZoom: 17 } as object)
    } catch { /* пустые bounds */ }
  }

  // ─── Делегирование кликов в popup ─────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    const map = mapRef.current
    if (!map) return

    type PopupOpenEvent = { popup: { getElement: () => HTMLElement | null } }
    const onPopupOpen = (e: PopupOpenEvent) => {
      const popupEl = e.popup.getElement()
      if (!popupEl) return
      const buttons = popupEl.querySelectorAll<HTMLButtonElement>('[data-action]')
      buttons.forEach(btn => {
        btn.onclick = async (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          const action = btn.dataset.action
          if (action === 'bind-plot' || action === 'unbind-plot') {
            const plotId = btn.dataset.plotId
            if (!plotId) return
            if (action === 'bind-plot') await bindPlot(plotId)
            else                        await unbindPlot(plotId)
          } else if (action === 'bind-zone' || action === 'unbind-zone') {
            const fid = btn.dataset.fid
            if (!fid) return
            if (action === 'bind-zone') await bindZone(fid)
            else                        await unbindZone(fid)
          }
        }
      })
    }

    const evMap = map as unknown as {
      on: (e: string, fn: (ev: PopupOpenEvent) => void) => void
      off: (e: string, fn: (ev: PopupOpenEvent) => void) => void
    }
    evMap.on('popupopen', onPopupOpen)
    return () => evMap.off('popupopen', onPopupOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ownerType, ownerId, leafletReady])

  // ─── Операции (универсальные — по ownerType) ──────────────────────────────
  async function patchAndReload(url: string, body: object, busyKey: string) {
    setBusy(busyKey); setError(null)
    try {
      const r = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
      setReloadKey(k => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка операции')
    } finally {
      setBusy(null)
    }
  }

  async function bindPlot(plotId: string) {
    if (ownerType === 'object') {
      await patchAndReload(`/api/plots/${plotId}`, { bind_to_object: ownerId }, plotId)
    } else {
      await patchAndReload(`/api/masterplan-objects/${ownerId}`, { add_plot_id: plotId }, plotId)
    }
  }
  async function unbindPlot(plotId: string) {
    if (ownerType === 'object') {
      await patchAndReload(`/api/plots/${plotId}`, { unbind_from_object: ownerId }, plotId)
    } else {
      await patchAndReload(`/api/masterplan-objects/${ownerId}`, { remove_plot_id: plotId }, plotId)
    }
  }
  async function bindZone(fid: string) {
    if (ownerType === 'object') {
      await patchAndReload(`/api/functional-objects/${fid}`, { add_object_id: ownerId }, fid)
    } else {
      await patchAndReload(`/api/masterplan-objects/${ownerId}`, { add_functional_object_id: fid }, fid)
    }
    setShowAddZone(false)
  }
  async function unbindZone(fid: string) {
    if (ownerType === 'object') {
      await patchAndReload(`/api/functional-objects/${fid}`, { remove_object_id: ownerId }, fid)
    } else {
      await patchAndReload(`/api/masterplan-objects/${ownerId}`, { remove_functional_object_id: fid }, fid)
    }
  }

  // ─── Группировка по функ.зонам для левого сайдбара ────────────────────────
  // С учётом иерархии container_plot_id: если бизнес-объект привязан к зоне Г-1.4,
  // которая натянута на контейнер :ЗУ149, — мы покажем сам контейнер ПЛЮС всех
  // его кадастровых детей (:ЗУ67, :ЗУ103) под ним с отступом, даже если эти
  // дети физически не привязаны к нашему объекту через зону.
  const groups = useMemo<{ own: ZoneGroup[]; orphanPlots: GeoJSONFeature[] }>(() => {
    if (!geojson) return { own: [], orphanPlots: [] }

    // Индексы для быстрого поиска по plot_id и по container_plot_id.
    const byId       = new Map<string, GeoJSONFeature>()
    const byContainer = new Map<string, GeoJSONFeature[]>()
    for (const f of geojson.features) {
      byId.set(f.properties.plot_id, f)
      const cid = f.properties.container_plot_id
      if (cid) {
        const arr = byContainer.get(cid) ?? []
        arr.push(f)
        byContainer.set(cid, arr)
      }
    }

    const ownZones = new Map<string, ZoneGroup>()
    const ownNoZone: GeoJSONFeature[] = []
    const seenTop = new Set<string>()

    // Хелпер: гарантировать наличие группы для zone_code и вернуть её.
    const ensureGroup = (zone_code: string, sample: PlotFeatureProps): ZoneGroup => {
      let g = ownZones.get(zone_code)
      if (!g) {
        const fo = functionalObjects.find(x => x.zone_code === zone_code)
        g = {
          zone_code,
          zone_name: sample.functional_name,
          zone_kind: sample.functional_kind,
          zone_queue: sample.functional_queue,
          functional_object_id: fo?.id ?? null,
          plots: [],
          children: {},
          oks: sample.oks,
        }
        ownZones.set(zone_code, g)
      }
      if (g.oks.length === 0 && sample.oks.length > 0) g.oks = sample.oks
      return g
    }

    // ── Шаг 1: для каждого own-plot определяем «топ-уровень» зоны.
    // Если у own-plot есть container — за «топ» в группе принимаем сам контейнер
    // (а own-plot становится дочерним в этой же группе).
    for (const f of geojson.features) {
      const p = f.properties
      if (!isOwnPlot(p, owner)) continue

      // Если этот own-plot имеет контейнера → группируем под контейнером.
      if (p.container_plot_id) {
        const container = byId.get(p.container_plot_id)
        const zoneCode = container?.properties.functional_zone_code ?? p.functional_zone_code
        if (!zoneCode) {
          ownNoZone.push(f)
          continue
        }
        const sample = container?.properties ?? p
        const g = ensureGroup(zoneCode, sample)
        if (container && !seenTop.has(container.properties.plot_id)) {
          g.plots.push(container)
          seenTop.add(container.properties.plot_id)
        }
        const childKey = container?.properties.plot_id ?? p.container_plot_id
        const arr = g.children[childKey] ?? []
        if (!arr.some(x => x.properties.plot_id === p.plot_id)) arr.push(f)
        g.children[childKey] = arr
        continue
      }

      // Own-plot без контейнера — это или сам контейнер, или одиночный участок.
      if (!p.functional_zone_code) {
        ownNoZone.push(f)
        continue
      }
      const g = ensureGroup(p.functional_zone_code, p)
      if (!seenTop.has(p.plot_id)) {
        g.plots.push(f)
        seenTop.add(p.plot_id)
      }
    }

    // ── Шаг 2: для каждого контейнера на верхнем уровне добавляем ВСЕХ его
    // кадастровых детей (даже если они не own) — чтобы пользователь видел
    // всю нарезку зоны целиком.
    for (const g of ownZones.values()) {
      for (const containerFeat of g.plots) {
        const cp = containerFeat.properties
        if (!cp.is_container) continue
        const kids = byContainer.get(cp.plot_id) ?? []
        const arr = g.children[cp.plot_id] ?? []
        for (const kid of kids) {
          if (!arr.some(x => x.properties.plot_id === kid.properties.plot_id)) arr.push(kid)
        }
        // сортируем детей: сначала кадастровые (role=plot), потом сервитуты
        arr.sort((a, b) => {
          const ra = a.properties.role === 'servitude' ? 1 : 0
          const rb = b.properties.role === 'servitude' ? 1 : 0
          if (ra !== rb) return ra - rb
          return a.properties.plot_code.localeCompare(b.properties.plot_code)
        })
        g.children[cp.plot_id] = arr
      }
    }

    return {
      own: Array.from(ownZones.values()).sort((a, b) => a.zone_code.localeCompare(b.zone_code)),
      orphanPlots: ownNoZone,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geojson, functionalObjects, ownerType, ownerId])

  // Для obj-режима кандидаты — зоны где нет нашего objectId.
  // Для masterplan-режима нужны зоны где нет нашего masterplanId — для этого
  // используем feature collection функ.зон (там есть masterplan_objects[]).
  // Простая эвристика: если в zones-режиме geojson грузится — берём его.
  // В первой итерации для masterplan'а покажем ВСЕ зоны как кандидаты (без фильтра).
  const candidateZones = useMemo(() => {
    if (ownerType === 'object') {
      return functionalObjects
        .filter(fo => !fo.object_ids.includes(ownerId))
        .sort((a, b) => a.zone_code.localeCompare(b.zone_code))
    }
    // masterplan — фильтрация по masterplan_object_id потребовала бы отдельный fetch;
    // на первой итерации просто показываем все зоны.
    return functionalObjects.sort((a, b) => a.zone_code.localeCompare(b.zone_code))
  }, [functionalObjects, ownerType, ownerId])

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <Script
        src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        strategy="afterInteractive"
        onLoad={() => setLeafletReady(true)}
      />

      {/* Стили подписи кода участка/зоны прямо на полигоне (Leaflet tooltip).
          Прозрачный фон, без стрелки, моноширинный шрифт — чтобы код был
          считаем глазом сразу, без клика по полигону. */}
      <style jsx global>{`
        .leaflet-tooltip.plot-code-label {
          background: rgba(255, 255, 255, 0.78);
          border: none;
          box-shadow: none;
          padding: 1px 5px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          font-weight: 600;
          color: #1e293b;
          white-space: nowrap;
          pointer-events: none;
        }
        .leaflet-tooltip.plot-code-label::before {
          display: none;
        }
      `}</style>

      <div className="flex gap-4" style={{ height: '70vh', minHeight: 460 }}>
        {/* ─── Левая колонка: список зон ────────────────────────────────── */}
        <div className="w-72 shrink-0 flex flex-col border border-gray-200 rounded-md overflow-hidden bg-white">
          <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-600">
            Привязано к {ownerCode}
            {loading && <span className="ml-2 text-gray-400 font-normal">загрузка…</span>}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {!loading && groups.own.length === 0 && groups.orphanPlots.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 italic">
                Нет привязанных участков и функциональных зон.
              </div>
            )}

            {groups.own.map(g => (
              <div key={g.zone_code} className="px-3 py-2">
                <div
                  className="flex items-start justify-between gap-2 cursor-pointer hover:bg-blue-50 -mx-1 px-1 py-0.5 rounded"
                  onClick={() => zoomToPlots(g.plots.map(f => f.properties.plot_id))}
                  title="Кликните чтобы приблизить карту к участкам зоны"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold text-blue-700">{g.zone_code}</span>
                      {g.zone_queue && (
                        <span className="text-[10px] px-1 py-0.5 bg-amber-100 text-amber-700 rounded">оч. {g.zone_queue}</span>
                      )}
                    </div>
                    {g.zone_name && (
                      <div className="text-xs text-gray-700 mt-0.5 truncate" title={g.zone_name}>
                        {g.zone_name}
                      </div>
                    )}
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      участков: {g.plots.length}{g.oks.length ? ` · ОКС: ${g.oks.length}` : ''}
                    </div>
                  </div>
                  {g.functional_object_id && (
                    <button
                      type="button"
                      disabled={busy === g.functional_object_id}
                      onClick={(e) => { e.stopPropagation(); unbindZone(g.functional_object_id!) }}
                      className="text-[11px] text-red-600 hover:bg-red-50 px-1.5 py-0.5 rounded shrink-0 disabled:opacity-40"
                      title="Отвязать функциональную зону"
                    >
                      {busy === g.functional_object_id ? '…' : '×'}
                    </button>
                  )}
                </div>

                {g.plots.length > 0 && (
                  <ul className="mt-1.5 ml-2 space-y-0.5">
                    {g.plots.map(f => {
                      const p = f.properties
                      const ownTop = isOwnPlot(p, owner)
                      const kids = g.children[p.plot_id] ?? []
                      return (
                        <li key={p.plot_id} className="space-y-0.5">
                          <div
                            onMouseEnter={() => setSelectedFeatureId(p.plot_id)}
                            onMouseLeave={() => setSelectedFeatureId(null)}
                            onClick={() => zoomToPlots(
                              kids.length > 0 ? [p.plot_id, ...kids.map(k => k.properties.plot_id)] : [p.plot_id],
                              kids.length === 0,
                            )}
                            className={`flex items-center justify-between gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono cursor-pointer hover:bg-blue-100 ${selectedFeatureId === p.plot_id ? 'bg-blue-50' : ''}`}
                            title={p.is_container
                              ? `Контейнер зоны — содержит ${p.child_count} участок(ов)`
                              : 'Кликните чтобы приблизить карту к участку'}
                          >
                            <span className="truncate flex items-center gap-1" title={p.plot_name}>
                              {p.is_container && (
                                <span className="text-blue-700" title="контейнер">📦</span>
                              )}
                              <span className={p.is_container ? 'font-semibold' : ''}>{p.plot_code}</span>
                              {p.role === 'servitude' && <span className="ml-0.5 text-amber-600" title="сервитут">▷</span>}
                              {!ownTop && (
                                <span className="text-[9px] text-gray-400 ml-0.5">(нарезка)</span>
                              )}
                            </span>
                          </div>

                          {kids.length > 0 && (
                            <ul className="ml-4 border-l border-gray-200 pl-2 space-y-0.5">
                              {kids.map(kf => {
                                const kp = kf.properties
                                const isOwnKid = isOwnPlot(kp, owner)
                                return (
                                  <li
                                    key={kp.plot_id}
                                    onMouseEnter={() => setSelectedFeatureId(kp.plot_id)}
                                    onMouseLeave={() => setSelectedFeatureId(null)}
                                    onClick={() => zoomToPlots([kp.plot_id], true)}
                                    className={`flex items-center justify-between gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono cursor-pointer hover:bg-blue-100 ${selectedFeatureId === kp.plot_id ? 'bg-blue-50' : ''}`}
                                    title={kp.role === 'servitude' ? 'сервитут внутри контейнера' : 'кадастровая нарезка внутри контейнера'}
                                  >
                                    <span className="truncate flex items-center gap-1">
                                      <span className={isOwnKid ? 'font-semibold text-blue-700' : 'text-gray-600'}>{kp.plot_code}</span>
                                      {kp.role === 'servitude' && <span className="text-amber-600" title="сервитут">▷</span>}
                                      {isOwnKid && (
                                        <span className="text-[9px] text-blue-700 ml-0.5">(привязан)</span>
                                      )}
                                    </span>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ))}

            {groups.orphanPlots.length > 0 && (
              <div className="px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">
                  Участки без функ.зоны
                </div>
                <ul className="mt-1 ml-2 space-y-0.5">
                  {groups.orphanPlots.map(f => (
                    <li
                      key={f.properties.plot_id}
                      onClick={() => zoomToPlots([f.properties.plot_id], true)}
                      className="flex items-center justify-between gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono cursor-pointer hover:bg-blue-100"
                      title="Кликните чтобы приблизить карту к участку"
                    >
                      <span className="truncate">{f.properties.plot_code}</span>
                      <button
                        type="button"
                        disabled={busy === f.properties.plot_id}
                        onClick={(e) => { e.stopPropagation(); unbindPlot(f.properties.plot_id) }}
                        className="text-red-500 hover:text-red-700 disabled:opacity-40"
                        title="Отвязать участок"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="border-t border-gray-200">
            <button
              type="button"
              onClick={() => {
                const next = !showAddZone
                setShowAddZone(next)
                if (next) setViewMode('zones')
              }}
              className="w-full px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-50 text-left"
            >
              {showAddZone ? '✕ Скрыть выбор' : '+ Привязать зону'}
            </button>
            {showAddZone && (
              <div className="max-h-48 overflow-y-auto border-t border-gray-200">
                {candidateZones.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400 italic">
                    Нет доступных зон.
                  </div>
                ) : (
                  candidateZones.map(fo => {
                    const otherCount = fo.object_ids.length
                    return (
                      <button
                        key={fo.id}
                        type="button"
                        disabled={busy === fo.id}
                        onClick={() => bindZone(fo.id)}
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                        title={otherCount > 0
                          ? `В зоне уже ${otherCount} бизнес-объект(а).`
                          : 'Свободная зона.'}
                      >
                        <span className="font-mono font-semibold text-blue-700">{fo.zone_code}</span>
                        <span className="text-gray-700 truncate flex-1">{fo.name}</span>
                        {otherCount > 0 ? (
                          <span className="text-[10px] text-amber-600 shrink-0">+{otherCount}</span>
                        ) : (
                          <span className="text-[10px] text-gray-400 shrink-0">свободна</span>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* ─── Карта ─────────────────────────────────────────────────── */}
        <div className="flex-1 relative border border-gray-200 rounded-md overflow-hidden bg-gray-100">
          <div ref={containerRef} className="absolute inset-0" />

          {!leafletReady && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-white/50">
              <p className="text-sm text-gray-500">Загрузка карты…</p>
            </div>
          )}

          <div className="absolute top-2 left-14 bg-white/95 border border-gray-200 rounded-md shadow-sm flex text-xs overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode('plots')}
              className={`px-3 py-1.5 font-medium transition-colors ${
                viewMode === 'plots' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Участки
            </button>
            <button
              type="button"
              onClick={() => setViewMode('zones')}
              className={`px-3 py-1.5 font-medium transition-colors border-l border-gray-200 ${
                viewMode === 'zones' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Зоны
            </button>
          </div>

          <div className="absolute top-2 right-2 bg-white/95 border border-gray-200 rounded-md px-3 py-2 text-[11px] space-y-1 shadow-sm">
            <LegendSwatch color={ownerColor || OWN_COLOR_FALLBACK} label={`${ownerCode} (этот объект)`} weight={3} />
            <LegendSwatch color={UNASSIGNED_COLOR} label="без привязки" />
            <LegendSwatch color="#888" label="другие связи" opacity={0.1} />
            {viewMode === 'plots' && (
              <>
                <LegendSwatch color="#475569" label="контейнер (нарезан)" dashed weight={2.5} />
                <LegendSwatch color={SERVITUDE_COLOR} label="сервитуты" dashed />
              </>
            )}
          </div>

          {error && (
            <div className="absolute bottom-2 left-2 right-2 bg-red-50 border border-red-300 rounded-md px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function LegendSwatch({ color, label, weight = 1.5, opacity = 0.3, dashed = false }: { color: string; label: string; weight?: number; opacity?: number; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block w-3.5 h-3.5 rounded-sm shrink-0"
        style={{
          backgroundColor: `${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`,
          border: `${weight}px ${dashed ? 'dashed' : 'solid'} ${color}`,
        }}
      />
      <span className="text-gray-700">{label}</span>
    </div>
  )
}
