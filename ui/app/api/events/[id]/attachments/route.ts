import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  eventStorageDir, eventRelPath, ensureDir,
  sanitizeFileName, detectKind,
} from '@/lib/event-storage'

// ─── GET: список вложений ─────────────────────────────────────────────────
export async function GET(
  _: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  const { data, error } = await supabaseAdmin
    .from('event_attachments')
    .select('*')
    .eq('event_id', id)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ attachments: data ?? [] })
}

// ─── POST: загрузка файла (multipart/form-data) ───────────────────────────
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params

  // Получаем событие — нужен fact_date или date_end для пути в YYYY/MM
  const { data: ev, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, fact_date, date_end, date_start')
    .eq('id', id)
    .maybeSingle()
  if (evErr || !ev) {
    return NextResponse.json({ error: evErr?.message || 'Событие не найдено' }, { status: 404 })
  }
  const refDate: string = ev.fact_date || ev.date_end || ev.date_start || new Date().toISOString().slice(0, 10)

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const kindOverride = (formData.get('kind') as string | null) || null
  if (!file) {
    return NextResponse.json({ error: 'Файл не передан' }, { status: 400 })
  }

  const fileName = sanitizeFileName(file.name)
  const dir = eventStorageDir(id, refDate)
  await ensureDir(dir)

  // Если файл с таким именем уже есть — добавляем суффикс с timestamp
  const targetName = await uniqueName(dir, fileName)
  const absPath = path.join(dir, targetName)
  const buffer = Buffer.from(await file.arrayBuffer())
  await fs.writeFile(absPath, buffer)

  const relPath = eventRelPath(id, refDate, targetName)
  const kind = kindOverride || detectKind(file.type || null, targetName)

  const { data, error } = await supabaseAdmin
    .from('event_attachments')
    .insert({
      event_id: id,
      kind,
      file_name: file.name,         // сохраняем оригинальное имя для UI
      file_path: relPath,
      file_size: buffer.byteLength,
      mime_type: file.type || null,
    })
    .select()
    .single()

  if (error) {
    // Удаляем файл если в БД не получилось
    try { await fs.unlink(absPath) } catch {}
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ attachment: data })
}

async function uniqueName(dir: string, fileName: string): Promise<string> {
  try {
    await fs.access(path.join(dir, fileName))
    // Файл существует — суффикс
    const dot = fileName.lastIndexOf('.')
    const base = dot > 0 ? fileName.slice(0, dot) : fileName
    const ext = dot > 0 ? fileName.slice(dot) : ''
    return `${base}_${Date.now()}${ext}`
  } catch {
    return fileName
  }
}
