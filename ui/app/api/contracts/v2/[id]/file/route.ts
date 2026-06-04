/**
 * GET /api/contracts/v2/[id]/file
 *
 * Стриминг файла договора из хранилища. Использует `findContractFile` для выбора
 * приоритетного PDF в папке (по folder_path договора). Отдаёт inline — браузер
 * показывает PDF в своей встроенной читалке.
 *
 * Используется кнопкой «📄 Просмотреть договор» на карточке договора.
 *
 * Query params (опц.):
 *   - download=1 — отдать с `Content-Disposition: attachment` (скачать как файл)
 *                   вместо inline-просмотра.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findContractFile } from '@/lib/contracts/findContractFile'

function mimeFromExt(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'pdf':  return 'application/pdf'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'doc':  return 'application/msword'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'xls':  return 'application/vnd.ms-excel'
    default:     return 'application/octet-stream'
  }
}

/**
 * Кодирует имя файла для Content-Disposition по RFC 5987 — поддерживает
 * кириллицу в браузерах. `filename="..."` + `filename*=UTF-8'...`.
 */
function buildContentDisposition(filename: string, attachment: boolean): string {
  const disposition = attachment ? 'attachment' : 'inline'
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
  const utf8 = encodeURIComponent(filename)
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${utf8}`
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const url = new URL(request.url)
    const asAttachment = url.searchParams.get('download') === '1'

    const { data: doc, error: dErr } = await supabaseAdmin
      .from('documents')
      .select('id, folder_path, title')
      .eq('id', id)
      .maybeSingle()
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
    if (!doc) return NextResponse.json({ error: 'Договор не найден' }, { status: 404 })
    if (!doc.folder_path) {
      return NextResponse.json({ error: 'У договора нет folder_path — файл недоступен' }, { status: 400 })
    }

    const filePath = await findContractFile(doc.folder_path)
    if (!filePath) {
      return NextResponse.json(
        { error: `PDF не найден в папке договора: ${doc.folder_path}` },
        { status: 404 },
      )
    }

    let fileSize = 0
    try {
      const s = await stat(filePath)
      fileSize = s.size
    } catch {
      // не критично
    }

    const buffer = await readFile(filePath)
    const filename = path.basename(filePath)
    const mime = mimeFromExt(filename)

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':        mime,
        'Content-Length':      fileSize ? String(fileSize) : String(buffer.byteLength),
        'Content-Disposition': buildContentDisposition(filename, asAttachment),
        // Кэшируем коротко — операторы редко перезагружают тот же договор подряд,
        // но при апдейте файла обновление должно подтянуться без перезагрузки страницы.
        'Cache-Control': 'private, max-age=60',
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[v2/file]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
