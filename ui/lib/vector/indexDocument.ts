/**
 * Индексация текста договора в pgvector (`document_chunks`).
 * Перенесено из ui/app/api/contracts/save/route.ts.
 *
 * Использует Polza.AI embeddings (text-embedding-3-small, 1536-dim).
 * Запускается fire-and-forget после сохранения договора.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const POLZA_BASE_URL  = process.env.POLZA_BASE_URL  ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY   = process.env.POLZA_API_KEY   ?? ''
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small'

const CHUNK_SIZE     = 400  // слов
const CHUNK_OVERLAP  = 50   // слов перекрытия

export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const chunks: string[] = []
  let i = 0
  while (i < words.length) {
    chunks.push(words.slice(i, i + size).join(' '))
    i += size - overlap
  }
  return chunks
}

export async function indexDocumentChunks(
  supabase: SupabaseClient,
  documentId: string,
  text: string,
): Promise<{ ok: boolean; chunks: number; error?: string }> {
  const chunks = chunkText(text)
  if (!chunks.length) return { ok: true, chunks: 0 }

  try {
    const embRes = await fetch(`${POLZA_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${POLZA_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: chunks }),
    })
    if (!embRes.ok) {
      const errText = await embRes.text()
      console.error('[index] embeddings error:', errText)
      return { ok: false, chunks: 0, error: errText }
    }

    const embData = await embRes.json()
    const rows = chunks.map((chunk, i) => ({
      document_id: documentId,
      chunk_index: i,
      chunk_text:  chunk,
      embedding:   embData.data[i]?.embedding ?? null,
    }))

    // Полностью переиндексируем — удаляем старые чанки.
    await supabase.from('document_chunks').delete().eq('document_id', documentId)
    const { error: insErr } = await supabase.from('document_chunks').insert(rows)
    if (insErr) {
      console.error('[index] insert error:', insErr.message)
      return { ok: false, chunks: 0, error: insErr.message }
    }

    await supabase
      .from('documents')
      .update({ indexed_at: new Date().toISOString() })
      .eq('id', documentId)

    console.log(`[index] ${rows.length} chunks for ${documentId}`)
    return { ok: true, chunks: rows.length }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[index] exception:', msg)
    return { ok: false, chunks: 0, error: msg }
  }
}
