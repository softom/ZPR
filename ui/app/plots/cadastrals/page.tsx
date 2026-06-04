'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'

/* ── Ownership labels ─────────────────────────────────────────── */
const OWNERSHIP_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  private:       { label: 'Частная',        color: 'text-red-700',    bg: 'bg-red-50' },
  municipal:     { label: 'Муниципальная',  color: 'text-blue-700',   bg: 'bg-blue-50' },
  state_subject: { label: 'Субъект РФ',     color: 'text-green-700',  bg: 'bg-green-50' },
  state_federal: { label: 'Федеральная',    color: 'text-purple-700', bg: 'bg-purple-50' },
  mixed:         { label: 'Совместная',     color: 'text-amber-700',  bg: 'bg-amber-50' },
  unknown:       { label: 'Не указана',     color: 'text-gray-500',   bg: 'bg-gray-100' },
}

type Cadastral = {
  id: string
  cadastral_number: string
  address: string | null
  category: string | null
  vri: string | null
  ownership: string
  ownership_raw: string | null
  area_m2: number | null
  status: string | null
  is_seizure: boolean
  seizure_area_m2: number | null
  seizure_dpt_no: string | null
  seizure_note: string | null
  seizure_building_kn: string | null
  vri_changes: Array<{
    stage: number
    category_old: string
    category_new: string
    vri_old: string
    vri_new: string
  }> | null
  linked_plots_count: number
  linked_plot_codes: string[]
  has_geom?: boolean
}

type GeomStats = {
  total: number
  with_geom: number
  without_geom: number
}

type UploadResult = {
  total: number
  ok: number
  failed: number
  results: Array<{ kn: string; status: string; error?: string }>
}

type FetchLogEntry = {
  kn: string
  status: 'pending' | 'fetching' | 'ok' | 'not_found_pkk' | 'no_geometry' | 'not_found_db' | 'error' | 'skipped'
  polygons?: number
  error?: string
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pending:        { text: 'ожидание',    color: 'text-gray-400' },
  fetching:       { text: 'запрос...',   color: 'text-blue-500' },
  ok:             { text: 'загружен',    color: 'text-green-600' },
  not_found_pkk:  { text: 'нет в ПКК',  color: 'text-amber-500' },
  no_geometry:    { text: 'нет контура', color: 'text-amber-500' },
  not_found_db:   { text: 'нет в БД',   color: 'text-red-500' },
  error:          { text: 'ошибка',      color: 'text-red-500' },
  skipped:        { text: 'пропущен',    color: 'text-gray-400' },
}

export default function CadastralsPage() {
  const [data, setData] = useState<Cadastral[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [seizureFilter, setSeizureFilter] = useState('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  // Geometry panel state
  const [geomStats, setGeomStats] = useState<GeomStats | null>(null)
  const [showGeomPanel, setShowGeomPanel] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // PKK live fetch state
  const [fetchRunning, setFetchRunning] = useState(false)
  const [fetchLog, setFetchLog] = useState<FetchLogEntry[]>([])
  const [fetchAbort, setFetchAbort] = useState(false)
  const fetchAbortRef = useRef(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (ownerFilter !== 'all') params.set('ownership', ownerFilter)
    if (seizureFilter !== 'all') params.set('seizure', seizureFilter)
    if (search.trim()) params.set('search', search.trim())
    const res = await fetch(`/api/cadastrals?${params}`)
    const json = await res.json()
    setData(Array.isArray(json) ? json : [])
    setLoading(false)
  }, [ownerFilter, seizureFilter, search])

  const fetchGeomStats = useCallback(async () => {
    try {
      const res = await fetch('/api/cadastrals/geometry')
      const json = await res.json()
      setGeomStats(json)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchData()
    fetchGeomStats()
  }, [fetchData, fetchGeomStats])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    setUploadResult(null)

    try {
      const text = await file.text()
      const json = JSON.parse(text)

      const res = await fetch('/api/cadastrals/geometry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      })
      const result = await res.json()
      setUploadResult(result)
      // Обновить статистику и данные
      fetchGeomStats()
      fetchData()
    } catch (err) {
      setUploadResult({ total: 0, ok: 0, failed: 1, results: [{ kn: '-', status: 'error', error: String(err) }] })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [fetchLog])

  const handleFetchFromPKK = async () => {
    // Получить список КН без геометрии
    const withoutGeom = data.filter(d => !d.has_geom)
    if (withoutGeom.length === 0) return

    setFetchRunning(true)
    fetchAbortRef.current = false
    setFetchAbort(false)

    const log: FetchLogEntry[] = withoutGeom.map(d => ({
      kn: d.cadastral_number,
      status: 'pending' as const,
    }))
    setFetchLog([...log])

    let okCount = 0
    let errCount = 0

    for (let i = 0; i < log.length; i++) {
      if (fetchAbortRef.current) {
        // Пометить оставшиеся как skipped
        for (let j = i; j < log.length; j++) {
          log[j] = { ...log[j], status: 'skipped' }
        }
        setFetchLog([...log])
        break
      }

      log[i] = { ...log[i], status: 'fetching' }
      setFetchLog([...log])

      try {
        const res = await fetch('/api/cadastrals/geometry/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cadastral_number: log[i].kn }),
        })
        const result = await res.json()

        log[i] = {
          kn: log[i].kn,
          status: result.status,
          polygons: result.polygons,
          error: result.error,
        }

        if (result.status === 'ok') okCount++
        else errCount++
      } catch (err) {
        log[i] = { kn: log[i].kn, status: 'error', error: String(err) }
        errCount++
      }

      setFetchLog([...log])

      // Задержка 1.5с между запросами (rate limit)
      if (i < log.length - 1 && !fetchAbortRef.current) {
        await new Promise(r => setTimeout(r, 1500))
      }
    }

    setFetchRunning(false)
    fetchGeomStats()
    fetchData()
  }

  const handleStopFetch = () => {
    fetchAbortRef.current = true
    setFetchAbort(true)
  }

  /* ── Stats ──────────────────────────────────────────────────── */
  const stats = useMemo(() => {
    const total = data.length
    const seizure = data.filter(d => d.is_seizure).length
    const withPlots = data.filter(d => d.linked_plots_count > 0).length
    const withVri = data.filter(d => d.vri_changes && d.vri_changes.length > 0).length
    const totalArea = data.reduce((s, d) => s + (d.area_m2 || 0), 0)
    const ownershipCounts: Record<string, number> = {}
    data.forEach(d => {
      ownershipCounts[d.ownership] = (ownershipCounts[d.ownership] || 0) + 1
    })
    return { total, seizure, withPlots, withVri, totalArea, ownershipCounts }
  }, [data])

  const fmtArea = (m2: number | null) => {
    if (!m2) return '—'
    if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} га`
    return `${m2.toLocaleString('ru-RU')} м²`
  }

  return (
    <div className="p-8 space-y-6 overflow-auto h-full">
      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <StatCard label="Всего КН" value={stats.total} />
        <StatCard
          label="Под изъятие"
          value={stats.seizure}
          accent="text-red-600"
        />
        <StatCard label="Со сменой ВРИ" value={stats.withVri} accent="text-amber-600" />
        <StatCard label="Привязаны к ЗУ" value={stats.withPlots} accent="text-green-600" />
        <StatCard label="Общая площадь" value={fmtArea(stats.totalArea)} />
        {geomStats && (
          <div
            className="bg-white border rounded-lg px-4 py-3 cursor-pointer hover:border-blue-300 transition-colors"
            onClick={() => setShowGeomPanel(!showGeomPanel)}
            title="Нажмите для загрузки геометрии"
          >
            <div className="text-xs text-gray-500">Геометрия</div>
            <div className="text-lg font-semibold mt-0.5">
              <span className={geomStats.with_geom > 0 ? 'text-green-600' : 'text-gray-400'}>
                {geomStats.with_geom}
              </span>
              <span className="text-gray-300 text-sm font-normal"> / {geomStats.total}</span>
            </div>
          </div>
        )}
      </div>

      {/* Geometry panel */}
      {showGeomPanel && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-blue-800">Геометрия кадастров (контуры ПКК)</h3>
              <p className="text-xs text-blue-600 mt-0.5">
                {geomStats
                  ? `${geomStats.with_geom} из ${geomStats.total} имеют контур. Без контура: ${geomStats.without_geom}.`
                  : 'Загрузка...'}
              </p>
            </div>
            <button
              onClick={() => { setShowGeomPanel(false); setUploadResult(null); setFetchLog([]) }}
              className="text-blue-400 hover:text-blue-600 text-lg leading-none"
            >
              ✕
            </button>
          </div>

          {/* Actions row */}
          <div className="flex items-center gap-3 flex-wrap">
            {!fetchRunning ? (
              <button
                onClick={handleFetchFromPKK}
                disabled={uploading || !geomStats || geomStats.without_geom === 0}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Загрузить из ПКК ({geomStats?.without_geom ?? '...'} шт)
              </button>
            ) : (
              <button
                onClick={handleStopFetch}
                className="px-4 py-2 bg-red-500 text-white text-sm rounded-md hover:bg-red-600 transition-colors"
              >
                Остановить
              </button>
            )}

            <div className="h-5 border-l border-blue-200" />

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.geojson"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || fetchRunning}
              className="px-4 py-2 bg-white text-blue-700 border border-blue-300 text-sm rounded-md hover:bg-blue-100 disabled:opacity-50 transition-colors"
            >
              {uploading ? 'Загрузка...' : 'Из файла JSON'}
            </button>
          </div>

          {/* Upload result */}
          {uploadResult && (
            <div className={`rounded-md p-3 text-sm ${
              uploadResult.failed === 0 ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
            }`}>
              <div className="font-medium">
                Файл: {uploadResult.ok} записано, {uploadResult.failed} ошибок (из {uploadResult.total})
              </div>
              {uploadResult.results.filter(r => r.status !== 'ok').length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {uploadResult.results.filter(r => r.status !== 'ok').map((r, i) => (
                    <div key={i} className="text-xs">
                      {r.kn}: {r.status} {r.error ? ` — ${r.error}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* PKK fetch live log */}
          {fetchLog.length > 0 && (
            <div className="space-y-2">
              {/* Summary bar */}
              <div className="flex items-center gap-4 text-xs">
                <span className="text-green-600 font-medium">
                  {fetchLog.filter(l => l.status === 'ok').length} загружено
                </span>
                <span className="text-amber-500">
                  {fetchLog.filter(l => l.status === 'not_found_pkk' || l.status === 'no_geometry').length} не найдено
                </span>
                <span className="text-red-500">
                  {fetchLog.filter(l => l.status === 'error').length} ошибок
                </span>
                {fetchRunning && (
                  <span className="text-blue-500">
                    {fetchLog.filter(l => l.status === 'pending').length} в очереди
                  </span>
                )}
                {/* Progress bar */}
                <div className="flex-1 h-1.5 bg-blue-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{
                      width: `${Math.round(
                        (fetchLog.filter(l => l.status !== 'pending' && l.status !== 'fetching').length / fetchLog.length) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Log scroll area */}
              <div className="max-h-52 overflow-y-auto bg-white rounded-md border border-blue-100 divide-y divide-blue-50">
                {fetchLog.map((entry, i) => {
                  const sl = STATUS_LABEL[entry.status] || STATUS_LABEL.error
                  return (
                    <div
                      key={i}
                      className={`px-3 py-1.5 flex items-center gap-3 text-xs ${
                        entry.status === 'fetching' ? 'bg-blue-50' : ''
                      }`}
                    >
                      <span className="text-gray-400 w-8 text-right tabular-nums">{i + 1}</span>
                      <span className="font-mono text-gray-700 w-44">{entry.kn}</span>
                      <span className={`font-medium ${sl.color}`}>
                        {entry.status === 'fetching' && (
                          <span className="inline-block animate-pulse mr-1">●</span>
                        )}
                        {sl.text}
                        {entry.polygons ? ` (${entry.polygons} пол.)` : ''}
                      </span>
                      {entry.error && (
                        <span className="text-red-400 truncate flex-1" title={entry.error}>
                          {entry.error}
                        </span>
                      )}
                    </div>
                  )
                })}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ownership distribution */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(stats.ownershipCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([key, count]) => {
            const o = OWNERSHIP_LABELS[key] || OWNERSHIP_LABELS.unknown
            return (
              <button
                key={key}
                onClick={() => setOwnerFilter(ownerFilter === key ? 'all' : key)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  ownerFilter === key
                    ? `${o.bg} ${o.color} ring-2 ring-current`
                    : `${o.bg} ${o.color} opacity-80 hover:opacity-100`
                }`}
              >
                {o.label}: {count}
              </button>
            )
          })}
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder="Поиск по КН или адресу..."
          className="px-3 py-1.5 border rounded-md text-sm w-72"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          value={seizureFilter}
          onChange={e => setSeizureFilter(e.target.value)}
          className="px-3 py-1.5 border rounded-md text-sm"
        >
          <option value="all">Все участки</option>
          <option value="true">Под изъятие</option>
          <option value="false">Без изъятия</option>
        </select>
        {(ownerFilter !== 'all' || seizureFilter !== 'all' || search) && (
          <button
            onClick={() => { setOwnerFilter('all'); setSeizureFilter('all'); setSearch('') }}
            className="text-xs text-gray-500 hover:text-red-500"
          >
            Сбросить фильтры
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-gray-400 text-sm py-8 text-center">Загрузка...</div>
      ) : data.length === 0 ? (
        <div className="text-gray-400 text-sm py-8 text-center">Нет данных по фильтру</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">Кадастровый номер</th>
                <th className="px-3 py-2">Собственность</th>
                <th className="px-3 py-2 text-right">Площадь</th>
                <th className="px-3 py-2">ВРИ</th>
                <th className="px-3 py-2 text-center">Изъятие</th>
                <th className="px-3 py-2 text-center">ВРИ Δ</th>
                <th className="px-3 py-2 text-center">ЗУ</th>
                <th className="px-3 py-2 text-center" title="Геометрия из ПКК">Контур</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.map(c => {
                const isExpanded = expanded === c.id
                const o = OWNERSHIP_LABELS[c.ownership] || OWNERSHIP_LABELS.unknown
                return (
                  <CadastralRow
                    key={c.id}
                    c={c}
                    o={o}
                    isExpanded={isExpanded}
                    onToggle={() => setExpanded(isExpanded ? null : c.id)}
                    fmtArea={fmtArea}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ───────────────────────────────────────────── */

function StatCard({ label, value, accent }: {
  label: string
  value: string | number
  accent?: string
}) {
  return (
    <div className="bg-white border rounded-lg px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${accent || 'text-gray-800'}`}>
        {value}
      </div>
    </div>
  )
}

function CadastralRow({ c, o, isExpanded, onToggle, fmtArea }: {
  c: Cadastral
  o: { label: string; color: string; bg: string }
  isExpanded: boolean
  onToggle: () => void
  fmtArea: (m2: number | null) => string
}) {
  return (
    <>
      <tr
        className={`cursor-pointer hover:bg-gray-50 transition-colors ${
          isExpanded ? 'bg-blue-50/50' : ''
        }`}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-gray-400">{isExpanded ? '▼' : '▶'}</td>
        <td className="px-3 py-2 font-mono text-xs font-medium">{c.cadastral_number}</td>
        <td className="px-3 py-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${o.bg} ${o.color}`}>
            {o.label}
          </span>
        </td>
        <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
          {fmtArea(c.area_m2)}
        </td>
        <td className="px-3 py-2 text-gray-600 max-w-[200px] truncate" title={c.vri || ''}>
          {c.vri || '—'}
        </td>
        <td className="px-3 py-2 text-center">
          {c.is_seizure ? (
            <span className="text-red-500 font-semibold" title={`Изъятие: ${fmtArea(c.seizure_area_m2)}`}>
              ⚠
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {c.vri_changes && c.vri_changes.length > 0 ? (
            <span className="text-amber-500 font-semibold" title={`${c.vri_changes.length} этапов`}>
              Δ{c.vri_changes.length}
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {c.linked_plots_count > 0 ? (
            <span className="text-green-600 font-medium">{c.linked_plots_count}</span>
          ) : (
            <span className="text-gray-300">0</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {c.has_geom ? (
            <span className="text-green-500" title="Контур загружен">&#9679;</span>
          ) : (
            <span className="text-gray-300" title="Нет контура">&#9675;</span>
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={9} className="bg-gray-50/70 px-6 py-4">
            <div className="grid grid-cols-2 gap-6 text-xs">
              {/* Left column */}
              <div className="space-y-2">
                <Detail label="Адрес" value={c.address} />
                <Detail label="Категория" value={c.category} />
                <Detail label="ВРИ" value={c.vri} />
                <Detail label="Собственность (ориг.)" value={c.ownership_raw} />
                <Detail label="Статус" value={c.status} />
              </div>
              {/* Right column */}
              <div className="space-y-2">
                {c.is_seizure && (
                  <div className="bg-red-50 rounded-lg p-3 space-y-1.5">
                    <div className="text-red-700 font-semibold text-sm">Изъятие</div>
                    <Detail label="Площадь изъятия" value={fmtArea(c.seizure_area_m2)} />
                    <Detail label="Номер ДПТ" value={c.seizure_dpt_no} />
                    {c.seizure_building_kn && (
                      <Detail label="КН здания" value={c.seizure_building_kn} />
                    )}
                    <Detail label="Примечание" value={c.seizure_note} />
                  </div>
                )}
                {c.vri_changes && c.vri_changes.length > 0 && (
                  <div className="bg-amber-50 rounded-lg p-3 space-y-1.5">
                    <div className="text-amber-700 font-semibold text-sm">Смена ВРИ</div>
                    {c.vri_changes.map((v, i) => (
                      <div key={i} className="text-gray-600">
                        <span className="text-gray-400">Этап {v.stage}:</span>{' '}
                        <span className="line-through text-red-400">{v.vri_old?.slice(0, 30)}</span>
                        {' → '}
                        <span className="text-green-700">{v.vri_new?.slice(0, 30)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {c.linked_plots_count > 0 && (
                  <div className="bg-green-50 rounded-lg p-3">
                    <div className="text-green-700 font-semibold text-sm mb-1">
                      Связанные ЗУ ({c.linked_plots_count})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.linked_plot_codes.map(code => (
                        <span key={code} className="font-mono text-green-700 bg-white px-1.5 py-0.5 rounded border border-green-200">
                          {code}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span className="text-gray-400">{label}:</span>{' '}
      <span className="text-gray-700">{value || '—'}</span>
    </div>
  )
}
