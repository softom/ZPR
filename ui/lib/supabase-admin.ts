import { createClient } from '@supabase/supabase-js'

// Серверный клиент с service_role — обходит RLS, только для API-роутов
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)
