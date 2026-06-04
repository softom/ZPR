'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type PlotRow = {
  id: string
  code: string
  name: string
  role: string
  area_declared_m2: number | null
  permitted_use: string | null
  functional_objects: { zone_code: string; name: string; kind: string } | null
}

type ObjectOption = { id: string; code: string; current_name: string }

export default function UnassignedPlotsPage() {
  const [plots, setPlots] = useState<PlotRow[]>([])
  const [objects, setObjects] = useState<ObjectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [binding, setBinding] = useState<string | null>(null)
  const [selectedObj, setSelectedObj] = useState<string>('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [plotRes, objRes] = await Promise.all([
      supabase.from('plots')
        .select('id, code, name, role, area_declared_m2, permitted_use, functional_objects(zone_code, name, kind)')
        .eq('active', true)
        .is('object_id', null)
        .order('code'),
      supabase.from('objects')
        .select('id, code, current_name')
        .eq('active', true)
        .order('code'),
    ])
    setPlots((plotRes.data ?? []) as any[])
    setObjects(objRes.data ?? [])
    setLoading(false)
  }

  async function handleBind(plotId: string) {
    if (!selectedObj) return
    await fetch(`/api/plots/${plotId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bind_to_object: selectedObj }),
    })
    setBinding(null)
    setSelectedObj('')
    load()
  }

  if (loading) return <p className="text-gray-400 text-sm">Загрузка…</p>

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Участки без привязки к бизнес-объекту ЗПР. Общая инфраструктура (ТПУ, подстанции, променад) и автоимпорт из ПМТ.
      </p>
      {plots.length === 0 ? (
        <p className="text-gray-400 text-sm py-12 text-center">Все участки привязаны к объектам.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Код</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Название</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Зона ППТ</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ВРИ</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Площадь, м²</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Действие</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {plots.map(p => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-gray-700">{p.code}</td>
                  <td className="px-4 py-3 text-gray-900">{p.name}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {p.functional_objects ? `${(p.functional_objects as any).zone_code} — ${(p.functional_objects as any).name}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate">{p.permitted_use ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{p.area_declared_m2 ? Math.round(p.area_declared_m2) : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {binding === p.id ? (
                      <div className="flex items-center gap-2 justify-end">
                        <select
                          value={selectedObj}
                          onChange={e => setSelectedObj(e.target.value)}
                          className="text-xs border border-gray-300 rounded px-2 py-1"
                        >
                          <option value="">Выберите…</option>
                          {objects.map(o => <option key={o.id} value={o.id}>{o.code} — {o.current_name}</option>)}
                        </select>
                        <button
                          onClick={() => handleBind(p.id)}
                          disabled={!selectedObj}
                          className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          Привязать
                        </button>
                        <button
                          onClick={() => { setBinding(null); setSelectedObj('') }}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setBinding(p.id)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Привязать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
