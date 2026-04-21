'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import ContractModal from '@/components/ContractModal'

type ContractRow = {
  id: string
  title: string
  version: string | null
  type: string
  object_codes: string[]
  letter: {
    date: string
    direction: string
    from_to: string
    method: string
  } | null
}

export default function ContractsPage() {
  const { isAdmin } = useRole()
  const [contracts, setContracts] = useState<ContractRow[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('documents')
      .select('id,title,version,type,object_codes,letter:letters(date,direction,from_to,method)')
      .eq('type', 'ДОГОВОРА')
      .order('id', { ascending: false })
    setContracts((data as unknown as ContractRow[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function formatDate(iso: string) {
    if (!iso) return '—'
    const [y, m, d] = iso.split('-')
    return `${d}.${m}.${y}`
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Договоры</h1>
        {isAdmin && (
          <button
            onClick={() => setModalOpen(true)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            + Договор
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : contracts.length === 0 ? (
        <p className="text-gray-400 text-sm py-12 text-center">
          Договоров пока нет.{isAdmin ? ' Нажмите «+ Договор».' : ''}
        </p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Дата</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Название</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Контрагент</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Объекты</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Метод</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {contracts.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {c.letter ? formatDate(c.letter.date) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    {c.title}
                    {c.version && <span className="ml-2 text-xs text-gray-400">{c.version}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{c.letter?.from_to ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {c.object_codes?.length > 0
                        ? c.object_codes.map(code => (
                            <span key={code} className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-100">
                              {code}
                            </span>
                          ))
                        : <span className="text-gray-300 text-xs">—</span>
                      }
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {c.letter?.method?.replaceAll('_', ' ') ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ContractModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => { setModalOpen(false); load() }}
      />
    </div>
  )
}
