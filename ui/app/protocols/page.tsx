'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

type Meeting = {
  id: string
  code: string | null
  meeting_date: string
  title: string
  object_ids: string[]
  status: string
  created_at: string
  participants_count?: number
  tasks_count?: number
  topics_count?: number
  legal_entities?: LegalEntityShort[]
}

type ObjectInfo = {
  id: string
  code: string
  current_name: string
}

type LegalEntityShort = {
  id: string
  name: string
}

/** Короткое имя юр.лица для чипа. Берём первый алиас, иначе name без «ООО»/«ИП». */
function shortLegalName(name: string, aliases: string[] = []): string {
  if (aliases.length > 0) return aliases[0]
  return name
    .replace(/^(ООО|ОАО|ЗАО|ИП|АО|ПАО)\s+/i, '')
    .replace(/[«»"]/g, '')
    .trim()
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  planned:              { label: 'Создано',          cls: 'bg-gray-100 text-gray-700' },
  transcript_uploaded:  { label: 'Транскрипт',       cls: 'bg-yellow-100 text-yellow-800' },
  processed:            { label: 'LLM-обработано',   cls: 'bg-purple-100 text-purple-800' },
  approved:             { label: 'Утверждено',       cls: 'bg-green-100 text-green-800' },
  protocoled:           { label: 'Протокол готов',   cls: 'bg-blue-100 text-blue-800' },
}

const EMPTY_FORM = {
  meeting_date: new Date().toISOString().slice(0, 10),
  title: '',
  legal_entity_ids: [] as string[],
}

type LegalEntityFull = {
  id: string
  name: string
  aliases: string[]
}

export default function ProtocolsPage() {
  const router = useRouter()
  const [items, setItems] = useState<Meeting[]>([])
  const [objects, setObjects] = useState<ObjectInfo[]>([])
  const [allLegalEntities, setAllLegalEntities] = useState<LegalEntityFull[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // фильтры
  const [filterEntity, setFilterEntity] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  // модал создания
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    const [objectsRes, meetingsRes, entitiesRes] = await Promise.all([
      supabase.from('objects').select('id,code,current_name').eq('active', true).order('code'),
      supabase.from('meetings').select('*').order('meeting_date', { ascending: false }),
      supabase.from('legal_entities').select('id,name,aliases').order('name'),
    ])
    if (objectsRes.error) setError(objectsRes.error.message)
    if (meetingsRes.error) {
      setError(meetingsRes.error.message)
      setLoading(false)
      return
    }
    if (entitiesRes.error) console.error('legal_entities load:', entitiesRes.error)

    const ents = ((entitiesRes.data || []) as Array<{ id: string; name: string; aliases: unknown }>).map(
      (e) => ({ id: e.id, name: e.name, aliases: Array.isArray(e.aliases) ? (e.aliases as string[]) : [] })
    )
    setAllLegalEntities(ents)
    const entById = new Map(ents.map((e) => [e.id, e]))

    setObjects((objectsRes.data || []) as ObjectInfo[])
    const data = meetingsRes.data
    const withCounts = await Promise.all(
      (data || []).map(async (m) => {
        const [pRes, tRes, topRes, leRes] = await Promise.all([
          supabase
            .from('meeting_participants')
            .select('contact_id', { count: 'exact', head: true })
            .eq('meeting_id', m.id),
          supabase
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('meeting_id', m.id),
          supabase
            .from('meeting_topics')
            .select('id', { count: 'exact', head: true })
            .eq('meeting_id', m.id),
          supabase
            .from('meeting_legal_entities')
            .select('legal_entity_id, seq')
            .eq('meeting_id', m.id)
            .order('seq', { ascending: true, nullsFirst: false }),
        ])
        const legal_entities: LegalEntityShort[] = (leRes.data ?? [])
          .map((row: { legal_entity_id: string }) => entById.get(row.legal_entity_id))
          .filter((x): x is LegalEntityFull => Boolean(x))
          .map((e) => ({ id: e.id, name: e.name }))
        return {
          ...m,
          participants_count: pRes.count ?? 0,
          tasks_count: tRes.count ?? 0,
          topics_count: topRes.count ?? 0,
          legal_entities,
        }
      })
    )
    setItems(withCounts)
    setLoading(false)
  }

  const filtered = useMemo(() => {
    return items.filter((m) => {
      if (filterEntity && !(m.legal_entities ?? []).some((e) => e.id === filterEntity)) return false
      if (filterStatus && m.status !== filterStatus) return false
      return true
    })
  }, [items, filterEntity, filterStatus])

  function openCreate() {
    setForm(EMPTY_FORM)
    setError('')
    setCreating(true)
  }

  function close() {
    setCreating(false)
    setForm(EMPTY_FORM)
    setError('')
  }

  async function save() {
    setSaving(true)
    setError('')
    const payload = {
      meeting_date: form.meeting_date,
      title: form.title.trim(),
      status: 'planned',
      // folder_path задаётся системой при первой загрузке транскрипции (см. WIKI 02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ → ПРОТОКОЛЫ)
    }
    if (!payload.title) {
      setError('Название собрания обязательно')
      setSaving(false)
      return
    }
    if (!payload.meeting_date) {
      setError('Дата обязательна')
      setSaving(false)
      return
    }
    if (form.legal_entity_ids.length === 0) {
      setError('Выберите хотя бы одно юр.лицо-участника')
      setSaving(false)
      return
    }

    // Создаём собрание
    const { data, error: e } = await supabase
      .from('meetings')
      .insert(payload)
      .select('id')
      .single()
    if (e || !data?.id) {
      setSaving(false)
      setError(e?.message ?? 'Не удалось создать собрание')
      return
    }

    // Привязываем юр.лица
    const links = form.legal_entity_ids.map((legal_entity_id, idx) => ({
      meeting_id: data.id,
      legal_entity_id,
      seq: idx + 1,
    }))
    const { error: linkErr } = await supabase.from('meeting_legal_entities').insert(links)
    setSaving(false)
    if (linkErr) {
      setError(`Собрание создано, но не удалось привязать юр.лица: ${linkErr.message}`)
      return
    }

    close()
    router.push(`/protocols/${data.id}`)
  }

  function toggleFormEntity(id: string) {
    setForm((f) => ({
      ...f,
      legal_entity_ids: f.legal_entity_ids.includes(id)
        ? f.legal_entity_ids.filter((x) => x !== id)
        : [...f.legal_entity_ids, id],
    }))
  }

  function formatDate(iso: string) {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Протоколы</h1>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Создать собрание
        </button>
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={filterEntity}
          onChange={(e) => setFilterEntity(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
        >
          <option value="">Все юр.лица</option>
          {allLegalEntities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Все статусы</option>
          {Object.entries(STATUS_LABELS).map(([code, { label }]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-400 ml-auto">
          {filtered.length} из {items.length}
        </span>
      </div>

      {error && !creating && (
        <div className="p-3 mb-4 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div>Загрузка…</div>
      ) : (
        <div className="overflow-x-auto bg-white rounded shadow">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left text-gray-700">
                <th className="px-4 py-3">Дата</th>
                <th className="px-4 py-3">Юр.лица</th>
                <th className="px-4 py-3">Название</th>
                <th className="px-4 py-3">Объекты</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3 text-center">Участников</th>
                <th className="px-4 py-3 text-center">Тем</th>
                <th className="px-4 py-3 text-center">Задач</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const status = STATUS_LABELS[m.status] ?? { label: m.status, cls: 'bg-gray-100 text-gray-700' }
                return (
                  <tr
                    key={m.id}
                    onClick={() => router.push(`/protocols/${m.id}`)}
                    className="border-b hover:bg-blue-50 cursor-pointer"
                  >
                    <td className="px-4 py-3 font-mono text-gray-700">
                      {formatDate(m.meeting_date)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-xs">
                      {m.legal_entities && m.legal_entities.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {m.legal_entities.slice(0, 3).map((e) => {
                            const full = allLegalEntities.find((x) => x.id === e.id)
                            const label = shortLegalName(e.name, full?.aliases)
                            return (
                              <span
                                key={e.id}
                                className="inline-block px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs"
                                title={e.name}
                              >
                                {label}
                              </span>
                            )
                          })}
                          {m.legal_entities.length > 3 && (
                            <span className="text-xs text-gray-400">
                              +{m.legal_entities.length - 3}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium">{m.title}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {m.object_ids && m.object_ids.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {m.object_ids.slice(0, 3).map((oid) => {
                            const o = objects.find((x) => x.id === oid)
                            return (
                              <span
                                key={oid}
                                className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-700 rounded text-xs font-mono"
                                title={o?.current_name}
                              >
                                {o?.code ?? oid.slice(0, 8)}
                              </span>
                            )
                          })}
                          {m.object_ids.length > 3 && (
                            <span className="text-xs text-gray-400">
                              +{m.object_ids.length - 3}
                            </span>
                          )}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${status.cls}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600">
                      {m.participants_count || '—'}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600">
                      {m.topics_count || '—'}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600">
                      {m.tasks_count || '—'}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-400">
                    {items.length === 0
                      ? 'Собраний ещё нет — нажмите «Создать собрание»'
                      : 'Ни одно собрание не подходит под фильтры'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal create */}
      {creating && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={close}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold">Новое собрание</h2>
            </div>
            <div className="p-6 space-y-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Дата собрания *
                </label>
                <input
                  type="date"
                  value={form.meeting_date}
                  onChange={(e) => setForm({ ...form, meeting_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Название *
                </label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Рабочее собрание по вопросам массинга"
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Юр.лица-участники *
                </label>
                <div className="space-y-1 max-h-56 overflow-y-auto border border-gray-200 rounded p-3 bg-gray-50">
                  {allLegalEntities.length === 0 ? (
                    <p className="text-sm text-gray-400">Юр.лица не загружены</p>
                  ) : (
                    allLegalEntities.map((e) => {
                      const checked = form.legal_entity_ids.includes(e.id)
                      return (
                        <label
                          key={e.id}
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-white px-2 py-1 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleFormEntity(e.id)}
                            className="rounded"
                          />
                          <span className="text-gray-800">{e.name}</span>
                          {e.aliases.length > 0 && (
                            <span className="ml-auto text-xs text-gray-400">
                              {e.aliases[0]}
                            </span>
                          )}
                        </label>
                      )
                    })
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Минимум одна организация (это могут быть подрядчики, заказчик, оператор,
                  эксперты). Сотрудников из этих организаций отметите на следующем шаге.
                </p>
              </div>

              <p className="text-xs text-gray-500">
                Объекты обсуждения и сотрудники-участники выбираются на следующем шаге, в карточке собрания.
              </p>
            </div>
            <div className="p-6 border-t bg-gray-50 flex justify-end gap-3">
              <button
                onClick={close}
                disabled={saving}
                className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Создание…' : 'Создать и продолжить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
