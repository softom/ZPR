import { NextRequest, NextResponse } from 'next/server'
import { parseExternalDoc } from '@/lib/reports/parseExternalDoc'
import { runExternalCheck, resultToMarkdown } from '@/lib/reports/checkExternalDoc'

// LLM-вызовы могут занять много времени (split + N×check)
export const maxDuration = 300

// POST /api/reports/external-check
// multipart/form-data: file=<docx|txt|md>
// Query: ?format=json (default) | md — формат ответа
//
// JSON: { result: ExternalCheckResult, md: string }
// MD:   raw text/markdown (для скачивания)
export async function POST(request: NextRequest) {
  const url = new URL(request.url)
  const format = url.searchParams.get('format') ?? 'json'

  let fd: FormData
  try {
    fd = await request.formData()
  } catch {
    return NextResponse.json({ error: 'multipart/form-data ожидается' }, { status: 400 })
  }
  const file = fd.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Файл (поле "file") отсутствует' }, { status: 400 })
  }

  let text: string
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    text = await parseExternalDoc(buf, file.name)
  } catch (e) {
    return NextResponse.json({ error: `Парсинг: ${(e as Error).message}` }, { status: 400 })
  }

  if (text.trim().length < 50) {
    return NextResponse.json({ error: 'Текст документа слишком короткий или пустой' }, { status: 422 })
  }

  let result
  try {
    result = await runExternalCheck(text, file.name)
  } catch (e) {
    return NextResponse.json({ error: `Проверка LLM: ${(e as Error).message}` }, { status: 500 })
  }

  const md = resultToMarkdown(result)

  if (format === 'md') {
    return new NextResponse(md, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name.replace(/\.[^.]+$/, '') + '_проверка.md')}`,
      },
    })
  }

  return NextResponse.json({ result, md })
}
