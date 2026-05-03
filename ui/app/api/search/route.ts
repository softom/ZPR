import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const POLZA_BASE_URL   = process.env.POLZA_BASE_URL   ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY    = process.env.POLZA_API_KEY    ?? ''
const EMBEDDING_MODEL  = process.env.EMBEDDING_MODEL  ?? 'openai/text-embedding-3-small'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim()
  if (!q || q.length < 2) return NextResponse.json([])

  try {
    // 1 — Получаем эмбеддинг запроса
    const embResp = await fetch(`${POLZA_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${POLZA_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: q }),
    })

    if (!embResp.ok) {
      // Fallback: full-text search if embeddings unavailable
      return fullTextSearch(q)
    }

    const embData = await embResp.json()
    const embedding: number[] = embData.data?.[0]?.embedding
    if (!embedding) return fullTextSearch(q)

    // 2 — Векторный поиск через RPC
    const { data, error } = await supabaseAdmin.rpc('search_documents', {
      query_embedding: embedding,
      match_count: 8,
    })

    if (error) {
      console.error('[search] rpc error:', error.message)
      return fullTextSearch(q)
    }

    return NextResponse.json(data ?? [])
  } catch (err) {
    console.error('[search]', err)
    return fullTextSearch(q)
  }
}

async function fullTextSearch(q: string) {
  const { data } = await supabaseAdmin
    .from('documents')
    .select('id,title,folder_path,object_codes')
    .is('deleted_at', null)
    .ilike('title', `%${q}%`)
    .limit(8)

  return NextResponse.json(
    (data ?? []).map(d => ({
      document_id:  d.id,
      title:        d.title,
      folder_path:  d.folder_path,
      object_codes: d.object_codes,
      chunk_text:   '',
      similarity:   null,
    }))
  )
}
