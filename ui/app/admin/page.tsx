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
    </div>
  )
}
