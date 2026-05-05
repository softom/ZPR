/**
 * Серверный генератор .docx для «Резюме встречи».
 *
 * Источник — `meetings.summary_md` (правится пользователем после
 * /api/protocols/[id]/summary/generate). Конвертирует MD в Word
 * минимальным набором: # / ## заголовки → Heading, `**bold**` → bold run,
 * `- bullet` → list item.
 *
 * Намеренно без полной реализации Markdown — только то, что генерируется
 * нашим LLM-промптом. Если пользователь добавит таблицы или код — они
 * выйдут моноширинно как простой текст.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx'
import { supabaseAdmin } from '@/lib/supabase-admin'

function ddmmyyyy(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

/** Один абзац с inline `**bold**` поддержкой. */
function paragraph(
  text: string,
  opts: { bullet?: number; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel] } = {},
): Paragraph {
  // Парсим **bold**
  const runs: TextRun[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), size: 22 }))
    runs.push(new TextRun({ text: m[1], bold: true, size: 22 }))
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), size: 22 }))
  if (runs.length === 0) runs.push(new TextRun({ text, size: 22 }))

  return new Paragraph({
    children: runs,
    heading: opts.heading,
    bullet: opts.bullet !== undefined ? { level: opts.bullet } : undefined,
    spacing: { before: opts.heading ? 200 : 0, after: opts.heading ? 100 : 60 },
  })
}

function mdToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = []
  const lines = md.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      out.push(new Paragraph({ children: [new TextRun({ text: '', size: 22 })] }))
      continue
    }
    if (line.startsWith('# ')) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: line.slice(2).trim(), bold: true, size: 28 })],
        }),
      )
      continue
    }
    if (line.startsWith('## ')) {
      out.push(paragraph(line.slice(3).trim(), { heading: HeadingLevel.HEADING_2 }))
      continue
    }
    if (line.startsWith('### ')) {
      out.push(paragraph(line.slice(4).trim(), { heading: HeadingLevel.HEADING_3 }))
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      out.push(paragraph(line.replace(/^[-*]\s+/, ''), { bullet: 0 }))
      continue
    }
    out.push(paragraph(line))
  }
  return out
}

export async function generateSummaryDocx(meetingId: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin
    .from('meetings')
    .select('summary_md, meeting_date, code, title')
    .eq('id', meetingId)
    .single()
  if (error || !data) throw new Error(`Собрание не найдено: ${error?.message ?? 'unknown'}`)
  if (!data.summary_md) {
    throw new Error('Резюме не сформировано — нажмите «Сформировать резюме»')
  }

  const children = mdToParagraphs(data.summary_md as string)

  // Подвал
  children.push(new Paragraph({ children: [new TextRun({ text: '', size: 22 })] }))
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Сформировано: ${ddmmyyyy(new Date().toISOString().slice(0, 10))}`,
          italics: true,
          size: 20,
        }),
      ],
    }),
  )

  const doc = new Document({
    creator: 'ЗПР Protocol Generator',
    title: `Резюме ${ddmmyyyy(data.meeting_date as string)}`,
    sections: [{ children }],
  })
  return await Packer.toBuffer(doc)
}
