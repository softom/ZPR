'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type User = {
  id: string
  email: string
  role: string
  created_at: string
  last_sign_in_at: string | null
  banned_until: string | null
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

function isBanned(u: User): boolean {
  if (!u.banned_until) return false
  return new Date(u.banned_until).getTime() > Date.now()
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [currentRole, setCurrentRole] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState('viewer')

  const [pwUserId, setPwUserId] = useState<string | null>(null)
  const [pwValue, setPwValue] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUserId(session?.user?.id ?? null)
      setCurrentRole((session?.user?.user_metadata?.role as string) ?? 'viewer')
    })
    load()
  }, [])

  async function getToken(): Promise<string | null> {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }

  async function authedFetch(method: string, body: object) {
    const token = await getToken()
    return fetch('/api/users', {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  async function load() {
    setLoading(true)
    const res = await fetch('/api/users')
    const data = await res.json()
    setUsers(data)
    setLoading(false)
  }

  async function changeRole(id: string, role: string) {
    setBusy(id); setError('')
    const res = await authedFetch('PATCH', { id, role })
    if (!res.ok) {
      setError((await res.json()).error ?? 'Ошибка')
    } else {
      setUsers(u => u.map(user => user.id === id ? { ...user, role } : user))
    }
    setBusy(null)
  }

  async function toggleBan(u: User) {
    setBusy(u.id); setError('')
    const banned = !isBanned(u)
    const res = await authedFetch('PATCH', { id: u.id, banned })
    if (!res.ok) {
      setError((await res.json()).error ?? 'Ошибка')
    } else {
      await load()
    }
    setBusy(null)
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setBusy('new'); setError('')
    const res = await authedFetch('POST', { email: newEmail, password: newPassword, role: newRole })
    if (!res.ok) {
      setError((await res.json()).error ?? 'Ошибка')
    } else {
      setNewEmail(''); setNewPassword(''); setNewRole('viewer'); setShowAdd(false)
      await load()
    }
    setBusy(null)
  }

  async function savePassword(id: string) {
    setBusy(id); setError('')
    const res = await authedFetch('PATCH', { id, password: pwValue })
    if (!res.ok) {
      setError((await res.json()).error ?? 'Ошибка')
    } else {
      setPwUserId(null); setPwValue('')
    }
    setBusy(null)
  }

  const isAdmin = currentRole === 'admin'

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Пользователи</h1>
        {isAdmin && (
          <button
            onClick={() => setShowAdd(s => !s)}
            className="px-3 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
          >
            {showAdd ? 'Отмена' : 'Добавить пользователя'}
          </button>
        )}
      </div>

      {!isAdmin && currentRole !== null && (
        <div className="mb-4 text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-md px-3 py-2">
          Просмотр доступен всем. Изменения — только администратору.
        </div>
      )}

      {error && (
        <p className="mb-4 text-sm text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>
      )}

      {isAdmin && showAdd && (
        <form onSubmit={createUser} className="mb-6 bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            type="email"
            required
            placeholder="email@example.com"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <input
            type="text"
            required
            minLength={6}
            placeholder="Пароль (≥6)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <select
            value={newRole}
            onChange={e => setNewRole(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button
            type="submit"
            disabled={busy === 'new'}
            className="px-3 py-2 rounded-md text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy === 'new' ? 'Создание…' : 'Создать'}
          </button>
        </form>
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Статус</th>
                {isAdmin && (
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Действия</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map(user => {
                const banned = isBanned(user)
                const isSelf = user.id === currentUserId
                const disabled = busy === user.id
                return (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{user.email}{isSelf && <span className="ml-2 text-xs text-gray-400">(вы)</span>}</td>
                    <td className="px-4 py-3">
                      {isAdmin && !isSelf ? (
                        <select
                          value={user.role}
                          disabled={disabled}
                          onChange={e => changeRole(user.id, e.target.value)}
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                        >
                          {ROLES.map(r => <option key={r.value} value={r.value}>{r.value}</option>)}
                        </select>
                      ) : (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGE[user.role] ?? ROLE_BADGE.viewer}`}>
                          {user.role}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${banned ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                        {banned ? 'Заблокирован' : 'Активен'}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        {isSelf ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : pwUserId === user.id ? (
                          <div className="flex gap-2 items-center">
                            <input
                              type="text"
                              minLength={6}
                              placeholder="Новый пароль"
                              value={pwValue}
                              onChange={e => setPwValue(e.target.value)}
                              className="border border-gray-300 rounded-md px-2 py-1 text-sm w-40"
                            />
                            <button
                              onClick={() => savePassword(user.id)}
                              disabled={disabled || pwValue.length < 6}
                              className="px-2 py-1 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              Сохранить
                            </button>
                            <button
                              onClick={() => { setPwUserId(null); setPwValue('') }}
                              className="px-2 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
                            >
                              Отмена
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              onClick={() => toggleBan(user)}
                              disabled={disabled}
                              className={`px-2 py-1 rounded-md text-xs font-medium disabled:opacity-50 ${banned ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'}`}
                            >
                              {banned ? 'Разблокировать' : 'Заблокировать'}
                            </button>
                            <button
                              onClick={() => { setPwUserId(user.id); setPwValue('') }}
                              disabled={disabled}
                              className="px-2 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                            >
                              Сменить пароль
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
