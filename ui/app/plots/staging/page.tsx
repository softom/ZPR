'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'

type TableInfo = {
  name: string
  label: string
  category: string
  source: string
  expectedRows?: number
  rowCount: number | null
  error: string | null
}

type TablesResponse = {
  categories: Record<string, string>
  tables: TableInfo[]
}

type RowsResponse = {
  table: string
  meta: TableInfo | null
  limit: number
  offset: number
  rowCount: number
  rows: Record<string, unknown>[]
}

const PAGE_SIZE = 100

export default function PmtStagingPage() {
  const [tables, setTables] = useState<TableInfo[]>([])
  const [categories, setCategories] = useState<Record<string, string>>({})
  const [tablesLoading, setTablesLoading] = useState(true)
  const [tablesError, setTablesError] = useState<string | null>(null)

  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [page, setPage] = useState(0)
  const [orderCol, setOrderCol] = useState<string | null>(null)
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc')
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)

  const loadTables = useCallback(async () => {
    setTablesLoading(true)
    setTablesError(null)
    try {
      const res = await fetch('/api/pmt/tables')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: TablesResponse = await res.json()
      setTables(data.tables)
      setCategories(data.categories)
    } catch (e) {
      setTablesError(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setTablesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTables()
  }, [loadTables])

  const loadRows = useCallback(async (table: string, pageIdx: number, order: string | null, dir: 'asc' | 'desc') => {
    setRowsLoading(true)
    setRowsError(null)
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(pageIdx * PAGE_SIZE),
      })
      if (order) {
        params.set('order', order)
        params.set('dir', dir)
      }
      const res = await fetch(`/api/pmt/${table}?${params}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const data: RowsResponse = await res.json()
      setRows(data.rows)
      setTotalRows(data.rowCount)
    } catch (e) {
      setRowsError(e instanceof Error ? e.message : 'Ошибка загрузки')
      setRows([])
      setTotalRows(0)
    } finally {
      setRowsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedTable) return
    loadRows(selectedTable, page, orderCol, orderDir)
  }, [selectedTable, page, orderCol, orderDir, loadRows])

  function selectTable(name: string) {
    setSelectedTable(name)
    setPage(0)
    setOrderCol(null)
    setOrderDir('asc')
    setRows([])
    setTotalRows(0)
  }

  function toggleSort(col: string) {
    if (orderCol === col) {
      setOrderDir(orderDir === 'asc' ? 'desc' : 'asc')
    } else {
      setOrderCol(col)
      setOrderDir('asc')
    }
    setPage(0)
  }

  const grouped = useMemo(() => {
    const map: Record<string, TableInfo[]> = {}
    for (const t of tables) {
      if (!map[t.category]) map[t.category] = []
      map[t.category].push(t)
    }
    return map
  }, [tables])

  const totalRowsAcross = useMemo(
    () => tables.reduce((acc, t) => acc + (t.rowCount ?? 0), 0),
    [tables]
  )

  const selectedMeta = useMemo(
    () => tables.find((t) => t.name === selectedTable) ?? null,
    [tables, selectedTable]
  )

  const columns = useMemo(() => (rows.length > 0 ? Object.keys(rows[0]) : []), [rows])

  const pageStart = page * PAGE_SIZE
  const pageEnd = Math.min(pageStart + PAGE_SIZE, totalRows)
  const totalPages = totalRows > 0 ? Math.ceil(totalRows / PAGE_SIZE) : 0

  return (
    <div className="flex h-full">
      {/* Список таблиц */}
      <aside className="w-72 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto">
        <div className="px-4 py-3 border-b border-gray-200 bg-white">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Стейджинг ПМТ
          </p>
          <p className="text-sm text-gray-700 mt-0.5">
            {tables.length} таблиц · {totalRowsAcross.toLocaleString('ru')} строк
          </p>
        </div>

        {tablesLoading && (
          <p className="px-4 py-3 text-sm text-gray-400">Загрузка списка…</p>
        )}
        {tablesError && (
          <p className="px-4 py-3 text-sm text-red-600">Ошибка: {tablesError}</p>
        )}

        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="py-2">
            <p className="px-4 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {categories[cat] ?? cat}
            </p>
            <ul>
              {items.map((t) => {
                const isEmpty = (t.rowCount ?? 0) === 0
                const isShort = t.expectedRows != null && (t.rowCount ?? 0) > 0 && t.rowCount! < t.expectedRows
                const isComplete = t.expectedRows != null && t.rowCount === t.expectedRows
                const active = selectedTable === t.name

                return (
                  <li key={t.name}>
                    <button
                      onClick={() => selectTable(t.name)}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-100 border-l-2 transition-colors ${
                        active
                          ? 'bg-blue-50 border-blue-500'
                          : 'border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`font-mono text-xs ${active ? 'text-blue-700' : 'text-gray-700'}`}>
                          {t.name}
                        </span>
                        <span
                          className={`text-xs font-medium tabular-nums ${
                            isEmpty
                              ? 'text-gray-300'
                              : isComplete
                              ? 'text-green-600'
                              : isShort
                              ? 'text-amber-600'
                              : 'text-gray-600'
                          }`}
                          title={
                            t.expectedRows != null
                              ? `Ожидается ${t.expectedRows.toLocaleString('ru')} строк`
                              : ''
                          }
                        >
                          {t.error
                            ? '⚠'
                            : (t.rowCount ?? 0).toLocaleString('ru')}
                          {t.expectedRows != null && (
                            <span className="text-gray-300 ml-0.5">/{t.expectedRows.toLocaleString('ru')}</span>
                          )}
                        </span>
                      </div>
                      <div className={`text-xs mt-0.5 truncate ${active ? 'text-blue-600' : 'text-gray-500'}`}>
                        {t.label}
                      </div>
                      <div className="text-xs mt-0.5 text-gray-400">
                        {t.source}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </aside>

      {/* Просмотрщик содержимого */}
      <section className="flex-1 flex flex-col overflow-hidden">
        {!selectedTable ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <p className="text-lg">Выберите таблицу слева</p>
              <p className="text-sm mt-2">
                Стейджинг ПМТ из{' '}
                <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">
                  D:\Dropbox\ЗПР\ИРД\02_ППТ_ПМТ_КУРОРТ_ЗПР\Таблицы\
                </code>
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="px-6 py-3 border-b border-gray-200 bg-white">
              <div className="flex items-baseline justify-between">
                <div>
                  <h2 className="font-mono text-sm text-gray-800">{selectedTable}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{selectedMeta?.label}</p>
                </div>
                <div className="text-sm text-gray-600 tabular-nums">
                  {totalRows > 0 ? (
                    <>
                      Строки {pageStart + 1}–{pageEnd} из {totalRows.toLocaleString('ru')}
                    </>
                  ) : (
                    'Нет данных'
                  )}
                </div>
              </div>
              {totalPages > 1 && (
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0 || rowsLoading}
                    className="px-2 py-1 border border-gray-200 rounded text-xs disabled:opacity-40 hover:bg-gray-50"
                  >
                    ← Назад
                  </button>
                  <span className="text-xs text-gray-500">
                    Страница {page + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1 || rowsLoading}
                    className="px-2 py-1 border border-gray-200 rounded text-xs disabled:opacity-40 hover:bg-gray-50"
                  >
                    Вперёд →
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-auto">
              {rowsLoading && (
                <p className="px-6 py-4 text-sm text-gray-400">Загрузка…</p>
              )}
              {rowsError && (
                <p className="px-6 py-4 text-sm text-red-600">Ошибка: {rowsError}</p>
              )}
              {!rowsLoading && !rowsError && rows.length === 0 && (
                <div className="px-6 py-10 text-center text-gray-400">
                  <p className="text-sm">
                    Таблица пуста.{' '}
                    {selectedMeta?.expectedRows != null && (
                      <>
                        Ожидается ~{selectedMeta.expectedRows.toLocaleString('ru')} строк после заливки CSV
                        (см.{' '}
                        <code className="text-xs">32_План_импорта_ПМТ.md</code>{' '}
                        Фаза 0.3).
                      </>
                    )}
                  </p>
                </div>
              )}
              {rows.length > 0 && (
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      {columns.map((col) => (
                        <th
                          key={col}
                          onClick={() => toggleSort(col)}
                          className="px-3 py-2 text-left font-semibold text-gray-600 cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap"
                        >
                          {col}
                          {orderCol === col && (
                            <span className="ml-1 text-blue-500">
                              {orderDir === 'asc' ? '↑' : '↓'}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                        {columns.map((col) => {
                          const v = row[col]
                          const isNull = v === null || v === undefined
                          const display =
                            isNull
                              ? '—'
                              : typeof v === 'object'
                              ? JSON.stringify(v)
                              : String(v)
                          const truncated = display.length > 200 ? display.slice(0, 200) + '…' : display
                          return (
                            <td
                              key={col}
                              className={`px-3 py-1.5 align-top ${
                                isNull ? 'text-gray-300' : 'text-gray-700'
                              } whitespace-nowrap font-mono`}
                              title={display.length > 200 ? display : undefined}
                            >
                              {truncated}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
