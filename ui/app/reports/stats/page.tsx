'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

// Экспресс-статистика по периоду без сохранения в reports.
// Селектор: тип периода (week/month) + дата (снэпится к ПН/1-му числу).
// Навигация: ←Пред / Текущий / След→.
//
// На каждой карточке объекта — те же показатели что в /reports/[id], но
// для произвольного периода. Если отчёт за этот период уже сформирован
// (есть запись в reports) — показывается ссылка-переход.

type ContractSummary = {
  id: string
  type: string
  title: string
  doc_number: string | null
  signed_date: string | null
  customer_name: string | null
  contractor_name: string | null
  contractor_entity_id: string | null
}

type ContractorGroup = {
  contractor_entity_id: string | null
  contractor_name: string
  contracts: ContractSummary[]
  stats: { tasks_done: number; tasks_active: number; tasks_overdue: number }
}

type GlobalTotals = {
  tasks_done_unique: number
  tasks_done_pairs: number
  tasks_active_unique: number
  tasks_active_pairs: number
  tasks_overdue_unique: number
  tasks_overdue_pairs: number
  events_in_period: number
  topics_recent: number
}

type DetailsItem = {
  id: string
  code?: string
  title: string
  subtitle?: string
  object_codes?: (string | undefined)[]
  link?: string | null
}

type SectionStats = {
  object_id: string
  object_code: string
  object_name: string
  tasks_done: number
  tasks_active: number
  tasks_overdue: number
  tasks_due_next: number
  events_in_period: number
  events_next_period: number
  events_overdue: number
  topics_recent: number
  contractors: ContractorGroup[]
}

type Period = { type: 'week' | 'month'; start: string; end: string }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

function periodTitle(period: Period): { kind: string; phrase: string } {
  const start = new Date(period.start)
  const end = new Date(period.end)
  if (period.type === 'month') {
    const m = MONTHS_NOMINATIVE[start.getMonth()]
    return { kind: 'Ежемесячная', phrase: `${m} ${start.getFullYear()} года` }
  }
  const sd = start.getDate()
  const ed = end.getDate()
  const sm = MONTHS_GENITIVE[start.getMonth()]
  const em = MONTHS_GENITIVE[end.getMonth()]
  const sy = start.getFullYear()
  const ey = end.getFullYear()
  let phrase: string
  if (sy !== ey) phrase = `с ${sd} ${sm} ${sy} по ${ed} ${em} ${ey} года`
  else if (start.getMonth() !== end.getMonth()) phrase = `с ${sd} ${sm} по ${ed} ${em} ${ey} года`
  else phrase = `с ${sd} по ${ed} ${em} ${ey} года`
  return { kind: 'Еженедельная', phrase }
}

function thisMonday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() || 7
  d.setDate(d.getDate() - (day - 1))
  return d.toISOString().slice(0, 10)
}

function thisMonthFirst(): string {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

// Сдвиг даты на ±1 период (week/month) от current start
// "по 7 случаям" / "по 1 случаю" / "" (если pairs == unique)
function pluralCases(pairs: number, unique: number): string | undefined {
  if (pairs === 0) return undefined
  if (pairs === unique) return undefined
  const last = pairs % 10
  const lastTwo = pairs % 100
  let word: string
  if (lastTwo >= 11 && lastTwo <= 14) word = 'случаям'
  else if (last === 1) word = 'случаю'
  else if (last >= 2 && last <= 4) word = 'случаям'
  else word = 'случаям'
  return `по ${pairs} ${word}`
}

function shiftPeriod(currentStart: string, type: 'week' | 'month', dir: -1 | 1): string {
  const d = new Date(currentStart)
  d.setHours(0, 0, 0, 0)
  if (type === 'week') {
    d.setDate(d.getDate() + dir * 7)
  } else {
    d.setMonth(d.getMonth() + dir, 1)
  }
  return d.toISOString().slice(0, 10)
}

export default function ReportsStatsPage() {
  return (
    <Suspense fallback={<p className="text-gray-400 text-sm p-6">Загрузка…</p>}>
      <ReportsStatsPageInner />
    </Suspense>
  )
}

function ReportsStatsPageInner() {
  const router = useRouter()
  const params = useSearchParams()
  const initialType = (params.get('type') === 'month' ? 'month' : 'week') as 'week' | 'month'
  const initialStart = params.get('start') ?? (initialType === 'week' ? thisMonday() : thisMonthFirst())

  const [type, setType] = useState<'week' | 'month'>(initialType)
  const [start, setStart] = useState<string>(initialStart)
  const [period, setPeriod] = useState<Period | null>(null)
  const [stats, setStats] = useState<SectionStats[]>([])
  const [totals, setTotals] = useState<GlobalTotals | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Существующие отчёты — чтобы знать, есть ли за выбранный период сохранённый
  const [existingReportId, setExistingReportId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Popup с детализацией по нажатию на плитку
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsTitle, setDetailsTitle] = useState('')
  const [detailsItems, setDetailsItems] = useState<DetailsItem[]>([])
  const [detailsLoading, setDetailsLoading] = useState(false)
  // Для tasks_*: items = уникальные задачи; на главной плитке — пары task×object.
  // Чтобы пользователь не путался, показываем оба числа в заголовке.
  const [detailsTaskCount, setDetailsTaskCount] = useState<number | null>(null)
  const [detailsPairCount, setDetailsPairCount] = useState<number | null>(null)

  async function openDetails(category: string, title: string) {
    setDetailsTitle(title)
    setDetailsItems([])
    setDetailsTaskCount(null)
    setDetailsPairCount(null)
    setDetailsLoading(true)
    setDetailsOpen(true)
    try {
      const res = await fetch(`/api/stats/details?type=${type}&start=${start}&category=${category}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setDetailsItems(json.items || [])
      setDetailsTaskCount(typeof json.task_count === 'number' ? json.task_count : null)
      setDetailsPairCount(typeof json.pair_count === 'number' ? json.pair_count : null)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Ошибка загрузки')
      setDetailsOpen(false)
    }
    setDetailsLoading(false)
  }

  useEffect(() => {
    // Синхронизация URL
    const url = new URL(window.location.href)
    url.searchParams.set('type', type)
    url.searchParams.set('start', start)
    window.history.replaceState({}, '', url.toString())
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, start])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [statsRes, reportsRes] = await Promise.all([
        fetch(`/api/stats?type=${type}&start=${start}`).then((r) => r.json()),
        fetch(`/api/reports?period_type=${type}`).then((r) => r.json()),
      ])
      if (statsRes.error) throw new Error(statsRes.error)
      setPeriod(statsRes.period)
      setStats(statsRes.stats || [])
      setTotals(statsRes.totals ?? null)

      // Существующий отчёт за этот период
      const reports = reportsRes.reports || []
      const match = reports.find((r: { period_start: string; period_type: string }) =>
        r.period_start === statsRes.period.start && r.period_type === type
      )
      setExistingReportId(match?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    }
    setLoading(false)
  }

  async function createReport() {
    setCreating(true)
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period_type: type, period_start: start }),
    })
    setCreating(false)
    const json = await res.json()
    if (!res.ok) {
      alert(json.error ?? `HTTP ${res.status}`)
      return
    }
    router.push(`/reports/${json.report.id}`)
  }

  function changeType(t: 'week' | 'month') {
    setType(t)
    setStart(t === 'week' ? thisMonday() : thisMonthFirst())
  }

  const periodTitleData = period ? periodTitle(period) : null
  // Плитки наверху используют totals из API: unique главным числом,
  // pairs (случаев) — подписью мелким шрифтом.
  void useMemo

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-2">
        <Link href="/reports" className="text-sm text-blue-600 hover:underline">← К отчётам</Link>
      </div>

      {/* Селектор периода + навигация */}
      <div className="bg-white border rounded shadow-sm p-4 mb-5 flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 border rounded p-0.5 bg-gray-50">
          <button
            onClick={() => changeType('week')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              type === 'week' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-white'
            }`}
          >
            Неделя
          </button>
          <button
            onClick={() => changeType('month')}
            className={`px-3 py-1.5 rounded text-sm font-medium ${
              type === 'month' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-white'
            }`}
          >
            Месяц
          </button>
        </div>

        <div className="flex gap-1 border rounded p-0.5">
          <button
            onClick={() => setStart(shiftPeriod(start, type, -1))}
            className="px-2 py-1 text-sm hover:bg-gray-50 rounded"
            title="Предыдущий"
          >
            ←
          </button>
          <button
            onClick={() => setStart(type === 'week' ? thisMonday() : thisMonthFirst())}
            className="px-3 py-1 text-sm hover:bg-gray-50 rounded"
          >
            {type === 'week' ? 'Текущая неделя' : 'Текущий месяц'}
          </button>
          <button
            onClick={() => setStart(shiftPeriod(start, type, 1))}
            className="px-2 py-1 text-sm hover:bg-gray-50 rounded"
            title="Следующий"
          >
            →
          </button>
        </div>

        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="px-2 py-1 border rounded text-sm"
        />

        <div className="flex-1" />

        {existingReportId ? (
          <Link
            href={`/reports/${existingReportId}`}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
          >
            📋 Открыть отчёт за период
          </Link>
        ) : (
          <button
            onClick={createReport}
            disabled={creating || !period}
            className="px-3 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {creating ? '⏳ Создаётся…' : '✨ Сформировать отчёт за период'}
          </button>
        )}
      </div>

      {/* Заголовок периода */}
      {periodTitleData && period && (
        <div className="mb-5">
          <h1 className="text-2xl font-bold leading-tight">
            {periodTitleData.kind} статистика за период {periodTitleData.phrase}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {formatDate(period.start)} — {formatDate(period.end)} · активных объектов: {stats.length}
          </p>
        </div>
      )}

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {/* Сводные числа — кликабельные плитки.
          Для задач: главное = уникальные задачи, мелким = "по N случаям"
          (одна задача на 4 объектах = 1 уникальная / 4 случая).
          События и темы — уникальны по сути, без pairs/unique различия. */}
      {!loading && totals && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-5">
          <SummaryTile
            label="Закрыто за период"
            value={totals.tasks_done_unique}
            sub={pluralCases(totals.tasks_done_pairs, totals.tasks_done_unique)}
            color="text-green-700"
            onClick={() => openDetails('tasks_done', 'Закрыто за период')}
          />
          <SummaryTile
            label="Активны"
            value={totals.tasks_active_unique}
            sub={pluralCases(totals.tasks_active_pairs, totals.tasks_active_unique)}
            color="text-blue-700"
            onClick={() => openDetails('tasks_active', 'Активные задачи')}
          />
          <SummaryTile
            label="Просрочено"
            value={totals.tasks_overdue_unique}
            sub={pluralCases(totals.tasks_overdue_pairs, totals.tasks_overdue_unique)}
            color={totals.tasks_overdue_unique > 0 ? 'text-red-600' : 'text-gray-500'}
            onClick={() => openDetails('tasks_overdue', 'Просроченные задачи')}
          />
          <SummaryTile
            label="События за период"
            value={totals.events_in_period}
            color="text-gray-800"
            onClick={() => openDetails('events', 'События за период')}
          />
          <SummaryTile
            label="Темы обсуждений"
            value={totals.topics_recent}
            color="text-gray-700"
            onClick={() => openDetails('topics', 'Темы обсуждений (±2 нед.)')}
          />
        </div>
      )}

      {/* Popup с детализацией */}
      {detailsOpen && (
        <DetailsModal
          title={detailsTitle}
          items={detailsItems}
          loading={detailsLoading}
          taskCount={detailsTaskCount}
          pairCount={detailsPairCount}
          onClose={() => setDetailsOpen(false)}
        />
      )}

      {loading ? (
        <p>Загрузка…</p>
      ) : stats.length === 0 ? (
        <div className="bg-white border rounded p-8 text-center text-gray-500">
          Активных объектов нет.
        </div>
      ) : (
        <div className="space-y-4">
          {stats.map((s) => (
            <article key={s.object_id} className="bg-white border rounded shadow-sm p-5">
              <header className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                <h2 className="text-lg font-bold text-gray-900">
                  {s.object_code} — {s.object_name}
                </h2>
                <div className="text-xs text-gray-700 flex gap-3 flex-wrap">
                  <span>Закрыто: <strong className="text-green-700">{s.tasks_done}</strong></span>
                  <span>Активны: <strong className="text-blue-700">{s.tasks_active}</strong></span>
                  <span>Просрочено: <strong className={s.tasks_overdue > 0 ? 'text-red-600' : 'text-gray-500'}>{s.tasks_overdue}</strong></span>
                  <span>События: <strong>{s.events_in_period}</strong></span>
                  <span>Темы: <strong>{s.topics_recent}</strong></span>
                </div>
              </header>

              {s.contractors.length > 0 && (
                <div className="space-y-2">
                  {s.contractors.map((g) => (
                    <div key={g.contractor_entity_id ?? 'orphan'} className="bg-gray-50 border border-gray-200 rounded p-2 text-xs">
                      <div className="font-medium text-gray-800 mb-1">
                        {g.contractor_entity_id ? '👤' : '⚠️'} {g.contractor_name}
                      </div>
                      {g.contracts.length > 0 && (
                        <div className="space-y-1 mb-2">
                          {g.contracts.map((c) => (
                            <div key={c.id} className="text-gray-600 pl-3">
                              <span className="font-mono text-[10px] uppercase tracking-wider bg-blue-100 text-blue-800 px-1 rounded mr-1">{c.type}</span>
                              {c.doc_number && <span className="font-mono mr-2">№ {c.doc_number}</span>}
                              {c.signed_date && <span className="text-gray-400">от {formatDate(c.signed_date)}</span>}
                              <span className="ml-2">{c.title}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-3 text-gray-700 pt-1 border-t border-gray-200">
                        <span>Закрыто: <strong className="text-green-700">{g.stats.tasks_done}</strong></span>
                        <span>Активны: <strong className="text-blue-700">{g.stats.tasks_active}</strong></span>
                        <span>Просрочено: <strong className={g.stats.tasks_overdue > 0 ? 'text-red-600' : 'text-gray-500'}>{g.stats.tasks_overdue}</strong></span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryTile({
  label, value, sub, color, onClick,
}: {
  label: string; value: number; sub?: string; color: string; onClick?: () => void
}) {
  const interactive = !!onClick && value > 0
  const Tag = interactive ? 'button' : 'div'
  return (
    <Tag
      onClick={interactive ? onClick : undefined}
      type={interactive ? 'button' : undefined}
      className={`text-left w-full bg-white border border-gray-200 rounded p-3 transition-colors ${
        interactive ? 'cursor-pointer hover:border-blue-400 hover:bg-blue-50' : ''
      } ${value === 0 ? 'opacity-60' : ''}`}
    >
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
      {interactive && !sub && <div className="text-[10px] text-blue-500 mt-0.5">▸ показать список</div>}
    </Tag>
  )
}

function DetailsModal({
  title, items, loading, taskCount, pairCount, onClose,
}: {
  title: string
  items: DetailsItem[]
  loading: boolean
  taskCount: number | null
  pairCount: number | null
  onClose: () => void
}) {
  // Для задач: показываем главное число «N задач(и/а)» крупно,
  // если случаев (пар) больше — мелким текстом «по M случаям».
  const counterLabel = (() => {
    if (loading) return ''
    if (taskCount != null && pairCount != null && pairCount !== taskCount) {
      const tw = taskCount === 1 ? 'задача' : (taskCount >= 2 && taskCount <= 4 ? 'задачи' : 'задач')
      return ` · ${taskCount} ${tw}`
    }
    return ` (${items.length})`
  })()
  const subLabel = (() => {
    if (loading || taskCount == null || pairCount == null) return ''
    if (pairCount === taskCount) return ''
    const last = pairCount % 10
    const lastTwo = pairCount % 100
    let word: string
    if (lastTwo >= 11 && lastTwo <= 14) word = 'случаям'
    else if (last === 1) word = 'случаю'
    else word = 'случаям'
    return `по ${pairCount} ${word} (задача × объект)`
  })()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold">
              {title}
              {!loading && <span className="ml-2 text-sm font-normal text-gray-500">{counterLabel}</span>}
            </h2>
            {subLabel && (
              <div className="text-xs text-gray-400 mt-0.5">{subLabel}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {loading ? (
            <p className="text-sm text-gray-500 p-4 text-center">Загрузка…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-400 p-4 text-center italic">— пусто —</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {items.map((it) => {
                const codes = (it.object_codes ?? []).filter(Boolean) as string[]
                const content = (
                  <>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      {it.code && <span className="font-mono text-xs text-gray-400">{it.code}</span>}
                      <span className="font-medium text-gray-900">{it.title}</span>
                    </div>
                    {it.subtitle && (
                      <div className="text-xs text-gray-500 mt-0.5">{it.subtitle}</div>
                    )}
                    {codes.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {codes.map((c) => (
                          <span key={c} className="font-mono text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{c}</span>
                        ))}
                      </div>
                    )}
                  </>
                )
                return (
                  <li key={it.id} className="py-2 px-2">
                    {it.link ? (
                      <Link
                        href={it.link}
                        className="block hover:bg-blue-50 rounded -mx-2 px-2 py-1"
                      >
                        {content}
                      </Link>
                    ) : (
                      <div>{content}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="border-t p-3 flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
