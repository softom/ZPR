'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import ObjectModal from '@/components/ObjectModal'

type ObjectRow = {
  id: string
  code: string
  current_name: string
  contractor: string | null
  aliases: string[]
  active: boolean
}

export default function ObjectsPage() {
  const { isAdmin } = useRole()
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [modalObject, setModalObject] = useState<ObjectRow | null | undefined>(undefined)
  // undefined = закрыт, null = создание, ObjectRow = редактирование

  async function load() {
    setLoading(true)
    const query = supabase
      .from('objects')
      .select('id,code,current_name,contractor,aliases,active')
      .order('code')
    if (!showInactive) query.eq('active', true)
    const { data } = await query
    setObjects(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [showInactive])

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Объекты</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="rounded border-gray-300"
            />
            Показать неактивные
          </label>
          {isAdmin && (
            <button
              onClick={() => setModalObject(null)}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              + Новый объект
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : objects.length === 0 ? (
        <p className="text-gray-400 text-sm py-12 text-center">
          Объектов пока нет.{isAdmin ? ' Нажмите «+ Новый объект».' : ''}
        </p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Код</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Название</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Подрядчик</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</th>
                {isAdmin && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {objects.map(obj => (
                <tr key={obj.id} className={`hover:bg-gray-50 ${!obj.active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-mono text-gray-700">{obj.code}</td>
                  <td className="px-4 py-3 text-gray-900">
                    {obj.current_name}
                    {obj.aliases?.length > 0 && (
                      <span className="ml-2 text-xs text-gray-400">({obj.aliases.join(', ')})</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{obj.contractor ?? '—'}</td>
                  <td className="px-4 py-3">
                    {obj.active
                      ? <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Активен</span>
                      : <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Неактивен</span>
                    }
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setModalObject(obj)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Изменить
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ObjectModal
        open={modalObject !== undefined}
        object={modalObject ?? undefined}
        onClose={() => setModalObject(undefined)}
        onCreated={() => { setModalObject(undefined); load() }}
        onSaved={() => { setModalObject(undefined); load() }}
      />
    </div>
  )
}
