import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const ROLES = ['viewer', 'uploader', 'admin'] as const
type Role = typeof ROLES[number]

const BAN_DURATION = '876000h' // ~100 лет
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function getCaller(req: NextRequest): Promise<{ id: string; role: string } | null> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return null
  const { data: { user } } = await supabaseAdmin.auth.getUser(token)
  if (!user) return null
  return {
    id: user.id,
    role: (user.user_metadata?.role as string) ?? 'viewer',
  }
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
    banned_until: (u as unknown as { banned_until?: string | null }).banned_until ?? null,
  }))

  return NextResponse.json(users)
}

export async function POST(req: NextRequest) {
  const caller = await getCaller(req)
  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'Доступ запрещён — требуется роль admin' }, { status: 403 })
  }

  const { email, password, role } = await req.json()
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'Неверный email' }, { status: 400 })
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return NextResponse.json({ error: 'Пароль должен быть не короче 6 символов' }, { status: 400 })
  }
  if (!ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'Неверная роль' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role },
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id: data.user?.id })
}

export async function PATCH(req: NextRequest) {
  const caller = await getCaller(req)
  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'Доступ запрещён — требуется роль admin' }, { status: 403 })
  }

  const body = await req.json()
  const { id } = body
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Не указан id' }, { status: 400 })
  }

  if ('role' in body) {
    if (!ROLES.includes(body.role as Role)) {
      return NextResponse.json({ error: 'Неверная роль' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      user_metadata: { role: body.role },
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if ('banned' in body) {
    if (id === caller.id) {
      return NextResponse.json({ error: 'Нельзя заблокировать самого себя' }, { status: 403 })
    }
    const ban_duration = body.banned ? BAN_DURATION : 'none'
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      ban_duration,
    } as Parameters<typeof supabaseAdmin.auth.admin.updateUserById>[1])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if ('password' in body) {
    if (id === caller.id) {
      return NextResponse.json({ error: 'Свой пароль меняйте через профиль' }, { status: 403 })
    }
    if (typeof body.password !== 'string' || body.password.length < 6) {
      return NextResponse.json({ error: 'Пароль должен быть не короче 6 символов' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: body.password,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Не указано действие' }, { status: 400 })
}
