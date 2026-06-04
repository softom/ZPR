/**
 * Генерация .docx-файла «финального документа» по стратегической теме.
 *
 * На вход — снапшот из published-ревизии (поля темы на момент фиксации) +
 * метаданные (кто/когда зафиксировал, кто автор ревизии).
 *
 * Использует тот же пакет `docx`, что и отчёты — `ui/lib/reports/generateReportDocx.ts`.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx'

const CATEGORY_LABEL: Record<string, string> = {
  environment:  'Средовое проектирование',
  engineering:  'Инженерное',
  land_legal:   'Земельно-правовое',
  organization: 'Организационное',
  personnel:    'Кадровое',
  contracting:  'Договорное',
}

const STATUS_LABEL: Record<string, string> = {
  open:         'Открыта',
  in_progress:  'В работе',
  mitigated:    'Купирована',
  resolved:     'Закрыта',
  cancelled:    'Отменена',
}

export type TopicDocSnapshot = {
  seq: number
  title: string
  category: string
  status: string
  synopsis: string
  threats: string
  solutions: string | null
  deadlines: string | null
  owner_name: string | null
  source_quote: string | null

  published_at: string | null     // ISO-строка
  published_by_email: string | null
  author_email: string | null     // автор ревизии
  revision_created_at: string | null
}

export async function generateTopicDocx(snap: TopicDocSnapshot): Promise<Buffer> {
  const children: Paragraph[] = []

  // Шапка: 001 Название
  const seqStr = String(snap.seq).padStart(3, '0')
  children.push(new Paragraph({
    text: `№ ${seqStr}. ${snap.title}`,
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
  }))

  // Метаданные
  children.push(new Paragraph({
    children: [
      new TextRun({ text: 'Категория: ', bold: true }),
      new TextRun({ text: CATEGORY_LABEL[snap.category] ?? snap.category }),
      new TextRun({ text: '   Статус: ', bold: true }),
      new TextRun({ text: STATUS_LABEL[snap.status] ?? snap.status }),
    ],
    alignment: AlignmentType.CENTER,
  }))

  if (snap.owner_name) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: 'Владелец: ', bold: true }),
        new TextRun({ text: snap.owner_name }),
      ],
      alignment: AlignmentType.CENTER,
    }))
  }
  children.push(new Paragraph({ text: '' }))

  // Синопсис
  pushSection(children, 'Синопсис', snap.synopsis)

  // Угрозы
  pushSection(children, 'Угрозы', snap.threats)

  // Решения
  if (snap.solutions && snap.solutions.trim().length > 0) {
    pushSection(children, 'Решения', snap.solutions)
  }

  // Сроки
  if (snap.deadlines && snap.deadlines.trim().length > 0) {
    pushSection(children, 'Сроки и контрольные точки', snap.deadlines)
  }

  // Источник
  if (snap.source_quote && snap.source_quote.trim().length > 0) {
    children.push(new Paragraph({
      text: 'Источник',
      heading: HeadingLevel.HEADING_2,
    }))
    pushText(children, snap.source_quote)
  }

  // Подвал: подписи
  children.push(new Paragraph({ text: '' }))
  children.push(new Paragraph({
    text: '— — —',
    alignment: AlignmentType.CENTER,
  }))
  if (snap.author_email && snap.revision_created_at) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: 'Автор ревизии: ', italics: true }),
        new TextRun({ text: `${snap.author_email}, ${fmtDate(snap.revision_created_at)}`, italics: true }),
      ],
      alignment: AlignmentType.CENTER,
    }))
  }
  if (snap.published_by_email && snap.published_at) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: 'Зафиксировано: ', italics: true }),
        new TextRun({ text: `${snap.published_by_email}, ${fmtDate(snap.published_at)}`, italics: true }),
      ],
      alignment: AlignmentType.CENTER,
    }))
  }

  const doc = new Document({
    sections: [{ children }],
  })

  return Packer.toBuffer(doc)
}

function pushSection(children: Paragraph[], heading: string, body: string): void {
  children.push(new Paragraph({
    text: heading,
    heading: HeadingLevel.HEADING_2,
  }))
  pushText(children, body)
  children.push(new Paragraph({ text: '' }))
}

// Простой парсер: пустые строки — разделитель абзацев; строки, начинающиеся
// с «- »/«• »/«* », — пункты маркированного списка.
function pushText(children: Paragraph[], text: string): void {
  const lines = text.split('\n')
  let buffer: string[] = []
  const flush = () => {
    if (buffer.length === 0) return
    children.push(new Paragraph({ text: buffer.join(' ') }))
    buffer = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      flush()
      continue
    }
    const bullet = /^[-•*]\s+(.*)$/.exec(line)
    if (bullet) {
      flush()
      children.push(new Paragraph({
        text: bullet[1],
        bullet: { level: 0 },
      }))
      continue
    }
    buffer.push(line)
  }
  flush()
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}
