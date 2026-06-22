import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'
import { formatPeriodPhrase, periodKindWord, type PeriodType } from './periodHelpers'
import { formatScopeLabel } from './scopeLabel'

type ReportRow = {
  period_type: 'week' | 'month' | 'control' | 'short' | 'contract'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  summary_md: string | null
}

type ContractForDocx = {
  doc_number: string | null
  signed_date: string | null
  title: string
  type: string
  contractor_name: string | null
  current_stage_name: string | null
  current_stage_number: number | null
}

type SectionRow = {
  object_id: string
  project_movement: string | null
  achievements: string | null
  achievements_list: string | null
  next_period_tasks: string | null
  next_period_tasks_list: string | null
  risks: string | null
  // week v3:
  weekly_done_brief?: string | null
  weekly_topics_brief?: string | null
  weekly_upcoming_brief?: string | null
  // подтянутые договоры объекта (для week — блок «Заключённые договоры»)
  contracts?: ContractForDocx[]
  object: { code: string; current_name: string } | null
}

// Генератор .docx для отчёта-среза. Каждая секция объекта — на своей странице
// (через page break перед следующим объектом) с 4 подразделами.
export async function generateReportDocx(report: ReportRow, sections: SectionRow[]): Promise<Buffer> {
  const phrase = formatPeriodPhrase(new Date(report.period_start), new Date(report.period_end), report.period_type as PeriodType)
  const scopeObjects = sections
    .map((s) => s.object ? { id: s.object_id, code: s.object.code, current_name: s.object.current_name } : null)
    .filter((x): x is { id: string; code: string; current_name: string } => Boolean(x))
  const scopeLabel = formatScopeLabel(scopeObjects)

  const children: Paragraph[] = []

  // Шапка. Для week «еженедельный» опускаем — период бывает произвольным.
  const kindWord = report.period_type === 'week' ? '' : periodKindWord(report.period_type as PeriodType)
  children.push(new Paragraph({
    text: kindWord ? `Отчёт ${kindWord} за период ${phrase}` : `Отчёт за период ${phrase}`,
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
  }))
  children.push(new Paragraph({
    text: scopeLabel,
    heading: HeadingLevel.HEADING_2,
    alignment: AlignmentType.CENTER,
  }))
  if (report.title && report.title.trim().length > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: report.title, italics: true })],
      alignment: AlignmentType.CENTER,
    }))
  }
  children.push(new Paragraph({ text: '' }))

  // Общая сводка (если есть) — рендерим простой MD-парсер: ## заголовки + bullets
  if (report.summary_md && report.summary_md.trim().length > 0) {
    pushMarkdown(children, report.summary_md.trim())
    children.push(new Paragraph({ text: '' }))
  }

  let isFirst = true
  for (const s of sections) {
    if (!s.object) continue
    // Page break перед следующим объектом (кроме первого).
    // Отдельный пустой параграф с pageBreakBefore — самый надёжный способ:
    // работает в Word, LibreOffice, Google Docs (атрибут на heading иногда
    // игнорируется некоторыми рендерерами).
    if (!isFirst) {
      children.push(new Paragraph({ text: '', pageBreakBefore: true }))
    }
    children.push(new Paragraph({
      text: `${s.object.code} — ${s.object.current_name}`,
      heading: HeadingLevel.HEADING_2,
    }))
    isFirst = false

    if (report.period_type === 'week') {
      // Weekly v3 — те же поля, что в renderWeeklyV3Markdown и в UI карточке.
      pushWeeklySection(children, s)
    } else {
      // Legacy month-структура (6 полей).
      pushSubsection(children, '1. Существующее движение проекта', s.project_movement)

      children.push(new Paragraph({
        text: '2. Достижения за период',
        heading: HeadingLevel.HEADING_3,
      }))
      pushSubsection(children, '2.1 Описание', s.achievements, HeadingLevel.HEADING_4)
      pushSubsection(children, '2.2 Основные пункты', s.achievements_list, HeadingLevel.HEADING_4)

      children.push(new Paragraph({
        text: '3. Задачи наступающего периода',
        heading: HeadingLevel.HEADING_3,
      }))
      pushSubsection(children, '3.1 Описание', s.next_period_tasks, HeadingLevel.HEADING_4)
      pushSubsection(children, '3.2 Основные пункты', s.next_period_tasks_list, HeadingLevel.HEADING_4)

      pushSubsection(children, '4. Риски', s.risks)
    }
  }

  const doc = new Document({
    sections: [{ children }],
  })
  return Packer.toBuffer(doc)
}

// Рендер недельной секции (Weekly v3): договоры → движение → ✓ Выполнено →
// темы (курсивом) → 🔜 Предстоит. Зеркалит renderWeeklyV3Markdown в render/route.ts.
function pushWeeklySection(children: Paragraph[], s: SectionRow): void {
  // Заключённые договоры по объекту (если подтянуты)
  if (s.contracts && s.contracts.length > 0) {
    children.push(new Paragraph({ text: 'Заключённые договоры по объекту', heading: HeadingLevel.HEADING_3 }))
    for (const c of s.contracts) {
      const numPart = c.doc_number ? `№ ${c.doc_number}` : ''
      const datePart = c.signed_date ? `от ${formatDateRu(c.signed_date)}` : ''
      const head = [c.type, numPart, datePart].filter(Boolean).join(' ')
      const contractor = c.contractor_name ?? '— подрядчик не указан —'
      children.push(new Paragraph({ text: `${head} с ${contractor}`, bullet: { level: 0 } }))
      if (c.current_stage_name) {
        const num = c.current_stage_number ? `Этап ${c.current_stage_number} — ` : ''
        children.push(new Paragraph({ text: `Текущий этап: ${num}${c.current_stage_name}`, bullet: { level: 1 } }))
      }
    }
    children.push(new Paragraph({ text: '' }))
  }

  // Движение проекта за период (показываем всегда)
  pushSubsection(children, 'Движение проекта за период', s.project_movement)

  // ✓ Выполнено / зафиксировано (только если есть)
  const done = s.weekly_done_brief?.trim() ?? ''
  if (done) pushSubsection(children, '✓ Выполнено / зафиксировано за период', done)

  // Темы собраний — курсивом, без заголовка (как в .md)
  const topics = s.weekly_topics_brief?.trim() ?? ''
  if (topics) {
    children.push(new Paragraph({ children: [new TextRun({ text: topics, italics: true })] }))
    children.push(new Paragraph({ text: '' }))
  }

  // 🔜 Предстоит (только если есть)
  const upcoming = s.weekly_upcoming_brief?.trim() ?? ''
  if (upcoming) pushSubsection(children, '🔜 Предстоит', upcoming)
}

function formatDateRu(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch {
    return iso
  }
}

// Простой MD → docx: заголовки (## / ###), маркированные списки (- ), параграфы.
// Inline **bold** не парсим — для отчётов достаточно структуры.
function pushMarkdown(children: Paragraph[], md: string): void {
  const lines = md.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      children.push(new Paragraph({ text: '' }))
      continue
    }
    if (line.startsWith('### ')) {
      children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }))
    } else if (line.startsWith('## ')) {
      children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }))
    } else if (line.startsWith('# ')) {
      children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }))
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      children.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }))
    } else {
      children.push(new Paragraph({ text: line }))
    }
  }
}

function pushSubsection(
  children: Paragraph[],
  title: string,
  text: string | null,
  heading: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_3,
): void {
  children.push(new Paragraph({
    text: title,
    heading,
  }))
  const trimmed = text?.trim() ?? ''
  if (trimmed) {
    // Разбираем содержимое: строки `- ` / `* ` → bullets, пустая строка →
    // разделитель абзацев, остальное → обычный текст. Многострочные пункты
    // списков (без `- `) клеятся к предыдущему bullet/абзацу.
    const lines = trimmed.split('\n')
    let buffer: string[] = []
    let bufferIsBullet = false

    const flush = () => {
      if (buffer.length === 0) return
      const text = buffer.join(' ')
      if (bufferIsBullet) {
        children.push(new Paragraph({ text, bullet: { level: 0 } }))
      } else {
        children.push(new Paragraph({ text }))
      }
      buffer = []
      bufferIsBullet = false
    }

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) { flush(); continue }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        flush()
        buffer.push(line.slice(2))
        bufferIsBullet = true
      } else {
        buffer.push(line)
      }
    }
    flush()
  } else {
    children.push(new Paragraph({
      children: [new TextRun({ text: '— не заполнено —', italics: true, color: '999999' })],
    }))
  }
  children.push(new Paragraph({ text: '' }))
}
