/**
 * Извлечение «вызывающего» (caller) из Authorization: Bearer <jwt> заголовка
 * API-запроса. Возвращает user.id + role или null если токена нет / он невалиден.
 *
 * Используется в API-роутах, где нужно знать автора правки/комментария и/или
 * проверять права (admin-only действия) на стороне сервера.
 *
 * Изначально та же логика жила локально в /api/users/route.ts — вынесли,
 * чтобы переиспользовать в /api/strategic-topics/[id]/revisions, /comments, /publish.
 */

import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export type Caller = {
  id:    string
  email: string | null
  role:  string   // viewer | uploader | admin (или иное из user_metadata.role)
}

export async function getCaller(req: NextRequest): Promise<Caller | null> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return null
  const { data: { user } } = await supabaseAdmin.auth.getUser(token)
  if (!user) return null
  return {
    id:    user.id,
    email: user.email ?? null,
    role:  (user.user_metadata?.role as string) ?? 'viewer',
  }
}

export function isUploader(caller: Caller | null): boolean {
  return caller?.role === 'uploader' || caller?.role === 'admin'
}

export function isAdmin(caller: Caller | null): boolean {
  return caller?.role === 'admin'
}
