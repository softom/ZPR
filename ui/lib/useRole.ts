'use client'

import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export function useRole() {
  const [role, setRole] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setRole((session?.user?.user_metadata?.role as string) ?? null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setRole((session?.user?.user_metadata?.role as string) ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  return {
    role,
    isAdmin:    role === 'admin',
    isUploader: role === 'uploader' || role === 'admin',
    isLoggedIn: role !== null,
  }
}
