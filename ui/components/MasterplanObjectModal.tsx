'use client'

/**
 * MasterplanObjectModal — карточка объекта мастерплана (`masterplan_objects`).
 *
 * Три вкладки:
 *   • Основное   — code, name_ppt, name_contract, queue (editable)
 *   • Связи      — objects/plots/functional_objects (read-only список)
 *   • Нагрузки   — метрики из v_masterplan_objects_full + GET /metrics для подробностей
 *
 * Данные:
 *   GET  /api/masterplan-objects/[id]              — паспорт + актуальные метрики (jsonb)
 *   GET  /api/masterplan-objects/[id]/metrics      — long-формат с историей и документами
 *   PATCH /api/masterplan-objects/[id]             — правка name_*, queue, namespace add/remove_*
 *
 * Решения архитектуры — см. WIKI 33_Сущность_Объект_Мастерплана.md
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import PlotsTab from './PlotsTab'

type TabId = 'main' | 'plots' | 'metrics'

type PmtOksCandidate = {
  zone_code: string
  object_name: string
  queue: string | null
  etazh_max: number | null
  status_code: string | null
  value_code: string | null
}

type MasterplanObject = {
  id: string
  code: string
  name_ppt: string
  name_contract: string | null
  queue: string | null
  object_codes: string[]
  plot_codes: string[]
  zone_codes: string[]
  metrics: Record<string, { value_num: number | null; value_text: string | null; unit: string | null; source: string; valid_from: string }>
  pmt_oks_candidates: PmtOksCandidate[]
  active: boolean
}

type MetricRow = {
  id: string
  metric_code: string
  metric_label?: string
  metric_category?: string
  source: string
  source_document_id: string | null
  value_num: number | null
  value_text: string | null
  unit: string | null
  valid_from: string
  valid_to: string | null
  note: string | null
  documents: { title: string; version: string | null } | null
}

const CATEGORY_LABEL: Record<string, string> = {
  capacity: 'Ёмкость',
  area:     'Площадь',
  volume:   'Объём',
  load:     'Нагрузка',
  attr:     'Атрибут',
}

const CATEGORY_ORDER = ['capacity', 'area', 'volume', 'load', 'attr']

const QUEUE_VALUES = ['1', '2', '1-2'] as const

type Props = {
  open: boolean
  objectId: string | null     // null = модалка закрыта
  onClose: () => void
  onSaved?: () => void
}

export default function MasterplanObjectModal({ open, objectId, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<TabId>('main')
  const [obj, setObj] = useState<MasterplanObject | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // editable form
  const [namePpt, setNamePpt] = useState('')
  const [nameContract, setNameContract] = useState('')
  const [queue, setQueue] = useState<string>('')

  const [metrics, setMetrics] = useState<MetricRow[]>([])
  const [loadingMetrics, setLoadingMetrics] = useState(false)

  // ─── Загрузка ───────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!objectId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/masterplan-objects/${objectId}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      const mo: MasterplanObject = json.masterplan_object
      setObj(mo)
      setNamePpt(mo.name_ppt ?? '')
      setNameContract(mo.name_contract ?? '')
      setQueue(mo.queue ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [objectId])

  useEffect(() => {
    if (!open || !objectId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab('main')
    load()
  }, [open, objectId, load])

  // Метрики (long-формат с историей документа) — подгружаем по запросу вкладки
  useEffect(() => {
    if (!open || !objectId || tab !== 'metrics') return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingMetrics(true)
    fetch(`/api/masterplan-objects/${objectId}/metrics`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => setMetrics(j.items ?? []))
      .catch(e => setError(e instanceof Error ? e.message : 'Ошибка метрик'))
      .finally(() => setLoadingMetrics(false))
  }, [open, objectId, tab])

  // Группировка метрик по category — ДО early return (правила React Hooks)
  const metricsByCategory = useMemo(() => {
    const groups: Record<string, MetricRow[]> = {}
    for (const m of metrics) {
      const cat = m.metric_category ?? 'other'
      ;(groups[cat] ??= []).push(m)
    }
    return CATEGORY_ORDER
      .filter(c => groups[c])
      .map(c => [c, groups[c]] as const)
      .concat(Object.entries(groups).filter(([c]) => !CATEGORY_ORDER.includes(c)))
  }, [metrics])

  if (!open || !objectId) return null

  async function save() {
    if (!obj) return
    setSaving(true); setError(null)
    try {
      const body: Record<string, string | null> = {}
      if (namePpt !== obj.name_ppt) body.name_ppt = namePpt
      if (nameContract !== (obj.name_contract ?? '')) body.name_contract = nameContract || null
      if (queue !== (obj.queue ?? '')) body.queue = queue || null
      if (Object.keys(body).length === 0) {
        onClose(); return
      }
      const r = await fetch(`/api/masterplan-objects/${obj.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
      onSaved?.(); onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  // На вкладке «Участки и ОКС» модалка расширяется до 6xl (как в ObjectModal)
  const modalWidthClass = tab === 'plots' ? 'max-w-6xl' : 'max-w-4xl'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className={`bg-white rounded-xl shadow-xl w-full ${modalWidthClass} p-6 max-h-[95vh] overflow-y-auto`}>
        <div className="flex items-start justify-between mb-4 gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
              {obj ? `Мастерплан-объект ${obj.code}` : 'Объект мастерплана'}
              {obj?.queue && (
                <span className="text-[11px] px-2 py-0.5 bg-amber-100 text-amber-800 rounded">
                  очередь {obj.queue}
                </span>
              )}
            </h2>
            {obj?.name_contract && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{obj.name_contract}</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">✕</button>
        </div>

        {/* ── Вкладки ───────────────────────────────────────────────── */}
        <div className="flex gap-1 mb-4 border-b border-gray-200">
          {[
            { id: 'main' as const, label: 'Основное' },
            { id: 'plots' as const, label: 'Участки и ОКС' },
            { id: 'metrics' as const, label: 'Нагрузки' },
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading && <p className="text-sm text-gray-400">Загрузка…</p>}
        {error && <p className="text-sm text-red-500 mb-2">{error}</p>}

        {obj && !loading && tab === 'main' && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Код</label>
                <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm font-mono text-gray-900">
                  {obj.code}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Очередь</label>
                <select
                  value={queue}
                  onChange={e => setQueue(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">— не указана —</option>
                  {QUEUE_VALUES.map(q => <option key={q} value={q}>{q}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Статус</label>
                <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm">
                  {obj.active
                    ? <span className="text-green-700">Активен</span>
                    : <span className="text-gray-500">Неактивен</span>}
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Наименование по ППТ</label>
              <input
                value={namePpt}
                onChange={e => setNamePpt(e.target.value)}
                placeholder="Отель 4*"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Сейчас = код, т.к. кириллица из PDF не парсится — дозаполните вручную или используйте подсказку из ПМТ ниже.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Наименование по договорам</label>
              <input
                value={nameContract}
                onChange={e => setNameContract(e.target.value)}
                placeholder="Семейный отель 4* Residence"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* ─── Подсказки из ПМТ Тома 3.2 (стейджинг pmt_oks) ─────────── */}
            {obj.pmt_oks_candidates && obj.pmt_oks_candidates.length > 0 && (
              <div className="border border-amber-200 bg-amber-50/40 rounded-md p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Подсказки из ПМТ</span>
                  <span className="text-[10px] text-amber-700">
                    кириллица из Тома 3.2 ПМТ, сматченная по зоне
                  </span>
                </div>
                <div className="space-y-1.5">
                  {obj.pmt_oks_candidates.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs bg-white border border-amber-100 rounded px-2 py-1.5">
                      <span className="font-mono text-amber-800 font-semibold shrink-0">{c.zone_code}</span>
                      <span className="text-gray-900 flex-1 truncate" title={c.object_name}>{c.object_name}</span>
                      {c.queue && <span className="text-[10px] text-gray-500 shrink-0">оч. {c.queue}</span>}
                      {c.etazh_max && <span className="text-[10px] text-gray-500 shrink-0">{c.etazh_max} эт.</span>}
                      {c.status_code && <span className="text-[10px] px-1 py-0.5 bg-gray-100 text-gray-600 rounded shrink-0" title="Статус ОКС">{c.status_code}</span>}
                      <div className="flex gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => setNamePpt(c.object_name)}
                          className="text-[10px] px-2 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                          title="Скопировать в поле «Наименование по ППТ»"
                        >
                          → ППТ
                        </button>
                        <button
                          type="button"
                          onClick={() => setNameContract(c.object_name)}
                          className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                          title="Скопировать в поле «Наименование по договорам»"
                        >
                          → договор
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                Отмена
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        )}

        {obj && !loading && tab === 'plots' && (
          <PlotsTab
            ownerType="masterplan"
            ownerId={obj.id}
            ownerCode={obj.code}
            ownerColor={null}
            active={true}
          />
        )}

        {obj && !loading && tab === 'metrics' && (
          <div className="space-y-3">
            {loadingMetrics && <p className="text-sm text-gray-400">Загрузка метрик…</p>}
            {!loadingMetrics && metrics.length === 0 && (
              <p className="text-sm text-gray-400">Метрики не загружены.</p>
            )}
            {metricsByCategory.map(([cat, rows]) => (
              <div key={cat} className="border border-gray-200 rounded-md overflow-hidden">
                <div className="px-3 py-1.5 bg-gray-50 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  {CATEGORY_LABEL[cat] ?? cat}
                </div>
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs text-gray-500">
                      <th className="px-3 py-1.5 text-left font-medium">Показатель</th>
                      <th className="px-3 py-1.5 text-left font-medium">Источник</th>
                      <th className="px-3 py-1.5 text-right font-medium">Значение</th>
                      <th className="px-3 py-1.5 text-left font-medium">Ед.</th>
                      <th className="px-3 py-1.5 text-left font-medium">Документ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map(m => (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 text-gray-700">{m.metric_label ?? m.metric_code}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded font-mono ${SOURCE_STYLE[m.source] ?? 'bg-gray-100 text-gray-600'}`}>
                            {m.source}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-900">
                          {m.value_num !== null
                            ? Number(m.value_num).toLocaleString('ru', { maximumFractionDigits: 2 })
                            : m.value_text}
                        </td>
                        <td className="px-3 py-1.5 text-gray-500">{m.unit ?? '—'}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-500 truncate max-w-[200px]" title={m.documents?.title ?? ''}>
                          {m.documents?.title ?? '—'}
                          {m.documents?.version && <span className="text-gray-400 ml-1">({m.documents.version})</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const SOURCE_STYLE: Record<string, string> = {
  ppt:     'bg-blue-100 text-blue-700',
  calc:    'bg-green-100 text-green-700',
  tu:      'bg-amber-100 text-amber-700',
  project: 'bg-purple-100 text-purple-700',
  fact:    'bg-emerald-100 text-emerald-700',
}

