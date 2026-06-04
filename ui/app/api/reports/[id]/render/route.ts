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
    supabaseAdmin.from('objects').select('id, code, current_name, aliases'),
  ])
  if (reportRes.error || !reportRes.data) {
    return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  }

  const objectsById = new Map<string, { code: string; current_name: string; aliases: string[] }>()
  for (const o of objectsRes.data ?? []) {
    let aliases: string[] = []
    const raw = (o as { aliases?: unknown }).aliases
    if (Array.isArray(raw)) {
      aliases = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    }
    objectsById.set(o.id, { code: o.code, current_name: o.current_name, aliases })
  }
  const sections = (sectionsRes.data ?? [])
    .map((s) => ({ ...s, object: objectsById.get(s.object_id) ?? null }))
    .sort((a, b) => {
      // Для control: сначала priority, потом secondary, потом null; внутри — по коду
      const pa = a.priority_group === 'priority' ? 0 : a.priority_group === 'secondary' ? 1 : 2
      const pb = b.priority_group === 'priority' ? 0 : b.priority_group === 'secondary' ? 1 : 2
      if (pa !== pb) return pa - pb
      return (a.object?.code ?? '').localeCompare(b.object?.code ?? '')
    })

  // Для week v3 и control — подтягиваем договоры объектов с текущим этапом
  // (нужны для блока «Сводка/Договоры» в обоих типах рендера).
  if (reportRes.data.period_type === 'week' || reportRes.data.period_type === 'control') {
    const objectCodes = sections.map((s) => s.object?.code).filter((c): c is string => Boolean(c))
    if (objectCodes.length > 0) {
      const docsRes = await supabaseAdmin
        .from('documents')
        .select(`
          id, type, title, doc_number, signed_date,
          contractor_entity_id,
          document_objects!inner(object_code)
        `)
        .in('document_objects.object_code', objectCodes)
        .order('signed_date', { ascending: false, nullsFirst: false })

      type DocRow = {
        id: string; type: string; title: string;
        doc_number: string | null; signed_date: string | null;
        contractor_entity_id: string | null;
        document_objects: Array<{ object_code: string }>;
      }
      const docs = (docsRes.data ?? []) as unknown as DocRow[]
      const docIds = docs.map((d) => d.id)

      const contractorIds = new Set<string>()
      for (const d of docs) {
        if (d.contractor_entity_id) contractorIds.add(d.contractor_entity_id)
      }

      // ВСЕ этапы — через view contract_stages_with_progress (для светофора done/current/upcoming)
      const [entRes, stRes] = await Promise.all([
        contractorIds.size > 0
          ? supabaseAdmin.from('legal_entities').select('id, name').in('id', [...contractorIds])
          : Promise.resolve({ data: [] }),
        docIds.length > 0
          ? supabaseAdmin
              .from('contract_stages_with_progress')
              .select('document_id, stage_number, stage_name, sort_order, is_current')
              .in('document_id', docIds)
              .order('sort_order', { ascending: true })
          : Promise.resolve({ data: [] }),
      ])
      const entById = new Map((entRes.data ?? []).map((e) => [e.id as string, e.name as string]))

      type StageRow = {
        document_id: string;
        stage_number: number; stage_name: string;
        sort_order: number; is_current: boolean;
      }
      const stagesByDocId = new Map<string, StageRow[]>()
      for (const s of (stRes.data ?? []) as StageRow[]) {
        if (!stagesByDocId.has(s.document_id)) stagesByDocId.set(s.document_id, [])
        stagesByDocId.get(s.document_id)!.push(s)
      }

      function computeStages(docId: string): ContractForRender['stages'] {
        const all = stagesByDocId.get(docId) ?? []
        if (all.length === 0) return []
        const current = all.find((s) => s.is_current)
        const currentSort = current?.sort_order ?? null
        return all.map((s) => {
          const status: 'done' | 'current' | 'upcoming' =
            currentSort === null ? 'upcoming'
            : s.is_current ? 'current'
            : s.sort_order < currentSort ? 'done'
            : 'upcoming'
          return {
            stage_number: s.stage_number,
            stage_name: s.stage_name,
            sort_order: s.sort_order,
            status,
          }
        })
      }

      // Группируем по object_code → ContractForRender[]
      const byObjectCode = new Map<string, ContractForRender[]>()
      for (const d of docs) {
        const codes = (d.document_objects ?? []).map((x) => x.object_code)
        const stages = computeStages(d.id) ?? []
        const current = stages.find((s) => s.status === 'current') ?? null
        const cfr: ContractForRender = {
          doc_number: d.doc_number,
          signed_date: d.signed_date,
          title: d.title,
          type: d.type,
          contractor_name: d.contractor_entity_id ? entById.get(d.contractor_entity_id) ?? null : null,
          current_stage_name: current?.stage_name ?? null,
          current_stage_number: current?.stage_number ?? null,
          stages,
        }
        for (const code of codes) {
          if (!byObjectCode.has(code)) byObjectCode.set(code, [])
          byObjectCode.get(code)!.push(cfr)
        }
      }
      for (const s of sections) {
        if (s.object?.code) {
          s.contracts = byObjectCode.get(s.object.code) ?? []
        }
      }
    }
  }

  const isControl = reportRes.data.period_type === 'control'
  const filenameBase = isControl
    ? `Справка_ТЗ_${reportRes.data.period_start}`
    : `Отчёт_${reportRes.data.period_type}_${reportRes.data.period_start}`

  if (format === 'docx') {
    // DOCX для control пока генерируется тем же путём, но с другой структурой
    const buf = await generateReportDocx(reportRes.data, sections)
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filenameBase)}.docx`,
      },
    })
  }

  // md
  const md = isControl
    ? renderControlMarkdown(reportRes.data, sections)
    : reportRes.data.period_type === 'week'
      ? renderWeeklyV3Markdown(reportRes.data, sections)
      : renderMarkdown(reportRes.data, sections)
  return new NextResponse(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filenameBase)}.md`,
    },
  })
}

type ReportRow = {
  period_type: 'week' | 'month' | 'control'
  period_start: string
  period_end: string
  title: string | null
  status: 'draft' | 'final'
  summary_md: string | null
  preamble: string | null
}

type SectionRow = {
  object_id: string
  // week/month:
  project_movement: string | null
  achievements: string | null
  achievements_list: string | null
  next_period_tasks: string | null
  next_period_tasks_list: string | null
  risks: string | null
  // weekly v3 (с 14.05.2026):
  weekly_done_brief: string | null
  weekly_topics_brief: string | null
  weekly_upcoming_brief: string | null
  // control:
  narrative: string | null
  contract_summary: string | null
  decisions: string | null
  priority_group: 'priority' | 'secondary' | null
  tep_deadline: string | null
  object: { code: string; current_name: string; aliases: string[] } | null
  // Договоры объекта с текущим этапом (подтягивается отдельным запросом для render)
  contracts?: ContractForRender[]
}

type ContractForRender = {
  doc_number: string | null
  signed_date: string | null
  title: string
  type: string
  contractor_name: string | null
  current_stage_name: string | null
  current_stage_number: number | null
  stages?: Array<{
    stage_number: number
    stage_name: string
    sort_order: number
    status: 'done' | 'current' | 'upcoming'
  }>
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

// Рендер Weekly v3 — структура по weekly_report_DRAFT.md v3:
//   Шапка → По каждому объекту: Договоры → 1 абзац движения →
//   ✓ Выполнено + темы (курсив) → 🔜 Предстоит.
function renderWeeklyV3Markdown(report: ReportRow, sections: SectionRow[]): string {
  const lines: string[] = []
  const periodPhrase = formatPeriodPhrase(
    new Date(report.period_start), new Date(report.period_end),
    report.period_type as PeriodType,
  )
  const scopeObjects = sections
    .map((s) => s.object ? { id: s.object_id, code: s.object.code, current_name: s.object.current_name } : null)
    .filter((x): x is { id: string; code: string; current_name: string } => Boolean(x))
  const scopeLabel = formatScopeLabel(scopeObjects)

  lines.push(`# Отчёт еженедельный за период ${periodPhrase}`, '')
  lines.push(`## ${scopeLabel}`, '')
  if (report.title && report.title.trim().length > 0) lines.push(`*${report.title}*`, '')
  lines.push('---', '')

  if (report.summary_md && report.summary_md.trim().length > 0) {
    lines.push(`## 📊 Общая сводка периода`, '')
    lines.push(report.summary_md.trim(), '', '---', '')
  }

  for (const s of sections) {
    if (!s.object) continue

    lines.push(`# ${s.object.code} — ${s.object.current_name}`, '')

    // Заключённые договоры по объекту
    lines.push(`### Заключённые договоры по объекту`, '')
    if (!s.contracts || s.contracts.length === 0) {
      lines.push(`> Договоры по объекту в БД не зарегистрированы.`, '')
    } else {
      for (const c of s.contracts) {
        const numPart = c.doc_number ? `№ ${c.doc_number}` : ''
        const datePart = c.signed_date ? `от ${formatDateRu(c.signed_date)}` : ''
        const contractorPart = c.contractor_name ?? '— подрядчик не указан —'
        const header = [`* **${c.type}**`, numPart, datePart].filter(Boolean).join(' ')
        lines.push(`${header} с **${contractorPart}**`)
        if (c.title && c.title !== `${c.type} ${numPart}`.trim()) {
          lines.push(`  * ${c.title}`)
        }
        if (c.current_stage_name) {
          const num = c.current_stage_number ? `Этап ${c.current_stage_number} — ` : ''
          lines.push(`  * **Текущий этап:** ${num}${c.current_stage_name}`)
        } else {
          lines.push(`  * Этап не определён.`)
        }
      }
      lines.push('')
    }

    // Движение проекта за неделю
    lines.push(`### Движение проекта за неделю`, '')
    lines.push(s.project_movement?.trim() || '*— не заполнено —*', '')

    // Ключевые события и задачи
    lines.push(`### Ключевые события и задачи`, '')

    if (s.weekly_done_brief && s.weekly_done_brief.trim().length > 0) {
      lines.push(`**✓ Выполнено / зафиксировано за неделю:**`, '')
      lines.push(s.weekly_done_brief.trim(), '')
    }

    if (s.weekly_topics_brief && s.weekly_topics_brief.trim().length > 0) {
      lines.push(`_${s.weekly_topics_brief.trim()}_`, '')
    }

    if (s.weekly_upcoming_brief && s.weekly_upcoming_brief.trim().length > 0) {
      lines.push(`**🔜 Предстоит:**`, '')
      lines.push(s.weekly_upcoming_brief.trim(), '')
    }

    if (!s.weekly_done_brief && !s.weekly_topics_brief && !s.weekly_upcoming_brief) {
      lines.push(`*— раздел не заполнен —*`, '')
    }

    lines.push('---', '')
  }

  return lines.join('\n') + '\n'
}

function formatDateRu(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch {
    return iso
  }
}

// Рендер control-отчёта (Справка ТЗ).
function renderControlMarkdown(report: ReportRow, sections: SectionRow[]): string {
  const lines: string[] = []
  const snap = new Date(report.period_start).toLocaleDateString('ru-RU', {
    day: '2-digit', month: 'long', year: 'numeric',
  })

  lines.push(`# Общая справка технического заказчика`, '')
  lines.push(`## Туристический комплекс «Золотые пески России» — на ${snap}`, '')
  if (report.title && report.title.trim().length > 0) {
    lines.push(`*${report.title}*`, '')
  }
  lines.push('---', '')

  if (report.preamble && report.preamble.trim().length > 0) {
    lines.push(report.preamble.trim(), '', '---', '')
  }

  // Группа: первоочередные
  const priority = sections.filter((s) => s.priority_group === 'priority')
  const secondary = sections.filter((s) => s.priority_group !== 'priority')

  if (priority.length > 0) {
    lines.push(`## По первоочередным объектам`, '')
    for (const s of priority) {
      lines.push(...renderControlSection(s))
    }
  }

  if (secondary.length > 0) {
    lines.push(`## По прочим объектам`, '')
    for (const s of secondary) {
      lines.push(...renderControlSection(s))
    }
  }

  return lines.join('\n') + '\n'
}

function renderControlSection(s: SectionRow): string[] {
  if (!s.object) return []
  const out: string[] = []
  const deadline = s.tep_deadline ? ` — срок ТЭП ${s.tep_deadline}` : ''
  out.push(`### ${s.object.code} — ${s.object.current_name}${deadline}`, '')

  // ── 0. Сводка (детерминированно из БД) ──────────────────────────
  out.push(`#### 0. Сводка`, '')

  // Алиасы (если есть)
  if (s.object.aliases && s.object.aliases.length > 0) {
    out.push(`* **Название:** ${s.object.code} — ${s.object.current_name}`)
    out.push(`* **Алиасы:** ${s.object.aliases.join(', ')}`)
  } else {
    out.push(`* **Название:** ${s.object.code} — ${s.object.current_name}`)
  }

  if (!s.contracts || s.contracts.length === 0) {
    out.push(`* **Подрядные организации:** _не определены_`)
    out.push(`* **Договоры:** _не зарегистрированы_`)
  } else {
    const contractorNames = [...new Set(
      s.contracts
        .map((c) => c.contractor_name)
        .filter((x): x is string => Boolean(x))
    )]
    out.push(
      `* **Подрядные организации:** ${contractorNames.length ? contractorNames.join(', ') : '_не определены_'}`,
    )
    out.push(`* **Договоры:**`)
    for (const c of s.contracts) {
      const num = c.doc_number ? `№ ${c.doc_number}` : '(без номера)'
      const sd = c.signed_date ? `(от ${formatDateRu(c.signed_date)})` : ''
      const contr = c.contractor_name ?? '— подрядчик —'
      const headParts = [c.type, num, sd].filter(Boolean).join(' ').trim()
      out.push(`  * **${headParts}** — ${contr}`)

      // Светофор этапов: ⚪ done · 🟢 current · 🔵 upcoming
      if (c.stages && c.stages.length > 0) {
        const stagesLine = c.stages.map((st) => {
          const icon = st.status === 'current' ? '🟢' : st.status === 'done' ? '⚪' : '🔵'
          const text = `${icon} ${st.stage_number}. ${st.stage_name}`
          // Выполненные — зачёркиваем; текущий — жирный
          if (st.status === 'done') return `~~${text}~~`
          if (st.status === 'current') return `**${text}**`
          return text
        }).join(' · ')
        out.push(`    * Этапы: ${stagesLine}`)
      } else {
        out.push(`    * _Этапы договора не определены._`)
      }
    }
  }
  out.push('')

  // ── 1. Нарратив ─────────────────────────────────────────────────
  out.push(`#### 1. Нарратив`, '')
  out.push(s.narrative?.trim() || '*— нарратив не заполнен —*', '')

  // ── 2. Этапы договора со сроками ────────────────────────────────
  if (s.contract_summary && s.contract_summary.trim().length > 0) {
    out.push(`#### 2. Этапы договора со сроками`, '')
    out.push(s.contract_summary.trim(), '')
  }

  // ── 3. Ключевые решения и поручения ─────────────────────────────
  if (s.decisions && s.decisions.trim().length > 0) {
    out.push(`#### 3. Ключевые решения и поручения`, '')
    out.push(s.decisions.trim(), '')
  }

  out.push('---', '')
  return out
}
