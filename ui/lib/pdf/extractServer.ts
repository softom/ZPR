/**
 * Серверное извлечение текста из PDF (для /api/contracts/v2/[id]/reparse и подобных).
 *
 * Формат вывода совместим с клиентским `ui/lib/pdf/extract.ts`:
 * `fullText` содержит маркеры `[PAGE N]\n` перед каждой страницей — LLM использует
 * их, чтобы заполнить `source_page` в каждом `ClauseInfo`.
 *
 * Реализовано через pdf-parse v2 (класс PDFParse, метод getText() с per-page разбиением).
 */

import { PDFParse } from 'pdf-parse'

export interface ServerPdfText {
  fullText: string
  numPages: number
}

export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<ServerPdfText> {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    const fullText = result.pages
      .map(p => `[PAGE ${p.num}]\n${p.text}`)
      .join('\n\n')
    return { fullText, numPages: result.total }
  } finally {
    await parser.destroy()
  }
}
