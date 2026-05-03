'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const role = (session?.user?.user_metadata?.role as string) ?? null
      if (role === 'admin') {
        setAllowed(true)
      } else {
        setAllowed(false)
        router.replace('/')
      }
    })
  }, [router])

  if (allowed === null) {
    return <p className="text-gray-400 text-sm p-6">Загрузка…</p>
  }
  if (!allowed) return null
  return <>{children}</>
}
