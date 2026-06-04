'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type LoadRow = {
  functional_object_id: string
  network: string
  total_load: number
  units: string | null
  items_count: number
  // Дополнительно — для контекста
  zone_code?: string | null
  functional_name?: string | null
}

type ZoneObject = {
  id: string
  code: string
  current_name: string
  color: string | null
  icon: string | null
  icon_small: string | null
}

type Props = {
  objectId: string
}

const NETWORK_LABEL: Record<string, { icon: string; label: string; defaultUnit: string }> = {
  water:   { icon: '💧', label: 'Водоснабжение',          defaultUnit: 'м³/сут' },
  sewer:   { icon: '🚽', label: 'Канализация (хоз/быт)',  defaultUnit: 'м³/сут' },
  storm:   { icon: '🌧️', label: 'Ливневая канализация',  defaultUnit: 'м³/сут' },
  heat:    { icon: '🔥', label: 'Теплоснабжение',         defaultUnit: 'Гкал/ч' },
  gas:     { icon: '🔥', label: 'Газоснабжение',          defaultUnit: 'м³/ч' },
  power:   { icon: '⚡', label: 'Электроснабжение',       defaultUnit: 'кВА' },
  telecom: { icon: '📡', label: 'Связь',                   defaultUnit: 'Mbit/s' },
}
const NETWORK_ORDER = ['water', 'sewer', 'storm', 'heat', 'gas', 'power', 'telecom']

export default function EngineeringLoadsTab({ objectId }: Props) {
  const [rows, setRows] = useState<LoadRow[]>([])
  // Все объекты ЗПР, связанные с каждой функциональной зоной (M:N).
  // Нужно чтобы рядом со строкой зоны показать «также сидит в зоне:» — список объектов.
  const [zoneObjectsMap, setZoneObjectsMap] = useState<Map<string, ZoneObject[]>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    ;(async () => {
      // 1) Все функциональные зоны, связанные с этим объектом ЗПР через junction
      const { data: junctionRows } = await supabase
        .from('functional_object_objects')
        .select('functional_object_id, functional_objects(id, zone_code, name)')
        .eq('object_id', objectId)

      const fos = (junctionRows ?? [])
        .map(r => (r as unknown as { functional_objects?: { id: string; zone_code: string; name: string } }).functional_objects)
        .filter((fo): fo is { id: string; zone_code: string; name: string } => !!fo)

      // 2) Плюс функциональные зоны, к которым ведут участки этого объекта через
      //    plots.object_id override (override на уровне участка).
      const { data: plotFOs } = await supabase
        .from('plots')
        .select('functional_object_id, functional_objects(id, zone_code, name)')
        .eq('object_id', objectId)
        .not('functional_object_id', 'is', null)

      const extraFOs = (plotFOs ?? [])
        .map(r => (r as unknown as { functional_objects?: { id: string; zone_code: string; name: string } }).functional_objects)
        .filter((fo): fo is { id: string; zone_code: string; name: string } => !!fo)

      // dedup
      const map = new Map<string, { id: string; zone_code: string; name: string }>()
      for (const fo of [...fos, ...extraFOs]) map.set(fo.id, fo)
      const uniqueFOs = [...map.values()]

      if (uniqueFOs.length === 0) {
        if (!cancelled) { setRows([]); setZoneObjectsMap(new Map()); setLoading(false) }
        return
      }

      const ids = uniqueFOs.map(f => f.id)

      // 3) Все объекты, связанные с этими зонами (M:N) — для отображения «соседей по зоне»
      const { data: allLinks } = await supabase
        .from('functional_object_objects')
        .select('functional_object_id, object_id, objects(id, code, current_name, color, icon, icon_small)')
        .in('functional_object_id', ids)

      // Supabase возвращает связь к одиночной записи (objects) как массив длины ≤ 1 при
      // joined-select. Нормализуем: разворачиваем в ZoneObject | null.
      const zoneObjsMap = new Map<string, ZoneObject[]>()
      for (const r of (allLinks ?? []) as unknown as Array<{
        functional_object_id: string
        objects: ZoneObject | ZoneObject[] | null
      }>) {
        const obj = Array.isArray(r.objects) ? r.objects[0] : r.objects
        if (!obj) continue
        const list = zoneObjsMap.get(r.functional_object_id) ?? []
        list.push(obj)
        zoneObjsMap.set(r.functional_object_id, list)
      }

      // 4) Нагрузки по этим functional_objects
      const { data: loadsByFunc } = await supabase
        .from('v_engineering_loads_by_functional')
        .select('functional_object_id, network, total_load, units, items_count')
        .in('functional_object_id', ids)

      const enriched = (loadsByFunc ?? []).map(l => {
        const fo = map.get(l.functional_object_id)
        return {
          ...l,
          zone_code: fo?.zone_code ?? null,
          functional_name: fo?.name ?? null,
        } as LoadRow
      })

      if (!cancelled) {
        setRows(enriched)
        setZoneObjectsMap(zoneObjsMap)
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [objectId])

  if (loading) return <p className="text-gray-400 text-sm">Загрузка…</p>

  if (rows.length === 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-800">
        Нагрузки не найдены. Проверьте, что у объекта есть привязанные функциональные зоны ППТ
        (вкладка «Участки и ОКС» → кнопка «+ Привязать зону»).
      </div>
    )
  }

  // Группируем по сети и по зоне для таблицы «сеть × зона»
  const networks = NETWORK_ORDER.filter(n => rows.some(r => r.network === n))
  const zones = [...new Set(rows.map(r => r.zone_code).filter(Boolean) as string[])].sort()

  // Суммарные значения по каждой сети
  const totals: Record<string, { value: number; units: string | null; items: number }> = {}
  for (const n of networks) {
    const sum = rows.filter(r => r.network === n).reduce((a, r) => a + Number(r.total_load), 0)
    const items = rows.filter(r => r.network === n).reduce((a, r) => a + r.items_count, 0)
    const units = rows.find(r => r.network === n)?.units ?? null
    totals[n] = { value: sum, units, items }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Расчётные нагрузки</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          По Тому 2.2 ППТ. Суммируются по всем функциональным зонам ППТ, привязанным к этому объекту.
          В одной зоне может быть несколько объектов ЗПР — нагрузки зоны общие на всех (M:N).
        </p>
      </div>

      {/* Суммарный итог по сетям */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
        {networks.map(n => {
          const meta = NETWORK_LABEL[n] ?? { icon: '•', label: n, defaultUnit: '' }
          const t = totals[n]
          return (
            <div key={n} className="bg-white border border-gray-200 rounded-md px-3 py-2">
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
              </div>
              <div className="text-lg font-semibold text-gray-900 mt-1">
                {t.value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
              </div>
              <div className="text-[10px] text-gray-400">{t.units ?? meta.defaultUnit} · {t.items} зап.</div>
            </div>
          )
        })}
      </div>

      {/* Разбивка по зонам с указанием всех объектов зоны */}
      {zones.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Зона ППТ</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Объекты в зоне</th>
                {networks.map(n => (
                  <th key={n} className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase" title={NETWORK_LABEL[n]?.label}>
                    {NETWORK_LABEL[n]?.icon ?? n} {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {zones.map(zone => {
                const zRows = rows.filter(r => r.zone_code === zone)
                const name = zRows[0]?.functional_name ?? ''
                const foId = zRows[0]?.functional_object_id
                const zoneObjs = foId ? (zoneObjectsMap.get(foId) ?? []) : []
                return (
                  <tr key={zone} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs align-top">
                      <div className="font-mono text-gray-700">{zone}</div>
                      <div className="text-gray-400 text-[10px] truncate max-w-[260px]">{name}</div>
                    </td>
                    <td className="px-3 py-2 text-xs align-top">
                      {zoneObjs.length === 0 ? (
                        <span className="text-gray-300">— нет связей —</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {zoneObjs.map(o => (
                            <span
                              key={o.id}
                              title={o.current_name}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono border-l-2 ${
                                o.id === objectId ? 'bg-blue-50 text-blue-800' : 'bg-gray-50 text-gray-600'
                              }`}
                              style={{ borderLeftColor: o.color ?? '#cbd5e1' }}
                            >
                              {o.icon_small
                                ? <img src={o.icon_small} alt="" className="w-3.5 h-3.5 object-contain" />
                                : o.icon && (o.icon.startsWith('data:image/') || /^https?:\/\//.test(o.icon)
                                  ? <img src={o.icon} alt="" className="w-3.5 h-3.5 object-contain" />
                                  : <span aria-hidden>{o.icon}</span>)}
                              <span>{o.code}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    {networks.map(n => {
                      const r = zRows.find(x => x.network === n)
                      return (
                        <td key={n} className="px-3 py-2 text-right text-xs font-mono align-top">
                          {r
                            ? Number(r.total_load).toLocaleString('ru-RU', { maximumFractionDigits: 1 })
                            : <span className="text-gray-300">—</span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
