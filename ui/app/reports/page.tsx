'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type ReportRow = {
  id: string
  period_type: 'week' | 'month' | 'control' | 'short' | 'contract'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  created_at: string
  finalized_at: string | null
  sections_total: number
  sections_filled: number
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  final: 'Финал',
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-amber-100 text-amber-800',
  final: 'bg-green-100 text-green-700',
}

const TYPE_LABEL: Record<string, string> = {
  week: 'Неделя',
  month: 'Месяц',
  control: 'Справка ТЗ',
  short: 'Короткая справка',
  contract: 'Отчёт по договору',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Текущий понедельник (для дефолта при создании week-отчёта)
function thisMonday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() || 7
  d.setDate(d.getDate() - (day - 1))
  return d.toISOString().slice(0, 10)
}

// 1-е число текущего месяца (для дефолта month)
function thisMonthFirst(): string {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

export default function ReportsPage() {
  const router = useRouter()
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterType, setFilterType] = useState<'' | 'week' | 'month' | 'control' | 'short' | 'contract'>('')
  const [filterStatus, setFilterStatus] = useState<'' | 'draft' | 'final'>('')

  // Модал создания
  const [creating, setCreating] = useState(false)
  const [newType, setNewType] = useState<'week' | 'month' | 'control' | 'short' | 'contract'>('week')
  const [newStart, setNewStart] = useState(thisMonday())
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState('')

  useEffect(() => { load() }, [filterType, filterStatus])

  async function load() {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (filterType) params.set('period_type', filterType)
    if (filterStatus) params.set('status', filterStatus)
    const res = await fetch(`/api/reports?${params}`)
    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? `HTTP ${res.status}`)
      setLoading(false)
      return
    }
    setReports(json.reports || [])
    setLoading(false)
  }

  function openCreate() {
    setNewType('week')
    setNewStart(thisMonday())
    setCreateError('')
    setCreating(true)
  }

  function todayISO(): string {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString().slice(0, 10)
  }

  function changeType(t: 'week' | 'month' | 'control' | 'short' | 'contract') {
    setNewType(t)
    if (t === 'week') setNewStart(thisMonday())
    else if (t === 'month' || t === 'contract') setNewStart(thisMonthFirst())
    else setNewStart(todayISO())   // control / short — снимок на дату
  }

  async function submitCreate() {
    setSubmitting(true)
    setCreateError('')
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period_type: newType, period_start: newStart }),
    })
    const json = await res.json()
    setSubmitting(false)
    if (!res.ok) {
      setCreateError(json.error ?? `HTTP ${res.status}`)
      return
    }
    setCreating(false)
    router.push(`/reports/${json.report.id}`)
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold">Отчёты</h1>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          + Создать отчёт
        </button>
      </div>

      {/* Три плитки разделов */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Link
          href="/reports/stats"
          className="block bg-white border-2 border-emerald-200 rounded-lg p-5 hover:border-emerald-400 hover:shadow-md transition-all"
        >
          <div className="text-3xl mb-2">📊</div>
          <h2 className="text-lg font-semibold text-emerald-900">Статистика</h2>
          <p className="text-sm text-gray-600 mt-1">
            Срез за любой период (неделя/месяц) без сохранения. Текущая картина по всем объектам.
          </p>
        </Link>
        <div className="block bg-white border-2 border-blue-200 rounded-lg p-5">
          <div className="text-3xl mb-2">📋</div>
          <h2 className="text-lg font-semibold text-blue-900">Сформированные отчёты</h2>
          <p className="text-sm text-gray-600 mt-1">
            Отчёты с LLM-генерацией по объектам, общая сводка, скачивание .md / .docx.
          </p>
        </div>
        <Link
          href="/reports/external-check"
          className="block bg-white border-2 border-amber-200 rounded-lg p-5 hover:border-amber-400 hover:shadow-md transition-all"
        >
          <div className="text-3xl mb-2">🔍</div>
          <h2 className="text-lg font-semibold text-amber-900">Проверить внешний отчёт</h2>
          <p className="text-sm text-gray-600 mt-1">
            Загрузи внешний документ (DOCX/TXT/MD) — LLM сверит факты с БД проекта: что подтверждено,
            что расходится, что упущено.
          </p>
        </Link>
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      <div className="flex gap-2 mb-4">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as '' | 'week' | 'month' | 'control' | 'short' | 'contract')}
          className="px-3 py-1.5 border rounded text-sm"
        >
          <option value="">Все типы</option>
          <option value="week">Только недельные</option>
          <option value="month">Только месячные</option>
          <option value="control">Только Справки ТЗ</option>
          <option value="short">Только Короткие справки</option>
          <option value="contract">Только по договору</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as '' | 'draft' | 'final')}
          className="px-3 py-1.5 border rounded text-sm"
        >
          <option value="">Все статусы</option>
          <option value="draft">Черновики</option>
          <option value="final">Финалы</option>
        </select>
      </div>

      {loading ? (
        <p>Загрузка…</p>
      ) : reports.length === 0 ? (
        <div className="bg-white border rounded p-8 text-center text-gray-500">
          Отчётов пока нет. Нажмите «Создать отчёт» чтобы начать.
        </div>
      ) : (
        <div className="bg-white border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-left">
              <tr>
                <th className="px-3 py-2 w-24">Тип</th>
                <th className="px-3 py-2">Период</th>
                <th className="px-3 py-2">Заголовок</th>
                <th className="px-3 py-2 w-32">Заполнено</th>
                <th className="px-3 py-2 w-24">Статус</th>
                <th className="px-3 py-2 w-32">Создан</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  className="border-b hover:bg-gray-50 cursor-pointer"
                  onClick={() => router.push(`/reports/${r.id}`)}
                >
                  <td className="px-3 py-2">{TYPE_LABEL[r.period_type]}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatDate(r.period_start)} — {formatDate(r.period_end)}
                  </td>
                  <td className="px-3 py-2">{r.title || '—'}</td>
                  <td className="px-3 py-2">
                    <span className="text-gray-600">
                      {r.sections_filled} / {r.sections_total}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{formatDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Новый отчёт</h2>
              <button
                onClick={() => setCreating(false)}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >
                ✕
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Тип отчёта *</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => changeType('week')}
                    className={`px-2 py-2 text-xs rounded border ${
                      newType === 'week' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    📅 Недельный<br /><span className="text-[10px] opacity-80">пн-вс, 7 дней</span>
                  </button>
                  <button
                    onClick={() => changeType('month')}
                    className={`px-2 py-2 text-xs rounded border ${
                      newType === 'month' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    📆 Месячный<br /><span className="text-[10px] opacity-80">1-30/31</span>
                  </button>
                  <button
                    onClick={() => changeType('control')}
                    className={`px-2 py-2 text-xs rounded border ${
                      newType === 'control' ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    📋 Справка ТЗ<br /><span className="text-[10px] opacity-80">для руководства</span>
                  </button>
                  <button
                    onClick={() => changeType('short')}
                    className={`px-2 py-2 text-xs rounded border ${
                      newType === 'short' ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    ✅ Короткая справка<br /><span className="text-[10px] opacity-80">утв. варианты</span>
                  </button>
                  <button
                    onClick={() => changeType('contract')}
                    className={`px-2 py-2 text-xs rounded border ${
                      newType === 'contract' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-300'
                    }`}
                  >
                    📑 По договору<br /><span className="text-[10px] opacity-80">услуги ИП по Заданию</span>
                  </button>
                </div>
                {newType === 'control' && (
                  <p className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded p-2 mt-2">
                    Интегральная справка для руководства/акционеров на дату формирования.
                    На каждом объекте — нарратив, этапы договоров и ключевые решения.
                  </p>
                )}
                {newType === 'short' && (
                  <p className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded p-2 mt-2">
                    Короткая справка: какие варианты заказчик утвердил в дальнейшую работу
                    (накопительно на дату). По каждому объекту — вступление + список утверждений.
                  </p>
                )}
                {newType === 'contract' && (
                  <p className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-2 mt-2">
                    Отчёт о проделанной работе по договору ТЗ (услуги ИП): по пунктам Задания,
                    рамка «Исполнитель организовал…». Собирается из месячного отчёта ЗПР, который
                    выбирается внутри как Приложение.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {newType === 'week' ? 'Понедельник недели *'
                    : (newType === 'month' || newType === 'contract') ? 'Любая дата месяца *'
                    : 'Дата формирования справки *'}
                </label>
                <input
                  type="date"
                  value={newStart}
                  onChange={(e) => setNewStart(e.target.value)}
                  className="w-full px-3 py-2 border rounded text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {newType === 'week' && 'Дата автоматически снэпится к понедельнику.'}
                  {newType === 'month' && 'Дата автоматически снэпится к 1-му числу месяца.'}
                  {newType === 'control' && 'Снимок состояния проекта на выбранную дату.'}
                  {newType === 'short' && 'Накопительно: все варианты, утверждённые до выбранной даты.'}
                  {newType === 'contract' && 'Месяц, за который формируется отчёт по договору (дата снэпится к 1-му числу).'}
                </p>
              </div>
              {createError && <p className="text-sm text-red-600">{createError}</p>}
            </div>
            <div className="flex justify-end gap-2 mt-5 pt-4 border-t">
              <button
                onClick={() => setCreating(false)}
                disabled={submitting}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Отмена
              </button>
              <button
                onClick={submitCreate}
                disabled={submitting || !newStart}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Создание…' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
