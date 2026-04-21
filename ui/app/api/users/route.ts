import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

async function getCallerRole(req: NextRequest): Promise<string | null> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return null
  const { data: { user } } = await supabaseAdmin.auth.getUser(token)
  return (user?.user_metadata?.role as string) ?? null
}

export async function GET() {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const users = data.users.map(u => ({
    id: u.id,
    email: u.email,
    role: (u.user_metadata?.role as string) ?? 'viewer',
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
  }))

  return NextResponse.json(users)
}

export async function PATCH(req: NextRequest) {
  const callerRole = await getCallerRole(req)
  if (callerRole !== 'admin') {
    return NextResponse.json({ error: 'Доступ запрещён — требуется роль admin' }, { status: 403 })
  }

  const { id, role } = await req.json()
  if (!id || !['viewer', 'uploader', 'admin'].includes(role)) {
    return NextResponse.json({ error: 'Неверные параметры' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
    user_metadata: { role },
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
