import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

// Обновляем куки сессии на каждом запросе — без принудительного редиректа.
// Логин добровольный: неавторизованный пользователь видит сайт, но не может писать в БД.
export async function proxy(req: NextRequest) {
  const res = NextResponse.next()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookies) => cookies.forEach(({ name, value, options }) =>
          res.cookies.set(name, value, options)
        ),
      },
    }
  )

  await supabase.auth.getSession()
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
}
