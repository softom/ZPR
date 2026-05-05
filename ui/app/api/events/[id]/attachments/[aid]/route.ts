import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { eventAbsPath } from '@/lib/event-storage'

// GET — отдаёт файл (download)
export async function GET(
  _: NextRequest,
  ctx: { params: Promise<{ id: string; aid: string }> }
) {
  const { aid } = await ctx.params
  const { data, error } = await supabaseAdmin
    .from('event_attachments')
    .select('file_path, file_name, mime_type')
    .eq('id', aid)
    .maybeSingle()
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Файл не найден' }, { status: 404 })
  }
  try {
    const absPath = eventAbsPath(data.file_path)
    const buf = await fs.readFile(absPath)
    return new NextResponse(buf as unknown as BodyInit, {
      headers: {
        'Content-Type': data.mime_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(data.file_name)}"`,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Файл недоступен: ${msg}` }, { status: 500 })
  }
}

// DELETE — удаляет файл с диска и БД-запись
export async function DELETE(
  _: NextRequest,
  ctx: { params: Promise<{ id: string; aid: string }> }
) {
  const { aid } = await ctx.params
  const { data, error } = await supabaseAdmin
    .from('event_attachments')
    .select('file_path')
    .eq('id', aid)
    .maybeSingle()
  if (error || !data) {
    return NextResponse.json({ error: error?.message || 'Не найдено' }, { status: 404 })
  }
  try { await fs.unlink(eventAbsPath(data.file_path)) } catch {}
  const { error: delErr } = await supabaseAdmin
    .from('event_attachments')
    .delete()
    .eq('id', aid)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
