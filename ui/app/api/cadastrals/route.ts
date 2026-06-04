import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic'

/**
 * GET /api/cadastrals?ownership=...&seizure=...&search=...
 *
 * Возвращает список кадастровых участков из целевой модели (v_cadastrals_full).
 * Фильтры: ownership (enum), seizure (boolean), search (text — по КН или адресу).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ownership = url.searchParams.get('ownership') // private|municipal|state_subject|state_federal|mixed|unknown
  const seizure = url.searchParams.get('seizure')     // true|false
  const search = url.searchParams.get('search')

  let query = supabaseAdmin
    .from('v_cadastrals_full')
    .select('*')
    .eq('active', true)
    .order('cadastral_number')

  if (ownership && ownership !== 'all') {
    query = query.eq('ownership', ownership)
  }

  if (seizure === 'true') {
    query = query.eq('is_seizure', true)
  } else if (seizure === 'false') {
    query = query.eq('is_seizure', false)
  }

  if (search && search.trim().length > 0) {
    query = query.or(`cadastral_number.ilike.%${search}%,address.ilike.%${search}%`)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data ?? [])
}
