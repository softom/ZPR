'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

const nav = [
  { href: '/',          label: 'Главная' },
  { href: '/objects',   label: 'Объекты' },
  { href: '/contracts', label: 'Договора' },
  { href: '/incoming',  label: 'Входящие' },
]

const navAdmin = [
  { href: '/admin', label: 'Пользователи' },
]

const ROLE_LABEL: Record<string, string> = {
  viewer:   'Просмотр',
  uploader: 'Оператор',
  admin:    'Администратор',
}

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setEmail(session?.user?.email ?? null)
      setRole((session?.user?.user_metadata?.role as string) ?? null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null)
      setRole((session?.user?.user_metadata?.role as string) ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  const isLoggedIn = !!email

  return (
    <aside className="w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-5 py-4 border-b border-gray-200">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">ЗПР</p>
        <p className="text-sm font-medium text-gray-800 mt-0.5">Золотые Пески России</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(({ href, label }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </nav>

      {isLoggedIn && (
        <div className="px-3 py-3 border-t border-gray-200 space-y-1">
          <p className="px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Администрирование
          </p>
          {navAdmin.map(({ href, label }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </div>
      )}

      <div className="px-5 py-4 border-t border-gray-200">
        {isLoggedIn ? (
          <>
            <p className="text-xs text-gray-500 truncate mb-0.5">{email}</p>
            {role && (
              <p className="text-xs font-medium text-gray-400 mb-2">{ROLE_LABEL[role] ?? role}</p>
            )}
            <button
              onClick={handleLogout}
              className="w-full text-left px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
            >
              Выйти
            </button>
          </>
        ) : (
          <Link
            href="/login"
            className="flex items-center px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            Войти
          </Link>
        )}
      </div>
    </aside>
  )
}
