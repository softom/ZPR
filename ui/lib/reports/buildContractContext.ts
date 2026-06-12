import { supabaseAdmin } from '@/lib/supabase-admin'

// Контекст «Отчёта по договору ТЗ»: источник — выбранный МЕСЯЧНЫЙ отчёт ЗПР
// (он же станет Приложением). Берём его per-object содержание как фактуру,
// которую LLM переформулирует через «Исполнитель организовал/обеспечил…».

export type ContractObjectSection = {
  code: string
  name: string
  project_movement: string | null
  achievements: string | null
  next_period_tasks: string | null
  risks: string | null
}

export type ContractContext = {
  sourceReport: { id: string; title: string | null; period_start: string; period_end: string }
  objects: ContractObjectSection[]
}

export async function buildContractContext(sourceReportId: string): Promise<ContractContext> {
  const rRes = await supabaseAdmin
    .from('reports')
    .select('id, title, period_start, period_end, period_type')
    .eq('id', sourceReportId)
    .single()
  if (rRes.error || !rRes.data) {
    throw new Error(`Отчёт-источник (Приложение) не найден: ${sourceReportId}`)
  }

  const secRes = await supabaseAdmin
    .from('object_reports')
    .select('object_id, project_movement, achievements, next_period_tasks, risks, objects(code, current_name)')
    .eq('report_id', sourceReportId)

  type Row = {
    project_movement: string | null
    achievements: string | null
    next_period_tasks: string | null
    risks: string | null
    objects: { code: string; current_name: string } | null
  }
  const objects: ContractObjectSection[] = []
  for (const s of (secRes.data ?? []) as unknown as Row[]) {
    objects.push({
      code: s.objects?.code ?? '?',
      name: s.objects?.current_name ?? '',
      project_movement: s.project_movement,
      achievements: s.achievements,
      next_period_tasks: s.next_period_tasks,
      risks: s.risks,
    })
  }
  objects.sort((a, b) => a.code.localeCompare(b.code))

  return {
    sourceReport: {
      id: rRes.data.id,
      title: rRes.data.title,
      period_start: rRes.data.period_start,
      period_end: rRes.data.period_end,
    },
    objects,
  }
}
