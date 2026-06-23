/**
 * GET /api/schedule/export
 *
 * Генерирует MS Project XML (MSPDI) из текущего состояния calendar_entries
 * и отдаёт как application/xml файл (Content-Disposition: attachment).
 *
 * Query-параметры:
 *   objectField  — 'Text1' (default) | 'Notes' | 'Text2'..'Text30'
 *   projectName  — имя проекта в шапке XML (default 'ZPR_Schedule')
 */

import { NextRequest, NextResponse } from 'next/server'
import { exportMspdiXml } from '@/lib/schedule/exportMspdi'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  // НЕ ставим 'Text1' по умолчанию — иначе перебивает object_field версии (Текст15).
  const objectField = url.searchParams.get('objectField') ?? undefined
  const projectName = url.searchParams.get('projectName') ?? 'ZPR_Schedule'
  const versionId = url.searchParams.get('versionId') ?? null

  try {
    const xml = await exportMspdiXml({ objectField, projectName, versionId })
    const date = new Date().toISOString().slice(0, 10)
    const fileName = `ZPR_Schedule_${date}.xml`
    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    })
  } catch (e) {
    console.error('[schedule/export] failed', e)
    return NextResponse.json(
      { error: `Экспорт упал: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}
