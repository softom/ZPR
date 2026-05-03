'use client'

/**
 * /contracts — список договоров.
 *
 * Группировка по `project_stage` (Тип = стадия проекта).
 * Внутри каждой стадии — сортировка по номеру первого объекта (NNN из NNN_ТИП_ЁМКОСТЬ).
 *
 * После реструктуризации в ветке «Договор»:
 *   - object_codes JSONB удалён → join через document_objects
 *   - parties JSONB переименован в parties_snapshot, активные ЮЛ — через FK
 *   - Создание/редактирование — отдельные страницы /contracts/new и /contracts/[id]
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'

type ContractRow = {
  id: string
  title: string
  version: string | null
  type: string
  folder_path: string | null
  indexed_at: string | null
  project_stage: string | null
  customer:   { name: string } | null
  contractor: { name: string } | null
  document_objects: { object_code: string }[]
  created_at: string
}

type ProjectStage = {
  code: string
  label: string
  sort_order: number
}

const NO_STAGE_KEY = '__none__'
const NO_STAGE_LABEL = 'Без стадии'

/** Из кода `006_ГОСТИНИЦА_350` достаём 6 (число для сортировки). Если не извлекается — Number.MAX_SAFE_INTEGER (в конец). */
function objectNumber(code: string): number {
  const m = code.match(/^(\d+)/)
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
}

/** Минимальный «номер объекта» среди привязанных к договору — для сортировки внутри стадии. */
function minObjectNumber(c: ContractRow): number {
  if (!c.document_objects?.length) return Number.MAX_SAFE_INTEGER
  return Math.min(...c.document_objects.map(o => objectNumber(o.object_code)))
}

export default function ContractsPage() {
  const router = useRouter()
  const { isAdmin } = useRole()
  const [contracts, setContracts] = useState<ContractRow[]>([])
  const [stages, setStages] = useState<ProjectStage[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [docsRes, stagesRes] = await Promise.all([
      supabase
        .from('documents')
        .select(`
          id, title, version, type, folder_path, indexed_at, created_at, project_stage,
          customer:legal_entities!documents_customer_entity_id_fkey(name),
          contractor:legal_entities!documents_contractor_entity_id_fkey(name),
          document_objects(object_code)
        `)
        .eq('type', 'ДОГОВОРА')
        .is('deleted_at', null),
      supabase
        .from('project_stages')
        .select('code,label,sort_order')
        .order('sort_order', { ascending: true }),
    ])
    setContracts((docsRes.data as unknown as ContractRow[]) ?? [])
    setStages((stagesRes.data as unknown as ProjectStage[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  /** Группы: упорядочены как в `project_stages.sort_order`, в конце — «Без стадии» (если есть). */
  const groups = useMemo(() => {
    const stageMap = new Map<string, ProjectStage>()
    for (const s of stages) stageMap.set(s.code, s)

    // Распределяем договоры по группам
    const buckets = new Map<string, ContractRow[]>()
    for (const c of contracts) {
      const key = c.project_stage ?? NO_STAGE_KEY
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(c)
    }

    // Сортировка внутри группы — по min(номер объекта); ties → по title
    for (const list of buckets.values()) {
      list.sort((a, b) => {
        const na = minObjectNumber(a)
        const nb = minObjectNumber(b)
        if (na !== nb) return na - nb
        return a.title.localeCompare(b.title, 'ru')
      })
    }

    // Порядок групп: по sort_order справочника, потом «Без стадии»
    const ordered: Array<{ key: string; label: string; rows: ContractRow[] }> = []
    for (const s of stages) {
      const rows = buckets.get(s.code)
      if (rows && rows.length) ordered.push({ key: s.code, label: s.label, rows })
    }
    const noStageRows = buckets.get(NO_STAGE_KEY)
    if (noStageRows && noStageRows.length) {
      ordered.push({ key: NO_STAGE_KEY, label: NO_STAGE_LABEL, rows: noStageRows })
    }
    return ordered
  }, [contracts, stages])

  function formatDate(iso: string | null) {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString('ru-RU')
  }

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Договоры</h1>
        {isAdmin && (
          <button
            onClick={() => router.push('/contracts/new')}
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
        <div className="space-y-6">
          {groups.map(group => (
            <section key={group.key}>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 px-1 flex items-baseline gap-2">
                <span className={group.key === NO_STAGE_KEY ? 'text-gray-400' : 'text-blue-700'}>
                  {group.label}
                </span>
                <span className="text-xs text-gray-400 font-normal normal-case">({group.rows.length})</span>
              </h2>
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-32">Объекты</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Название</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Заказчик</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Подрядчик</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-24">Создан</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-12">Индекс</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {group.rows.map(c => (
                      <tr
                        key={c.id}
                        onClick={() => router.push(`/contracts/${c.id}`)}
                        className="hover:bg-gray-50 cursor-pointer"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {c.document_objects.length > 0
                              ? c.document_objects
                                  .slice()
                                  .sort((a, b) => objectNumber(a.object_code) - objectNumber(b.object_code))
                                  .map(o => (
                                    <span key={o.object_code} className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-100 whitespace-nowrap">
                                      {o.object_code}
                                    </span>
                                  ))
                              : <span className="text-gray-300 text-xs">—</span>
                            }
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-gray-900">
                          {c.title}
                          {c.version && <span className="ml-2 text-xs text-gray-400">{c.version}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-gray-700">{c.customer?.name ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-700">{c.contractor?.name ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatDate(c.created_at)}</td>
                        <td className="px-4 py-2.5">
                          {c.indexed_at
                            ? <span className="text-xs text-emerald-600" title={`Проиндексирован ${formatDate(c.indexed_at)}`}>●</span>
                            : <span className="text-xs text-gray-300" title="Не проиндексирован">○</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
