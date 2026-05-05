/**
 * DELETE /api/protocols/[id]/attachments/[aid]
 *
 * Удаляет вложение: запись в БД + файл на диске.
 */

import { NextRequest, NextResponse } from 'next/server'
import { unlink } from 'fs/promises'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; aid: string }> },
) {
  const { id, aid } = await params

  const { data: att, error: e1 } = await supabaseAdmin
    .from('meeting_attachments')
    .select('id, file_path')
    .eq('id', aid)
    .eq('meeting_id', id)
    .single()
  if (e1 || !att) {
    return NextResponse.json({ error: 'Вложение не найдено' }, { status: 404 })
  }

  // Удаляем файл (best-effort — даже если файла уже нет, удаляем запись)
  try {
    const abs = path.join(STORAGE_DIR, (att.file_path as string).replace(/\//g, path.sep))
    await unlink(abs)
  } catch (e) {
    console.warn('attachment file unlink failed:', e)
  }

  const { error: e2 } = await supabaseAdmin
    .from('meeting_attachments')
    .delete()
    .eq('id', aid)
    .eq('meeting_id', id)

  if (e2) {
    return NextResponse.json({ error: e2.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
