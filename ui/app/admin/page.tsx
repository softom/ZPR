'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type User = {
  id: string
  email: string
  role: string
  created_at: string
  last_sign_in_at: string | null
}

type GisSyncTableResult = {
  table: string
  rows: number
  durationMs: number
  error?: string
}

type GisSyncResponse = {
  ok: boolean
  totalRows?: number
  tables?: GisSyncTableResult[]
  error?: string
  results?: GisSyncTableResult[]
}

const ROLES = [
  { value: 'viewer',   label: 'Viewer — только чтение' },
  { value: 'uploader', label: 'Uploader — оператор' },
  { value: 'admin',    label: 'Admin — полный доступ' },
]

const ROLE_BADGE: Record<string, string> = {
  viewer:   'bg-gray-100 text-gray-600',
  uploader: 'bg-blue-100 text-blue-700',
  admin:    'bg-purple-100 text-purple-700',
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [currentRole, setCurrentRole] = useState<string | null>(null)

  // GIS Sync state
  const [gisLoading, setGisLoading] = useState(false)
  const [gisResult, setGisResult] = useState<GisSyncResponse | null>(null)
  const [gisError, setGisError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const role = (session?.user?.user_metadata?.role as string) ?? 'viewer'
      setCurrentRole(role)
    })
    load()
  }, [])

  async function getToken(): Promise<string | null> {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }

  async function load() {
    setLoading(true)
    const res = await fetch('/api/users')
    const data = await res.json()
    setUsers(data)
    setLoading(false)
  }

  async function changeRole(id: string, role: string) {
    setSaving(id)
    setError('')
    const token = await getToken()
    const res = await fetch('/api/users', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ id, role }),
    })
    if (!res.ok) {
      const d = await res.json()
      setError(d.error ?? 'Ошибка')
    } else {
      setUsers(u => u.map(user => user.id === id ? { ...user, role } : user))
    }
    setSaving(null)
  }

  async function handleGisSync() {
    setGisLoading(true)
    setGisError('')
    setGisResult(null)
    try {
      const res = await fetch('/api/gis/sync', { method: 'POST' })
      const data: GisSyncResponse = await res.json()
      if (!res.ok || !data.ok) {
        setGisError(data.error ?? `HTTP ${res.status}`)
      }
      setGisResult(data)
    } catch (err) {
      setGisError(err instanceof Error ? err.message : 'Сетевая ошибка')
    }
    setGisLoading(false)
  }

  const isAdmin = currentRole === 'admin'

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Пользователи</h1>

      {!isAdmin && currentRole !== null && (
        <div className="mb-4 text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-md px-3 py-2">
          Просмотр доступен всем. Изменение ролей — только администратору.
        </div>
      )}

      {error && (
        <p className="mb-4 text-sm text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Роль</th>
                {isAdmin && (
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Изменить</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map(user => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900">{user.email}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[user.role] ?? ROLE_BADGE.viewer}`}>
                      {user.role}
                    </span>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <select
                        value={user.role}
                        disabled={saving === user.id}
                        onChange={e => changeRole(user.id, e.target.value)}
                        className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                      >
                        {ROLES.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── GIS Sync ─────────────────────────────────────────────────── */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Синхронизация GIS</h2>
        <p className="text-sm text-gray-500 mb-4">
          Копирование данных из вьюшек <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">gis_*</code> (postgres)
          в таблицы <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">*_sk63</code> (zpr_gis) для ArcGIS Pro.
        </p>

        <button
          onClick={handleGisSync}
          disabled={gisLoading}
          className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {gisLoading ? 'Синхронизация…' : 'Синхронизировать GIS → ArcGIS'}
        </button>

        {gisError && (
          <p className="mt-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {gisError}
          </p>
        )}

        {gisResult && gisResult.ok && (
          <div className="mt-4 bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-green-50 border-b border-green-200 flex items-center justify-between">
              <span className="text-sm font-medium text-green-800">
                Синхронизация завершена
              </span>
              <span className="text-sm text-green-600 tabular-nums">
                {gisResult.totalRows?.toLocaleString('ru')} строк
              </span>
            </div>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Таблица</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Строк</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Время</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {gisResult.tables?.map((t) => (
                  <tr key={t.table} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{t.table}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-900">{t.rows.toLocaleString('ru')}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-500">{t.durationMs} мс</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {gisResult && !gisResult.ok && gisResult.results && gisResult.results.length > 0 && (
          <div className="mt-4 bg-white border border-red-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-red-50 border-b border-red-200">
              <span className="text-sm font-medium text-red-800">Синхронизация прервана</span>
            </div>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Таблица</th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Строк</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {gisResult.results.map((t) => (
                  <tr key={t.table} className={t.error ? 'bg-red-50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{t.table}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-900">{t.rows.toLocaleString('ru')}</td>
                    <td className="px-4 py-2 text-xs">
                      {t.error
                        ? <span className="text-red-600">{t.error}</span>
                        : <span className="text-green-600">OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
