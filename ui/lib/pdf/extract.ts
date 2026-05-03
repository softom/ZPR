'use client'

/**
 * Чтение текста из PDF на клиенте через pdfjs-dist.
 * Каждая страница помечается маркером [PAGE N] в `fullText`,
 * чтобы LLM мог сослаться на номер страницы в `source_page`.
 *
 * Используется в модуле A (Загрузчик договора, /contracts/new).
 */

export interface PdfText {
  fullText: string
  pages: Array<{ page: number; text: string }>
  numPages: number
}

export async function extractTextFromPdf(file: File): Promise<PdfText> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  const pages: Array<{ page: number; text: string }> = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .map(item => ('str' in item ? item.str : ''))
      .join(' ')
    pages.push({ page: i, text: pageText })
  }

  const fullText = pages
    .map(p => `[PAGE ${p.page}]\n${p.text}`)
    .join('\n\n')

  return { fullText, pages, numPages: pdf.numPages }
}
