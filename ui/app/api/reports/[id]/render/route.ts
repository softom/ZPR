import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateReportDocx } from '@/lib/reports/generateReportDocx'
import { formatPeriodPhrase, periodKindWord, type PeriodType } from '@/lib/reports/periodHelpers'
import { formatScopeLabel } from '@/lib/reports/scopeLabel'

// GET /api/reports/[id]/render?format=md|docx
// Финальный отчёт: общая шапка + страницы по объектам с 4 разделами.
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const url = new URL(request.url)
  const format = (url.searchParams.get('format') ?? 'md').toLowerCase()
  if (!['md', 'docx'].includes(format)) {
    return NextResponse.json({ error: 'format должен быть md|docx' }, { status: 400 })
  }

  const [reportRes, sectionsRes, objectsRes] = await Promise.all([
    supabaseAdmin.from('reports').select('*').eq('id', id).single(),
    supabaseAdmin
      .from('object_reports')
      .select('*')
      .eq('report_id', id),
    supabaseAdmin.from('objects').select('id, code, current_name'),
  ])
  if (reportRes.error || !reportRes.data) {
    return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  }

  const objectsById = new Map<string, { code: string; current_name: string }>()
  for (const o of objectsRes.data ?? []) {
    objectsById.set(o.id, { code: o.code, current_name: o.current_name })
  }
  const sections = (sectionsRes.data ?? [])
    .map((s) => ({ ...s, object: objectsById.get(s.object_id) ?? null }))
    .sort((a, b) => (a.object?.code ?? '').localeCompare(b.object?.code ?? ''))

  const filenameBase = `Отчёт_${reportRes.data.period_type}_${reportRes.data.period_start}`

  if (format === 'docx') {
    const buf = await generateReportDocx(reportRes.data, sections)
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filenameBase)}.docx`,
      },
    })
  }

  // md
  const md = renderMarkdown(reportRes.data, sections)
  return new NextResponse(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filenameBase)}.md`,
    },
  })
}

type ReportRow = {
  period_type: 'week' | 'month'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  summary_md: string | null
}

type SectionRow = {
  object_id: string
  project_movement: string | null
  achievements: string | null
  achievements_list: string | null
  next_period_tasks: string | null
  next_period_tasks_list: string | null
  risks: string | null
  object: { code: string; current_name: string } | null
}

function renderMarkdown(report: ReportRow, sections: SectionRow[]): string {
  const lines: string[] = []

  // Расширенный титул:
  //   # Отчёт еженедельный за период с 13 по 19 мая 2026 года
  //   ## По комплексу объектов: Золотые Пески России
  const phrase = formatPeriodPhrase(new Date(report.period_start), new Date(report.period_end), report.period_type as PeriodType)
  const scopeObjects = sections
    .map((s) => s.object ? { id: s.object_id, code: s.object.code, current_name: s.object.current_name } : null)
    .filter((x): x is { id: string; code: string; current_name: string } => Boolean(x))
  const scopeLabel = formatScopeLabel(scopeObjects)

  lines.push(`# Отчёт ${periodKindWord(report.period_type as PeriodType)} за период ${phrase}`, '')
  lines.push(`## ${scopeLabel}`, '')
  if (report.title && report.title.trim().length > 0) lines.push(`*${report.title}*`, '')
  lines.push('---', '')

  if (report.summary_md && report.summary_md.trim().length > 0) {
    lines.push(report.summary_md.trim(), '', '---', '')
  }

  for (const s of sections) {
    if (!s.object) continue
    lines.push(`## ${s.object.code} — ${s.object.current_name}`, '')

    lines.push(`### 1. Существующее движение проекта`, '')
    lines.push(s.project_movement?.trim() || '*— не заполнено —*', '')

    lines.push(`### 2. Достижения за период`, '')
    lines.push(`#### 2.1 Описание`, '')
    lines.push(s.achievements?.trim() || '*— не заполнено —*', '')
    lines.push(`#### 2.2 Основные пункты`, '')
    lines.push(s.achievements_list?.trim() || '*— не заполнено —*', '')

    lines.push(`### 3. Задачи наступающего периода`, '')
    lines.push(`#### 3.1 Описание`, '')
    lines.push(s.next_period_tasks?.trim() || '*— не заполнено —*', '')
    lines.push(`#### 3.2 Основные пункты`, '')
    lines.push(s.next_period_tasks_list?.trim() || '*— не заполнено —*', '')

    lines.push(`### 4. Риски`, '')
    lines.push(s.risks?.trim() || '*— не заполнено —*', '')

    lines.push('---', '')
  }

  return lines.join('\n') + '\n'
}
