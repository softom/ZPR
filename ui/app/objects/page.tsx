'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import ObjectModal from '@/components/ObjectModal'
import MasterplanObjectModal from '@/components/MasterplanObjectModal'

type ObjectRow = {
  id: string
  code: string
  current_name: string
  contractor: string | null
  aliases: string[]
  active: boolean
  color: string | null
  icon: string | null
  icon_small: string | null
}

type TgLink = {
  chat_id: number
  title: string | null
  username: string | null
}

type MasterplanRow = {
  id: string
  code: string
  name_ppt: string
  name_contract: string | null
  queue: string | null
  object_codes: string[]
  plot_codes: string[]
  zone_codes: string[]
  active: boolean
}

type ViewMode = 'business' | 'masterplan' | 'all'

export default function ObjectsPage() {
  const { isAdmin } = useRole()
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [tgByObject, setTgByObject] = useState<Map<string, TgLink[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [modalObject, setModalObject] = useState<ObjectRow | null | undefined>(undefined)
  // undefined = закрыт, null = создание, ObjectRow = редактирование

  const [viewMode, setViewMode] = useState<ViewMode>('business')
  const [masterplanRows, setMasterplanRows] = useState<MasterplanRow[]>([])
  const [loadingMp, setLoadingMp] = useState(false)
  const [mpModalId, setMpModalId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const query = supabase
      .from('objects')
      .select('id,code,current_name,contractor,aliases,active,color,icon,icon_small')
      .order('code')
    if (!showInactive) query.eq('active', true)
    const { data } = await query
    setObjects(data ?? [])

    // Подмешиваем Telegram-привязки одной выборкой
    const { data: tgRows } = await supabase
      .from('tg_chats')
      .select('chat_id,title,username,object_id')
      .not('object_id', 'is', null)
    const map = new Map<string, TgLink[]>()
    for (const r of (tgRows ?? []) as Array<TgLink & { object_id: string }>) {
      const list = map.get(r.object_id) ?? []
      list.push({ chat_id: r.chat_id, title: r.title, username: r.username })
      map.set(r.object_id, list)
    }
    setTgByObject(map)
    setLoading(false)
  }

  async function loadMasterplan() {
    if (viewMode === 'business') { setMasterplanRows([]); return }
    setLoadingMp(true)
    try {
      const r = await fetch(`/api/masterplan-objects${showInactive ? '?include_inactive=true' : ''}`, { cache: 'no-store' })
      const j = await r.json()
      setMasterplanRows(j.items ?? [])
    } catch {
      setMasterplanRows([])
    } finally {
      setLoadingMp(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { load() }, [showInactive])
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { loadMasterplan() }, [viewMode, showInactive])

  const showBusinessTable = viewMode === 'business' || viewMode === 'all'
  const showMasterplanTable = viewMode === 'masterplan' || viewMode === 'all'

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold text-gray-900">Объекты</h1>
          <div className="flex items-center gap-1 border border-gray-200 rounded-md bg-white p-0.5">
            {([
              ['business',   'Бизнес-объекты'],
              ['masterplan', 'Мастерплан'],
              ['all',        'Все'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setViewMode(id)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                  viewMode === id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
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
          {isAdmin && showBusinessTable && (
            <button
              onClick={() => setModalObject(null)}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              + Новый объект
            </button>
          )}
        </div>
      </div>

      {/* ─── Таблица бизнес-объектов ─────────────────────────────── */}
      {showBusinessTable && (
        loading ? (
          <p className="text-gray-400 text-sm">Загрузка…</p>
        ) : objects.length === 0 ? (
          <p className="text-gray-400 text-sm py-12 text-center">
            Объектов пока нет.{isAdmin ? ' Нажмите «+ Новый объект».' : ''}
          </p>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {viewMode === 'all' && (
              <div className="px-4 py-2 bg-blue-50 border-b border-blue-200 text-xs font-semibold text-blue-800 uppercase tracking-wide">
                Бизнес-объекты ({objects.length})
              </div>
            )}
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
                    <td className="px-4 py-3 font-mono text-gray-700">
                      <button
                        type="button"
                        onClick={() => isAdmin && setModalObject(obj)}
                        disabled={!isAdmin}
                        className="inline-flex items-center gap-1 border-l-2 pl-2 enabled:hover:text-blue-700 disabled:cursor-default text-left"
                        style={{ borderLeftColor: obj.color ?? '#cbd5e1' }}
                        title={isAdmin ? 'Открыть карточку объекта' : undefined}
                      >
                        {obj.icon_small
                          ? <img src={obj.icon_small} alt="" className="w-5 h-5 object-contain" />
                          : obj.icon && (obj.icon.startsWith('data:image/') || /^https?:\/\//.test(obj.icon)
                            ? <img src={obj.icon} alt="" className="w-5 h-5 object-contain" />
                            : <span className="text-base" aria-hidden>{obj.icon}</span>)}
                        <span className={isAdmin ? 'hover:underline' : ''}>{obj.code}</span>
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-900">
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => setModalObject(obj)}
                          className="hover:text-blue-700 hover:underline text-left"
                        >
                          {obj.current_name}
                        </button>
                      ) : (
                        <span>{obj.current_name}</span>
                      )}
                      {obj.aliases?.length > 0 && (
                        <span className="ml-2 text-xs text-gray-400">({obj.aliases.join(', ')})</span>
                      )}
                      {(tgByObject.get(obj.id) ?? []).map(tg => (
                        <span
                          key={tg.chat_id}
                          title={`chat_id ${tg.chat_id}`}
                          className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 bg-sky-100 text-sky-800 text-xs rounded"
                        >
                          💬 {tg.title ?? '(без названия)'}
                          {tg.username && <span className="text-sky-600">@{tg.username}</span>}
                        </span>
                      ))}
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
        )
      )}

      {/* ─── Таблица мастерплан-объектов ─────────────────────────── */}
      {showMasterplanTable && (
        <div className={`bg-white border border-gray-200 rounded-lg overflow-hidden ${viewMode === 'all' ? 'mt-6' : ''}`}>
          {viewMode === 'all' && (
            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs font-semibold text-amber-800 uppercase tracking-wide">
              Объекты мастерплана ({masterplanRows.length})
            </div>
          )}
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Код</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Оч.</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Наименование</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Зона</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Участки</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase" title="Бизнес-объект ЗПР, связанный с этим объектом мастерплана. Пусто = не передан в проектирование.">Бизнес-объект ЗПР</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loadingMp ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">Загрузка…</td></tr>
              ) : masterplanRows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">Объектов мастерплана нет</td></tr>
              ) : masterplanRows.map(r => (
                <tr
                  key={r.id}
                  className={`hover:bg-gray-50 cursor-pointer ${!r.active ? 'opacity-50' : ''}`}
                  onClick={() => setMpModalId(r.id)}
                >
                  <td className="px-4 py-3 font-mono text-gray-700 hover:text-blue-700">{r.code}</td>
                  <td className="px-4 py-3">
                    {r.queue
                      ? <span className="text-[11px] px-2 py-0.5 bg-amber-100 text-amber-800 rounded font-medium">{r.queue}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-900 truncate max-w-xs">
                    {r.name_contract ?? r.name_ppt}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 font-mono">
                    {r.zone_codes.length > 0 ? r.zone_codes.join(', ') : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 font-mono max-w-[180px] truncate" title={r.plot_codes.join(', ')}>
                    {r.plot_codes.length > 0 ? r.plot_codes.join(', ') : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.object_codes.length > 0
                      ? <span className="font-mono text-blue-700">{r.object_codes.join(', ')}</span>
                      : <span className="text-gray-400 italic" title="Не передан в проектирование. Нет связи в masterplan_object_objects.">не передан в проектирование</span>}
                  </td>
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

      <MasterplanObjectModal
        open={mpModalId !== null}
        objectId={mpModalId}
        onClose={() => setMpModalId(null)}
        onSaved={loadMasterplan}
      />
    </div>
  )
}
