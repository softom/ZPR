/**
 * POST /api/schedule/import
 *
 * Принимает MS Project XML (MSPDI) и импортирует его в calendar_entries.
 *
 * Тело запроса — multipart/form-data:
 *   file:         File (.xml)
 *   objectField:  string  (опц., 'Notes' | 'Text1'..'Text30', default 'Notes')
 *   notes:        string  (опц., произвольный комментарий к импорту)
 *
 * Ответ:
 *   { importId, stats: {...}, unmapped: [...], unknownRawTexts: [...] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { importMspdiXml } from '@/lib/schedule/importMspdi'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(request: NextRequest) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch (e) {
    return NextResponse.json({ error: `Не удалось прочитать multipart: ${e}` }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Файл .xml обязателен (поле "file")' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Файл пустой' }, { status: 400 })
  }

  const objectField = (formData.get('objectField') as string | null) ?? 'Notes'
  const notes = (formData.get('notes') as string | null) ?? null
  const versionName = (formData.get('versionName') as string | null) ?? null
  const modeRaw = (formData.get('mode') as string | null) ?? 'replace'
  const mode: 'replace' | 'metadata-only' = modeRaw === 'metadata-only' ? 'metadata-only' : 'replace'

  let xml: string
  try {
    xml = await file.text()
  } catch (e) {
    return NextResponse.json({ error: `Не удалось прочитать содержимое файла: ${e}` }, { status: 400 })
  }

  if (!xml.includes('<Project') && !xml.includes('<project')) {
    return NextResponse.json(
      { error: 'Файл не похож на MS Project XML (MSPDI). Ожидался корневой элемент <Project>.' },
      { status: 400 },
    )
  }

  console.log(`[schedule/import] file=${file.name} size=${file.size} objectField=${objectField} mode=${mode} versionName=${versionName ?? '—'}`)

  try {
    const result = await importMspdiXml({
      xml,
      fileName: file.name,
      fileSize: file.size,
      objectField,
      notes,
      versionName,
      mode,
    })
    console.log(
      `[schedule/import] importId=${result.importId} ` +
      `inserted=${result.stats.tasksInserted} updated=${result.stats.tasksUpdated} ` +
      `unmapped=${result.stats.tasksUnmapped} predecessors=${result.stats.predecessorsTotal}`,
    )
    return NextResponse.json(result)
  } catch (e) {
    console.error('[schedule/import] failed', e)
    return NextResponse.json(
      { error: `Импорт упал: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}
