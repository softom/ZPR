// Парсинг внешнего отчёта в plain text.
// Поддерживаемые форматы: .docx (mammoth), .txt / .md (как есть).
// .pdf — TODO (можно через pdfjs-dist/pdf-parse если понадобится).

import mammoth from 'mammoth'

export async function parseExternalDoc(file: Buffer, filename: string): Promise<string> {
  const lower = filename.toLowerCase()

  if (lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file })
    return result.value.trim()
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    return file.toString('utf-8').trim()
  }

  throw new Error(`Неподдерживаемый формат файла: ${filename}. Поддерживаются .docx, .txt, .md`)
}
