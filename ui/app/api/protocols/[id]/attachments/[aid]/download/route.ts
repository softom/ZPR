/**
 * GET /api/protocols/[id]/attachments/[aid]/download
 *
 * Отдаёт файл-вложение собрания на скачивание. Файлы лежат не в Supabase
 * Storage, а на локальном диске: STORAGE_DIR\{file_path}. Поэтому читаем
 * напрямую с ФС и стримим в ответ (видео может быть ~100+ МБ — не грузим
 * целиком в память).
 *
 * Content-Disposition: attachment — браузер скачивает, а не открывает.
 * Имя файла в заголовке кодируем по RFC 5987 (filename*=UTF-8''…), иначе
 * кириллица («Евпатория_СОЛНЫШКО…pdf») ломается.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

// Мапа расширение → MIME для случаев, когда content_type в БД пуст.
const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
}

export const maxDuration = 300

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; aid: string }> },
) {
  const { id, aid } = await params

  const { data: att, error } = await supabaseAdmin
    .from('meeting_attachments')
    .select('id, file_path, filename, content_type')
    .eq('id', aid)
    .eq('meeting_id', id)
    .single()
  if (error || !att) {
    return NextResponse.json({ error: 'Вложение не найдено' }, { status: 404 })
  }

  // Абсолютный путь + защита от path traversal: итог должен лежать внутри STORAGE_DIR.
  const rel = (att.file_path as string).replace(/\//g, path.sep)
  const abs = path.resolve(STORAGE_DIR, rel)
  const root = path.resolve(STORAGE_DIR)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return NextResponse.json({ error: 'Недопустимый путь файла' }, { status: 400 })
  }

  let fileSize: number
  try {
    const s = await stat(abs)
    if (!s.isFile()) throw new Error('not a file')
    fileSize = s.size
  } catch {
    return NextResponse.json(
      { error: 'Файл отсутствует на диске (возможно, перемещён или удалён вручную).' },
      { status: 404 },
    )
  }

  const filename = (att.filename as string) || path.basename(abs)
  const ext = path.extname(abs).toLowerCase()
  const contentType =
    (att.content_type as string | null)?.trim() || EXT_MIME[ext] || 'application/octet-stream'

  // RFC 5987: ASCII-fallback + UTF-8-вариант с кириллицей.
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
  const utf8Name = encodeURIComponent(filename)

  const nodeStream = createReadStream(abs)
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

  return new Response(webStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  })
}
