/**
 * GET /api/protocols/[id]/speakers
 *
 * Извлекает уникальных спикеров из загруженной транскрипции собрания
 * (только для CSV-формата; для DOCX/TXT возвращает пустой массив).
 *
 * Возврат: [{ raw: "Speaker 1", count: 42, samples: ["...", "..."] }, ...]
 *
 * Используется UI секцией «Маппинг спикеров» — пользователь сопоставляет
 * каждого raw-спикера с participant'ом до запуска LLM.
 */

import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { extractSpeakers } from '@/lib/protocol/parseTranscript'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings')
    .select('transcription_path')
    .eq('id', id)
    .single()
  if (mErr || !meeting) {
    return NextResponse.json({ error: 'Собрание не найдено' }, { status: 404 })
  }
  if (!meeting.transcription_path) {
    return NextResponse.json({ speakers: [], format: 'none' })
  }

  const filePath = path.join(
    STORAGE_DIR,
    (meeting.transcription_path as string).replace(/\//g, path.sep),
  )
  const ext = path.extname(filePath).toLowerCase()

  try {
    const speakers = await extractSpeakers(filePath)
    return NextResponse.json({ speakers, format: ext.slice(1) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
