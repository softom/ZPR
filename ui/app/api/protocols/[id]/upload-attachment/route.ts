/**
 * POST /api/protocols/[id]/upload-attachment
 *
 * Загружает файл-вложение к собранию (видеозапись / материал / прочее)
 * в ту же папку что транскрипция: STORAGE_DIR\{meeting.folder_path}\{filename}.
 *
 * Запись в meeting_attachments. Для kind='material' планируется индексация
 * в pgvector (lib/vector/indexDocument.ts) — TODO: интегрировать.
 *
 * Принимает FormData:
 *   - file: File
 *   - kind: 'video' | 'material' | 'other'
 *   - note?: string
 */

import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export const maxDuration = 60

function sanitizeForFs(s: string): string {
  return s
    .replace(/[*?:"<>|\\/«»—–]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 200)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings')
    .select('id, folder_path, meeting_date, title')
    .eq('id', id)
    .single()
  if (mErr || !meeting) {
    return NextResponse.json({ error: 'Собрание не найдено' }, { status: 404 })
  }

  // Если нет folder_path — генерируем как при upload-transcription
  let folderRel = meeting.folder_path as string | null
  if (!folderRel) {
    const dateUnderscored = (meeting.meeting_date as string).replace(/-/g, '_')
    const sanitized = sanitizeForFs(meeting.title as string) || 'Без_названия'
    folderRel = path.join('ПРОТОКОЛЫ', `${dateUnderscored}_${sanitized}`).replace(/\\/g, '/')
    await supabaseAdmin.from('meetings').update({ folder_path: folderRel }).eq('id', id)
  }

  const targetDir = path.join(STORAGE_DIR, folderRel.replace(/\//g, path.sep))
  try {
    await mkdir(targetDir, { recursive: true })
  } catch (e) {
    return NextResponse.json({ error: `mkdir: ${e}` }, { status: 500 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const kindRaw = (formData.get('kind') as string | null) ?? 'other'
  const note = (formData.get('note') as string | null) ?? null

  if (!file) {
    return NextResponse.json({ error: 'Файл не передан (поле "file")' }, { status: 400 })
  }
  const kind = ['video', 'material', 'other'].includes(kindRaw) ? kindRaw : 'other'

  const ext = path.extname(file.name)
  const baseName = sanitizeForFs(path.basename(file.name, ext))
  const safeName = `${baseName}${ext}`
  const dest = path.join(targetDir, safeName)

  try {
    const bytes = await file.arrayBuffer()
    await writeFile(dest, Buffer.from(bytes))
  } catch (e) {
    return NextResponse.json({ error: `writeFile: ${e}` }, { status: 500 })
  }

  const fileRel = `${folderRel}/${safeName}`
  const { data: inserted, error: iErr } = await supabaseAdmin
    .from('meeting_attachments')
    .insert({
      meeting_id: id,
      kind,
      file_path: fileRel,
      filename: file.name,
      size_bytes: file.size,
      content_type: file.type || null,
      note,
    })
    .select('id')
    .single()

  if (iErr) {
    return NextResponse.json(
      { error: `Файл сохранён, но запись не создана: ${iErr.message}` },
      { status: 500 },
    )
  }

  // TODO: для kind='material' запустить асинхронную индексацию в pgvector
  // через lib/vector/indexDocument.ts. Сейчас оставляем indexed_at=null.

  return NextResponse.json({
    ok: true,
    id: inserted?.id,
    file_path: fileRel,
    saved_name: safeName,
    size: file.size,
    kind,
  })
}
