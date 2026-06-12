import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { enrichEventsWithLifecycle, type EventRow } from '@/lib/reports/buildContext'

// Этап договора в API-ответе с цветовым статусом.
type ContractStageForUI = {
  id: string
  stage_number: number
  stage_name: string
  sort_order: number
  status: 'done' | 'current' | 'upcoming'
}

// GET /api/reports/[id] — отчёт + все секции с метаданными объектов
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const [reportRes, sectionsRes, objectsRes] = await Promise.all([
    supabaseAdmin
      .from('reports')
      .select('*')
      .eq('id', id)
      .single(),
    supabaseAdmin
      .from('object_reports')
      .select('*')
      .eq('report_id', id)
      .order('generated_at', { ascending: true }),
    supabaseAdmin
      .from('objects')
      .select('id, code, current_name, contractor, active, llm_hint, aliases, llm_hint_valid_from, llm_hint_valid_until')
      .order('code'),
  ])

  if (reportRes.error || !reportRes.data) {
    return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  }

  type ObjectMeta = {
    code: string; current_name: string; contractor: string | null;
    active: boolean; llm_hint: string | null; aliases: string[]
    llm_hint_valid_from: string | null
    llm_hint_valid_until: string | null
  }
  const objectsById = new Map<string, ObjectMeta>()
  for (const o of (objectsRes.data ?? [])) {
    let aliases: string[] = []
    const raw = (o as { aliases?: unknown }).aliases
    if (Array.isArray(raw)) {
      aliases = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    }
    objectsById.set(o.id, {
      code: o.code, current_name: o.current_name,
      contractor: o.contractor, active: o.active,
      llm_hint: o.llm_hint, aliases,
      llm_hint_valid_from: (o as { llm_hint_valid_from?: string | null }).llm_hint_valid_from ?? null,
      llm_hint_valid_until: (o as { llm_hint_valid_until?: string | null }).llm_hint_valid_until ?? null,
    })
  }

  // Секции с привязкой к объектам, отсортированные по object.code
  let sections = (sectionsRes.data ?? [])
    .map((s) => ({ ...s, object: objectsById.get(s.object_id) ?? null }))
    .sort((a, b) => (a.object?.code ?? '').localeCompare(b.object?.code ?? ''))

  // Для week и control — подтягиваем договоры объектов одним батчем
  // (нужны для блока «Сводка/Договоры» в UI карточки).
  const needsContracts = reportRes.data.period_type === 'week'
                      || reportRes.data.period_type === 'control'
  if (needsContracts) {
    const objectCodes = sections
      .map((s) => s.object?.code)
      .filter((c): c is string => Boolean(c))
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

      // ВСЕ этапы договоров — через view contract_stages_with_progress.
      // Из них вычисляем done / current / upcoming по sort_order и is_current.
      const [entRes, stRes] = await Promise.all([
        contractorIds.size > 0
          ? supabaseAdmin.from('legal_entities').select('id, name').in('id', [...contractorIds])
          : Promise.resolve({ data: [] }),
        docIds.length > 0
          ? supabaseAdmin
              .from('contract_stages_with_progress')
              .select('id, document_id, stage_number, stage_name, sort_order, is_current')
              .in('document_id', docIds)
              .order('sort_order', { ascending: true })
          : Promise.resolve({ data: [] }),
      ])
      const entById = new Map((entRes.data ?? []).map((e) => [e.id as string, e.name as string]))

      // Группируем все этапы по document_id
      type StageRow = {
        id: string; document_id: string;
        stage_number: number; stage_name: string;
        sort_order: number; is_current: boolean;
      }
      const stagesByDocId = new Map<string, StageRow[]>()
      for (const s of (stRes.data ?? []) as StageRow[]) {
        if (!stagesByDocId.has(s.document_id)) stagesByDocId.set(s.document_id, [])
        stagesByDocId.get(s.document_id)!.push(s)
      }

      // Для каждого договора вычисляем статус каждого этапа: done | current | upcoming.
      function computeStages(docId: string): ContractStageForUI[] {
        const stages = stagesByDocId.get(docId) ?? []
        if (stages.length === 0) return []
        const current = stages.find((s) => s.is_current)
        const currentSort = current?.sort_order ?? null
        return stages.map((s) => {
          let status: 'done' | 'current' | 'upcoming'
          if (currentSort === null) {
            // Нет текущего — все будущие
            status = 'upcoming'
          } else if (s.is_current) {
            status = 'current'
          } else if (s.sort_order < currentSort) {
            status = 'done'
          } else {
            status = 'upcoming'
          }
          return {
            id: s.id,
            stage_number: s.stage_number,
            stage_name: s.stage_name,
            sort_order: s.sort_order,
            status,
          }
        })
      }

      const byObjectCode = new Map<string, Array<{
        id: string; type: string; title: string;
        doc_number: string | null; signed_date: string | null;
        contractor_name: string | null;
        current_stage_id: string | null;
        current_stage_number: number | null;
        current_stage_name: string | null;
        stages: ContractStageForUI[];
      }>>()
      for (const d of docs) {
        const codes = (d.document_objects ?? []).map((x) => x.object_code)
        const stages = computeStages(d.id)
        const current = stages.find((s) => s.status === 'current') ?? null
        const cfr = {
          id: d.id,
          type: d.type,
          title: d.title,
          doc_number: d.doc_number,
          signed_date: d.signed_date,
          contractor_name: d.contractor_entity_id ? entById.get(d.contractor_entity_id) ?? null : null,
          current_stage_id: current?.id ?? null,
          current_stage_number: current?.stage_number ?? null,
          current_stage_name: current?.stage_name ?? null,
          stages,
        }
        for (const code of codes) {
          if (!byObjectCode.has(code)) byObjectCode.set(code, [])
          byObjectCode.get(code)!.push(cfr)
        }
      }
      sections = sections.map((s) => ({
        ...s,
        contracts: s.object?.code ? (byObjectCode.get(s.object.code) ?? []) : [],
      }))
    }
  }

  // recent_activity по каждому объекту — для UI warning'а «устаревший llm_hint».
  // Срез: за последние 30 дней от reference-date.
  //   week/month → reference = period_end
  //   control    → reference = period_start (snapshot)
  const objIdsForActivity = sections.map((s) => s.object_id).filter(Boolean)
  if (objIdsForActivity.length > 0) {
    const ref = reportRes.data.period_type === 'control'
      ? new Date(reportRes.data.period_start)
      : new Date(reportRes.data.period_end)
    const since = new Date(ref.getTime() - 30 * 86400000)
    const sinceISO = since.toISOString().slice(0, 10)
    const refISO = ref.toISOString().slice(0, 10)

    // 1) Задачи active (есть строка status in (open, in_progress)) — батч по всем object_ids
    const tosRes = await supabaseAdmin
      .from('task_object_status')
      .select('object_id, status, done_date')
      .in('object_id', objIdsForActivity)
      .in('status', ['open', 'in_progress', 'done', 'closed'])

    // 2) События по object_ids, за окно
    const evtRes = await supabaseAdmin
      .from('events')
      .select('object_ids, date_computed, date_end')
      .overlaps('object_ids', objIdsForActivity)
      .gte('date_computed', sinceISO)
      .lte('date_computed', refISO)

    // 3) Темы — за окно собрания
    const topRes = await supabaseAdmin
      .from('meeting_topics')
      .select('object_ids, meeting_id')
      .overlaps('object_ids', objIdsForActivity)
      .eq('status', 'approved')
    // Нужны meeting_date — подтянем mid → date
    const mIds = [...new Set(((topRes.data ?? []) as Array<{ meeting_id: string | null }>)
      .map((t) => t.meeting_id).filter((x): x is string => Boolean(x)))]
    const mDateById = new Map<string, string>()
    if (mIds.length > 0) {
      const mRes = await supabaseAdmin
        .from('meetings')
        .select('id, meeting_date')
        .in('id', mIds)
      for (const m of (mRes.data ?? []) as Array<{ id: string; meeting_date: string }>) {
        mDateById.set(m.id, m.meeting_date)
      }
    }

    type ActivityCounts = { tasks_active: number; topics_30d: number; events_30d: number }
    const activityByObj = new Map<string, ActivityCounts>()
    for (const oid of objIdsForActivity) activityByObj.set(oid, { tasks_active: 0, topics_30d: 0, events_30d: 0 })

    for (const r of (tosRes.data ?? []) as Array<{ object_id: string; status: string; done_date: string | null }>) {
      const a = activityByObj.get(r.object_id)
      if (!a) continue
      if (r.status === 'open' || r.status === 'in_progress') a.tasks_active += 1
      else if (r.done_date && r.done_date >= sinceISO && r.done_date <= refISO) a.tasks_active += 1
    }
    for (const e of (evtRes.data ?? []) as Array<{ object_ids: string[] | null }>) {
      for (const oid of e.object_ids ?? []) {
        const a = activityByObj.get(oid)
        if (a) a.events_30d += 1
      }
    }
    for (const t of (topRes.data ?? []) as Array<{ object_ids: string[] | null; meeting_id: string | null }>) {
      const md = t.meeting_id ? mDateById.get(t.meeting_id) : null
      if (!md || md < sinceISO || md > refISO) continue
      for (const oid of t.object_ids ?? []) {
        const a = activityByObj.get(oid)
        if (a) a.topics_30d += 1
      }
    }

    sections = sections.map((s) => ({
      ...s,
      recent_activity: activityByObj.get(s.object_id) ?? { tasks_active: 0, topics_30d: 0, events_30d: 0 },
    }))
  }

  // ─── done_in_period: ДЕТАЛЬНЫЙ список закрытых задач per object для блока
  //     «✓ Выполнено за период» в UI карточки (детерминированный, не LLM).
  //     Период: week/month → [start, end]; control → [snapshot-60d, snapshot].
  {
    const isControl = reportRes.data.period_type === 'control'
    const startISO = (isControl
      ? new Date(new Date(reportRes.data.period_start).getTime() - 60 * 86400000)
          .toISOString().slice(0, 10)
      : reportRes.data.period_start) as string
    const endISO = (isControl
      ? reportRes.data.period_start
      : reportRes.data.period_end) as string

    const objIds = sections.map((s) => s.object_id).filter(Boolean)
    if (objIds.length > 0) {
      const tosRes = await supabaseAdmin
        .from('task_object_status')
        .select('task_id, object_id, status, done_date')
        .in('object_id', objIds)
        .in('status', ['done', 'closed'])
        .gte('done_date', startISO)
        .lte('done_date', endISO)
      const tosRows = (tosRes.data ?? []) as Array<{
        task_id: string; object_id: string; status: string; done_date: string
      }>
      const tIds = [...new Set(tosRows.map((r) => r.task_id))]
      const taskById = new Map<string, { code: string; title: string; assignee_org: string | null }>()
      if (tIds.length > 0) {
        const tRes = await supabaseAdmin
          .from('tasks')
          .select('id, code, title, assignee_org')
          .in('id', tIds)
        for (const t of (tRes.data ?? []) as Array<{ id: string; code: string; title: string; assignee_org: string | null }>) {
          taskById.set(t.id, { code: t.code, title: t.title, assignee_org: t.assignee_org })
        }
      }
      type DoneTask = {
        id: string; code: string; title: string; assignee_org: string | null
        done_date: string; status: string
      }
      const doneByObj = new Map<string, DoneTask[]>()
      for (const r of tosRows) {
        const t = taskById.get(r.task_id)
        if (!t) continue
        if (!doneByObj.has(r.object_id)) doneByObj.set(r.object_id, [])
        doneByObj.get(r.object_id)!.push({
          id: r.task_id,
          code: t.code,
          title: t.title,
          assignee_org: t.assignee_org,
          done_date: r.done_date,
          status: r.status,
        })
      }
      sections = sections.map((s) => ({
        ...s,
        tasks_done_in_period: (doneByObj.get(s.object_id) ?? [])
          .sort((a, b) => b.done_date.localeCompare(a.done_date)),
      }))
    }
  }

  // ─── lifecycle_events: важные события (high/critical) с разбивкой по
  //     resolved/active_problems/risk_no_followup для отображения «контекст
  //     LLM» в шапке каждого блока отчёта. Период: week/month → [start, end];
  //     control → [snapshot - 60d, snapshot].
  {
    const isControl = reportRes.data.period_type === 'control'
    const startISO = (isControl
      ? new Date(new Date(reportRes.data.period_start).getTime() - 60 * 86400000)
          .toISOString().slice(0, 10)
      : reportRes.data.period_start) as string
    const endISO = (isControl
      ? reportRes.data.period_start
      : reportRes.data.period_end) as string

    const objIds = sections.map((s) => s.object_id).filter(Boolean)
    if (objIds.length > 0) {
      // Все важные события по этим объектам (вне зависимости от окна — нужны
      // и старые проблемы тоже, чтобы вычислить resolved_date в окне).
      // is_preliminary=true исключаем — это черновики «На ревью».
      const evRes = await supabaseAdmin
        .from('events')
        .select('id, title, event_type, date_computed, date_end, note, object_ids, importance')
        .overlaps('object_ids', objIds)
        .in('importance', ['high', 'critical'])
        .or('is_preliminary.is.null,is_preliminary.eq.false')
      const allImportant = (evRes.data ?? []) as Array<EventRow & { object_ids: string[] | null }>
      await enrichEventsWithLifecycle(allImportant)

      type LifecycleEventLite = {
        id: string
        title: string
        importance: 'high' | 'critical' | null
        date: string | null            // основная дата события (date_end || date_computed)
        is_resolved: boolean
        resolved_date: string | null
        resolved_by_title: string | null
        task_count: number
        has_active_task: boolean
        // Список raised_from-задач для UI — показываем под событием.
        // Закрытые задачи под resolved-событием = доп.положительный факт для отчёта.
        related_tasks: Array<{
          id: string
          code: string
          title: string
          status: string
          done_date: string | null
        }>
        // Это событие выполняет роль РЕШЕНИЯ (E2) — на него ссылается
        // task→event resolved_by. Не должно попадать в risk_no_followup.
        is_resolution: boolean
        resolves_event_titles: string[]
      }
      type LifecycleByObject = {
        resolved: LifecycleEventLite[]
        active_problems: LifecycleEventLite[]
        risk_no_followup: LifecycleEventLite[]
      }
      const lifecycleByObj = new Map<string, LifecycleByObject>()
      for (const oid of objIds) {
        lifecycleByObj.set(oid, { resolved: [], active_problems: [], risk_no_followup: [] })
      }
      for (const e of allImportant) {
        const lite: LifecycleEventLite = {
          id: e.id,
          title: e.title,
          importance: (e.importance ?? null) as 'high' | 'critical' | null,
          date: e.date_end ?? e.date_computed,
          is_resolved: e.is_resolved ?? false,
          resolved_date: e.resolved_date ?? null,
          resolved_by_title: e.resolved_by_title ?? null,
          task_count: e.task_count ?? 0,
          has_active_task: e.has_active_task ?? false,
          related_tasks: (e.related_tasks ?? []) as LifecycleEventLite['related_tasks'],
          is_resolution: e.is_resolution ?? false,
          resolves_event_titles: e.resolves_event_titles ?? [],
        }
        const inResolvedWindow = lite.is_resolved && lite.resolved_date
          && lite.resolved_date >= startISO && lite.resolved_date <= endISO
        for (const oid of (e.object_ids ?? [])) {
          const bucket = lifecycleByObj.get(oid)
          if (!bucket) continue
          if (inResolvedWindow) bucket.resolved.push(lite)
          else if (!lite.is_resolved && lite.has_active_task) bucket.active_problems.push(lite)
          else if (!lite.is_resolved && !lite.has_active_task && lite.task_count === 0
                   && !lite.is_resolution) {
            // event-резолюции (E2 — closing events) сами выполняют роль решения,
            // не должны попадать в «риски без followup».
            bucket.risk_no_followup.push(lite)
          }
        }
      }

      // Сортируем события внутри каждой категории по дате ASC
      // (хронология «от старого к новому» — удобнее для оценки контекста).
      const byDateAsc = (a: LifecycleEventLite, b: LifecycleEventLite) => {
        const da = a.date ?? '9999-12-31'
        const db = b.date ?? '9999-12-31'
        return da.localeCompare(db)
      }
      for (const bucket of lifecycleByObj.values()) {
        bucket.resolved.sort(byDateAsc)
        bucket.active_problems.sort(byDateAsc)
        bucket.risk_no_followup.sort(byDateAsc)
      }

      sections = sections.map((s) => ({
        ...s,
        lifecycle_events: lifecycleByObj.get(s.object_id) ?? {
          resolved: [], active_problems: [], risk_no_followup: [],
        },
      }))
    }
  }

  // hint_effective_at_reference — применяется ли llm_hint на дату отчёта
  // (учитывая поля objects.llm_hint_valid_from / valid_until)
  {
    const refISO = (reportRes.data.period_type === 'control'
      ? reportRes.data.period_start
      : reportRes.data.period_end) as string
    sections = sections.map((s) => {
      const obj = s.object as ({
        llm_hint?: string | null
        llm_hint_valid_from?: string | null
        llm_hint_valid_until?: string | null
      } | null)
      const hint = obj?.llm_hint ?? null
      const hasHint = typeof hint === 'string' && hint.trim().length > 0
      const beforeFrom = obj?.llm_hint_valid_from && refISO < obj.llm_hint_valid_from
      const afterUntil = obj?.llm_hint_valid_until && refISO > obj.llm_hint_valid_until
      const hint_effective_at_reference = hasHint && !beforeFrom && !afterUntil
      return { ...s, hint_effective_at_reference }
    })
  }

  return NextResponse.json({ report: reportRes.data, sections })
}

// PATCH /api/reports/[id] — ручная правка summary_md (или title)
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  const cur = await supabaseAdmin.from('reports').select('status').eq('id', id).single()
  if (cur.error || !cur.data) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  if (cur.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя править' }, { status: 409 })
  }

  const update: Record<string, string | boolean | null> = {}
  for (const k of ['summary_md', 'title', 'appendix_report_id']) {
    if (k in body) {
      const v = body[k]
      update[k] = typeof v === 'string' ? v : v == null ? null : String(v)
    }
  }
  if ('include_financials' in body) {
    update.include_financials = Boolean(body.include_financials)
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('reports')
    .update(update)
    .eq('id', id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ report: data })
}

// DELETE /api/reports/[id] — удалить (только status='draft')
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const cur = await supabaseAdmin.from('reports').select('status').eq('id', id).single()
  if (cur.error || !cur.data) {
    return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 })
  }
  if (cur.data.status === 'final') {
    return NextResponse.json({ error: 'Финализированный отчёт нельзя удалить' }, { status: 409 })
  }
  const { error } = await supabaseAdmin.from('reports').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
