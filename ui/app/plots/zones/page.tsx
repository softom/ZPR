'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import { isDataUrl } from '@/lib/objectIcon'
import FunctionalObjectModal from '@/components/FunctionalObjectModal'

type FunctionalObjectRow = {
  id: string
  zone_code: string
  name: string
  kind: string
  queue: string | null
  // M:N: список связанных бизнес-объектов
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

type ZoneFilter = 'all' | 'with_object' | 'without_object'

export default function ZonesPage() {
  useRole() // консистентно с остальным UI — поднимаем сессию
  const [zones, setZones] = useState<FunctionalObjectRow[]>([])
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [modalZone, setModalZone] = useState<FunctionalObjectRow | null>(null)
  const [filter, setFilter] = useState<ZoneFilter>('all')

  async function load() {
    setLoading(true)
    const [{ data: zonesData }, { data: objectsData }] = await Promise.all([
      supabase
        .from('functional_objects')
        .select('id, zone_code, name, kind, queue, source_pmt_object_name, active, functional_object_objects(object_id)')
        .eq('active', true)
        .order('zone_code'),
      supabase
        .from('objects')
        .select('id, code, current_name, color, icon, icon_small')
        .eq('active', true)
        .order('code'),
    ])
    type RawRow = Omit<FunctionalObjectRow, 'object_ids'> & {
      functional_object_objects: { object_id: string }[] | null
    }
    const normalized = ((zonesData as RawRow[] | null) ?? []).map(r => ({
      id: r.id,
      zone_code: r.zone_code,
      name: r.name,
      kind: r.kind,
      queue: r.queue,
      source_pmt_object_name: r.source_pmt_object_name,
      active: r.active,
      object_ids: (r.functional_object_objects ?? []).map(x => x.object_id),
    })) as FunctionalObjectRow[]
    setZones(normalized)
    setObjects((objectsData as ObjectRow[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const objectsById = useMemo(() => {
    const map = new Map<string, ObjectRow>()
    for (const o of objects) map.set(o.id, o)
    return map
  }, [objects])

  const filtered = useMemo(() => {
    if (filter === 'with_object') return zones.filter(z => z.object_ids.length > 0)
    if (filter === 'without_object') return zones.filter(z => z.object_ids.length === 0)
    return zones
  }, [zones, filter])

  const stats = useMemo(() => ({
    total: zones.length,
    withObject: zones.filter(z => z.object_ids.length > 0).length,
    withoutObject: zones.filter(z => z.object_ids.length === 0).length,
  }), [zones])

  return (
    <div className="px-8 py-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Функциональные зоны ППТ
          <span className="ml-3 text-sm font-normal text-gray-500">
            {stats.total} зон · {stats.withObject} с привязкой · {stats.withoutObject} без
          </span>
        </h2>
        <div className="flex gap-1 text-sm">
          {([
            ['all',             `Все (${stats.total})`],
            ['with_object',     `С привязкой (${stats.withObject})`],
            ['without_object',  `Без привязки (${stats.withoutObject})`],
          ] as [ZoneFilter, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                filter === k ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : filtered.length === 0 ? (
        <p className="text-gray-400 text-sm py-12 text-center">Нет зон по выбранному фильтру.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <Th>Код</Th>
                <Th>Название</Th>
                <Th>Тип</Th>
                <Th>Очередь</Th>
                <Th>Привязка к объекту ЗПР</Th>
                <Th>&nbsp;</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(z => {
                const linkedObjs = z.object_ids
                  .map(id => objectsById.get(id))
                  .filter((o): o is ObjectRow => !!o)
                return (
                  <tr key={z.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-blue-700">
                      {z.zone_code}
                    </td>
                    <td className="px-4 py-2.5 text-gray-800">
                      {z.name}
                      {z.source_pmt_object_name && z.source_pmt_object_name !== z.name && (
                        <div className="text-xs text-gray-400 mt-0.5" title="Из ПМТ Том 1.2">
                          {z.source_pmt_object_name}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">
                      {KIND_LABELS[z.kind] ?? z.kind}
                    </td>
                    <td className="px-4 py-2.5">
                      {z.queue && (
                        <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded">
                          {z.queue}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {linkedObjs.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {linkedObjs.map(obj => (
                            <span
                              key={obj.id}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium text-white"
                              style={{ backgroundColor: obj.color || '#64748b' }}
                              title={obj.current_name}
                            >
                              {obj.icon && (isDataUrl(obj.icon)
                                ? <img src={obj.icon_small || obj.icon} alt="" style={{ width: 14, height: 14, objectFit: 'contain' }} />
                                : <span>{obj.icon}</span>
                              )}
                              {obj.code}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs italic text-gray-400">без привязки</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => setModalZone(z)}
                        className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 hover:bg-blue-50 rounded"
                      >
                        Изменить
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <FunctionalObjectModal
        open={modalZone !== null}
        zone={modalZone}
        objects={objects}
        onClose={() => setModalZone(null)}
        onSaved={() => { setModalZone(null); load() }}
      />
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
      {children}
    </th>
  )
}
