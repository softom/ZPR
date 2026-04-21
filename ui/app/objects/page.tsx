'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import ObjectModal from '@/components/ObjectModal'

type ObjectRow = {
  id: string
  code: string
  current_name: string
  contractor: string | null
}

export default function ObjectsPage() {
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('objects').select('id,code,current_name,contractor').order('code')
    setObjects(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Объекты</h1>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
        >
          + Новый объект
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : objects.length === 0 ? (
        <p className="text-gray-400 text-sm">Объектов пока нет. Создайте первый.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Код</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Название</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Подрядчик</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {objects.map(obj => (
                <tr key={obj.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-gray-700">{obj.code}</td>
                  <td className="px-4 py-3 text-gray-900">{obj.current_name}</td>
                  <td className="px-4 py-3 text-gray-500">{obj.contractor ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ObjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => load()}
      />
    </div>
  )
}
