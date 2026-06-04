'use client'

/**
 * Модал-редактор функциональной зоны ППТ (`functional_objects`).
 *
 * Архитектура по аналогии с ObjectModal:
 *   - Таб «Основное» — атрибуты зоны (большинство readonly из ПМТ Том 1.2) + селектор object_id
 *     (привязка к бизнес-объекту ЗПР через PATCH /api/functional-objects/[id]).
 *   - Таб «ОКС и параметры» — read-only снимок pmt_oks и pmt_zone_params для этой zone_code.
 *   - Таб «Участки и карта» — список plots зоны + карта (Leaflet OSM).
 *
 * Сохранение идёт через PATCH /api/functional-objects/[id] (idempotent, валидирует существование объекта).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Script from 'next/script'
import { supabase } from '@/lib/supabase'
import { isDataUrl } from '@/lib/objectIcon'
import type { LeafletGeoJSON, LeafletMap } from '@/lib/leaflet/types'

type Zone = {
  id: string
  zone_code: string
  name: string
  kind: string
  queue: string | null
  // M:N — список бизнес-объектов ЗПР, связанных с этой зоной
  object_ids: string[]
  source_pmt_object_name: string | null
  active: boolean
}

type ObjectRow = {
  id: string
  code: string
  current_name: string
  color: string | null
  icon: string | null
  icon_small: string | null
}

type ZoneParams = {
  zone_code: string
  area_m2: number | null
  k_otn: string | null
  k_isp: string | null
  k_oz_pct: number | null
  k_det_pct: number | null
  k_vzr_pct: number | null
  k_mm: string | null
  etazh_max: number | null
}

type OksRow = {
  id: number
  object_name: string
  etazh_max: number | null
  queue: string | null
  status_code: string | null
  value_code: string | null
}

type TabId = 'main' | 'params' | 'plots'

type Props = {
  open: boolean
  zone: Zone | null
  objects: ObjectRow[]
  onClose: () => void
  onSaved: () => void
}

const KIND_LABELS: Record<string, string> = {
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

export default function FunctionalObjectModal({ open, zone, objects, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<TabId>('main')
  // M:N: набор выбранных объектов для текущей зоны
  const [selectedObjectIds, setSelectedObjectIds] = useState<Set<string>>(new Set())
  const [params, setParams] = useState<ZoneParams | null>(null)
  const [oks, setOks] = useState<OksRow[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !zone) return
    setTab('main')
    setSelectedObjectIds(new Set(zone.object_ids ?? []))
    setError('')

    // Подгружаем pmt_zone_params и pmt_oks по zone_code
    Promise.all([
      supabase.from('pmt_zone_params').select('*').eq('zone_code', zone.zone_code).maybeSingle(),
      supabase.from('pmt_oks').select('id, object_name, etazh_max, queue, status_code, value_code').eq('zone_code', zone.zone_code).order('id'),
    ]).then(([{ data: zp }, { data: oksData }]) => {
      setParams(zp as ZoneParams | null)
      setOks((oksData as OksRow[]) ?? [])
    })
  }, [open, zone])

  if (!open || !zone) return null

  const original = new Set(zone.object_ids ?? [])
  const changed = original.size !== selectedObjectIds.size
    || [...original].some(id => !selectedObjectIds.has(id))

  async function save() {
    if (!zone) return
    setSaving(true)
    setError('')
    try {
      const r = await fetch(`/api/functional-objects/${zone.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set_object_ids: [...selectedObjectIds] }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const widthClass = tab === 'plots' ? 'max-w-6xl' : 'max-w-2xl'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-white rounded-lg shadow-xl w-full ${widthClass} flex flex-col max-h-[92vh]`}
        onClick={e => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-blue-700">{zone.zone_code}</span>
              {zone.queue && (
                <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded">
                  очередь {zone.queue}
                </span>
              )}
              <span className="text-xs text-gray-500">{KIND_LABELS[zone.kind] ?? zone.kind}</span>
            </div>
            <div className="text-base text-gray-800 mt-0.5 truncate">{zone.name}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-100"
            title="Закрыть"
          >
            ✕
          </button>
        </div>

        {/* Табы */}
        <div className="px-5 pt-3 border-b border-gray-200 flex gap-1 text-sm">
          <Tab id="main"   active={tab} onClick={setTab}>Основное</Tab>
          <Tab id="params" active={tab} onClick={setTab}>
            ОКС и параметры
            {oks.length > 0 && <span className="ml-1 text-xs text-gray-400">({oks.length})</span>}
          </Tab>
          <Tab id="plots"  active={tab} onClick={setTab}>Участки и карта</Tab>
        </div>

        {/* Содержимое */}
        <div className="flex-1 overflow-auto p-5">
          {tab === 'main' && (
            <MainTab
              zone={zone}
              objects={objects}
              selectedObjectIds={selectedObjectIds}
              setSelectedObjectIds={setSelectedObjectIds}
            />
          )}
          {tab === 'params' && <ParamsTab params={params} oks={oks} />}
          {tab === 'plots' && (
            <ZonePlotsTab zoneCode={zone.zone_code} functionalObjectId={zone.id} active={tab === 'plots'} />
          )}
        </div>

        {/* Футер */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-3 bg-gray-50">
          <div className="text-sm text-red-600">{error}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Закрыть
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!changed || saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Таб: Основное

function MainTab({
  zone, objects, selectedObjectIds, setSelectedObjectIds,
}: {
  zone: Zone
  objects: ObjectRow[]
  selectedObjectIds: Set<string>
  setSelectedObjectIds: (s: Set<string>) => void
}) {
  function toggle(id: string) {
    const next = new Set(selectedObjectIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedObjectIds(next)
  }

  return (
    <div className="space-y-4">
      {/* Снимок из ПМТ */}
      <div className="bg-gray-50 border border-gray-200 rounded-md p-3 space-y-2">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          Снимок из ПМТ (Том 1.2 ППТ)
        </div>
        <Field label="Код зоны">{zone.zone_code}</Field>
        <Field label="Название из ПМТ">{zone.source_pmt_object_name || zone.name}</Field>
        <Field label="Текущее имя">{zone.name}</Field>
        <Field label="Тип">{KIND_LABELS[zone.kind] ?? zone.kind}</Field>
        <Field label="Очередь">{zone.queue ?? '—'}</Field>
        <div className="text-xs text-gray-400 italic pt-1 border-t border-gray-200">
          Атрибуты обновляются автоматически при перезаливке `pmt_to_functional_objects` (UPSERT по zone_code).
        </div>
      </div>

      {/* Привязка к бизнес-объектам ЗПР — M:N */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          Привязка к объектам ЗПР <span className="text-xs text-gray-500 font-normal">(выбрано: {selectedObjectIds.size})</span>
        </label>
        <p className="text-xs text-gray-500 mb-2">
          В одной зоне может быть несколько объектов ЗПР — например, отель + ресторан + СПА. Все они унаследуют участки этой зоны и поделят её нагрузки.
        </p>
        <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
          {objects.map(o => {
            const checked = selectedObjectIds.has(o.id)
            return (
              <label
                key={o.id}
                className={`flex items-center gap-3 px-3 py-2 cursor-pointer text-sm transition-colors ${
                  checked ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(o.id)}
                  className="rounded border-gray-300"
                />
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium text-white"
                  style={{ backgroundColor: o.color || '#64748b' }}
                >
                  {o.icon && (isDataUrl(o.icon)
                    ? <img src={o.icon_small || o.icon} alt="" style={{ width: 14, height: 14, objectFit: 'contain' }} />
                    : <span>{o.icon}</span>
                  )}
                  {o.code}
                </span>
                <span className="text-gray-700 truncate">{o.current_name}</span>
              </label>
            )
          })}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Эффективные привязки участков рассчитываются через массив <code>v_plots_current.effective_object_ids</code>
          (plots.object_id-override + связи зоны через junction <code>functional_object_objects</code>).
        </p>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <div className="w-40 shrink-0 text-gray-500">{label}</div>
      <div className="flex-1 text-gray-800">{children}</div>
    </div>
  )
}

// ============================================================================
// Таб: ОКС и параметры

function ParamsTab({ params, oks }: { params: ZoneParams | null; oks: OksRow[] }) {
  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Параметры застройки (pmt_zone_params)</h3>
        {!params ? (
          <p className="text-sm text-gray-400 italic">Нет данных для этой зоны.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-sm bg-gray-50 border border-gray-200 rounded-md p-3">
            <Field label="Площадь">{params.area_m2 != null ? `${params.area_m2.toLocaleString('ru')} м²` : '—'}</Field>
            <Field label="Этажность (макс)">{params.etazh_max ?? '—'}</Field>
            <Field label="Котн">{params.k_otn ?? '—'}</Field>
            <Field label="Кисп">{params.k_isp ?? '—'}</Field>
            <Field label="Коз">{params.k_oz_pct != null ? `${params.k_oz_pct} %` : '—'}</Field>
            <Field label="Кдет.пл">{params.k_det_pct != null ? `${params.k_det_pct} %` : '—'}</Field>
            <Field label="Квзр.пл">{params.k_vzr_pct != null ? `${params.k_vzr_pct} %` : '—'}</Field>
            <Field label="Км/м">{params.k_mm ?? '—'}</Field>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          ОКС в зоне (pmt_oks) <span className="text-gray-400 font-normal">· {oks.length}</span>
        </h3>
        {oks.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Нет ОКС, привязанных к этой зоне.</p>
        ) : (
          <div className="border border-gray-200 rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500">Объект</th>
                  <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500">Этаж.</th>
                  <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500">Очередь</th>
                  <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-500">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {oks.map(o => (
                  <tr key={o.id}>
                    <td className="px-3 py-1.5 text-gray-800">{o.object_name}</td>
                    <td className="px-3 py-1.5 text-gray-600">{o.etazh_max ?? '—'}</td>
                    <td className="px-3 py-1.5 text-gray-600">{o.queue ?? '—'}</td>
                    <td className="px-3 py-1.5 text-gray-600">
                      {o.status_code ?? '—'}
                      {o.value_code && <span className="text-gray-400 ml-1">/ {o.value_code}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// ============================================================================
// Таб: Участки и карта

type ZonePlotFeature = {
  type: 'Feature'
  id?: string
  geometry: { type: string; coordinates: unknown }
  properties: {
    plot_id: string
    plot_code: string
    plot_name: string
    role: string
    polygon_count: number | null
    area_calc_m2: number | null
    area_declared_m2: number | null
    permitted_use: string | null
    functional_zone_code: string | null
    object_code: string | null
    object_color: string | null
    object_icon: string | null
  }
}

function ZonePlotsTab({ zoneCode, functionalObjectId, active }: { zoneCode: string; functionalObjectId: string; active: boolean }) {
  const mapRef = useRef<LeafletMap | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<LeafletGeoJSON | null>(null)
  const [leafletReady, setLeafletReady] = useState<boolean>(typeof window !== 'undefined' && !!window.L)

  const [features, setFeatures] = useState<ZonePlotFeature[]>([])
  const [loading, setLoading] = useState(true)

  // Загружаем GeoJSON и фильтруем по zone_code
  useEffect(() => {
    let abort = false
    setLoading(true)
    fetch('/api/plots/geojson?role=all')
      .then(r => r.json())
      .then(data => {
        if (abort) return
        const all = (data?.features ?? []) as ZonePlotFeature[]
        setFeatures(all.filter(f => f.properties.functional_zone_code === zoneCode))
      })
      .catch(() => { if (!abort) setFeatures([]) })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [zoneCode, functionalObjectId])

  // Инициализация Leaflet
  useEffect(() => {
    if (!leafletReady || !active || !containerRef.current || mapRef.current) return
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
    }
  }, [leafletReady, active])

  // invalidateSize при показе таба
  useEffect(() => {
    if (active && mapRef.current) {
      setTimeout(() => mapRef.current?.invalidateSize(), 50)
    }
  }, [active])

  // Перерисовка слоя
  useEffect(() => {
    const L = window.L
    const map = mapRef.current
    if (!L || !map || features.length === 0) return

    if (layerRef.current) {
      map.removeLayer(layerRef.current)
      layerRef.current = null
    }

    const gj = { type: 'FeatureCollection', features }
    const layer = L.geoJSON(gj as object, {
      style: (feature: unknown) => {
        const f = feature as ZonePlotFeature
        const isServ = f.properties.role === 'servitude'
        return {
          color: isServ ? '#f59e0b' : (f.properties.object_color || '#2563eb'),
          weight: isServ ? 1.5 : 2,
          fillOpacity: isServ ? 0.2 : 0.4,
          dashArray: isServ ? '4,3' : undefined,
        }
      },
      onEachFeature: (feature: unknown, lyr: unknown) => {
        const f = feature as ZonePlotFeature
        const p = f.properties
        const html = `
          <div style="font-family:ui-monospace,monospace;font-size:12px;min-width:200px;">
            <div style="font-weight:600;color:#1e40af;">${p.plot_code}</div>
            <div style="color:#475569;margin-top:2px;">${p.plot_name ?? ''}</div>
            ${p.polygon_count && Number(p.polygon_count) > 1 ? `<div><b>Контуров:</b> ${p.polygon_count}</div>` : ''}
            ${p.permitted_use ? `<div><b>ВРИ:</b> ${p.permitted_use}</div>` : ''}
            ${p.area_calc_m2 ? `<div><b>S:</b> ${Number(p.area_calc_m2).toLocaleString('ru', { maximumFractionDigits: 0 })} м²</div>` : ''}
          </div>
        `
        ;(lyr as { bindPopup: (h: string) => unknown }).bindPopup(html)
      },
    })
    layer.addTo(map)
    layerRef.current = layer

    try {
      map.fitBounds(layer.getBounds(), { padding: [20, 20] } as object)
    } catch { /* пустые bounds */ }
  }, [features])

  return (
    <>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <Script
        src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        strategy="afterInteractive"
        onLoad={() => setLeafletReady(true)}
      />

      <div className="flex gap-4" style={{ height: '60vh', minHeight: 420 }}>
        {/* Список участков */}
        <div className="w-64 shrink-0 flex flex-col border border-gray-200 rounded-md overflow-hidden bg-white">
          <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-600">
            Участки зоны
            {loading && <span className="ml-2 text-gray-400 font-normal">…</span>}
            {!loading && <span className="ml-2 text-gray-400 font-normal">· {features.length}</span>}
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
            {!loading && features.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 italic">
                У этой зоны нет участков с геометрией.
              </div>
            )}
            {features.map(f => {
              const p = f.properties
              return (
                <div key={p.plot_id} className="px-3 py-2 text-xs hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-blue-700">{p.plot_code}</span>
                    {p.role === 'servitude' && (
                      <span className="text-amber-600" title="сервитут">▷</span>
                    )}
                  </div>
                  {p.plot_name && p.plot_name !== p.plot_code && (
                    <div className="text-gray-600 truncate mt-0.5" title={p.plot_name}>{p.plot_name}</div>
                  )}
                  {p.area_calc_m2 != null && (
                    <div className="text-gray-400 mt-0.5">
                      {Number(p.area_calc_m2).toLocaleString('ru', { maximumFractionDigits: 0 })} м²
                      {p.polygon_count && p.polygon_count > 1 && (
                        <span className="ml-1">· {p.polygon_count} контуров</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Карта */}
        <div className="flex-1 relative border border-gray-200 rounded-md overflow-hidden bg-gray-100">
          <div ref={containerRef} className="absolute inset-0" />
          {!leafletReady && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-white/50">
              <p className="text-sm text-gray-500">Загрузка карты…</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ============================================================================

function Tab({ id, active, onClick, children }: { id: TabId; active: TabId; onClick: (id: TabId) => void; children: React.ReactNode }) {
  const isActive = active === id
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
        isActive
          ? 'border-blue-500 text-blue-700'
          : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  )
}
