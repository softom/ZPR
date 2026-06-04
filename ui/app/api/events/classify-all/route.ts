import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

type Importance = 'low' | 'normal' | 'high' | 'critical'

// POST /api/events/classify-all
// Body: {
//   only_normal?: boolean,   // default true — обрабатывать только events.importance='normal' (backfill)
//   limit?: number,          // default 200 — лимит на батч
//   dry_run?: boolean        // default false — не писать в БД
// }
//
// Запускает классификацию для всех подходящих событий ПОСЛЕДОВАТЕЛЬНО.
// Возвращает streaming-результат? Нет — простой JSON-summary.
// При больших объёмах (>50) — может занять минуты; вызывать с увеличенным таймаутом.
export const maxDuration = 300   // 5 минут

export async function POST(request: NextRequest) {
  if (!POLZA_API_KEY) {
    return NextResponse.json({ error: 'POLZA_API_KEY не задан' }, { status: 500 })
  }
  const body = await request.json().catch(() => ({}))
  const onlyNormal = body?.only_normal !== false   // default true
  const limit      = Math.min(Number(body?.limit ?? 200), 500)
  const dryRun     = body?.dry_run === true

  // Список кандидатов
  let q = supabaseAdmin
    .from('events')
    .select('id, event_type, title, note, date_end, object_ids, importance, derived_source')
    .order('date_computed', { ascending: false })
    .limit(limit)
  if (onlyNormal) q = q.eq('importance', 'normal')

  const { data: events, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Предзагружаем словари
  const allObjIds = new Set<string>()
  const allEvIds = (events ?? []).map(e => e.id as string)
  for (const e of events ?? []) {
    for (const oid of (e.object_ids ?? [])) allObjIds.add(oid)
  }
  const objMap = new Map<string, { code: string; current_name: string }>()
  if (allObjIds.size > 0) {
    const { data: objs } = await supabaseAdmin
      .from('objects')
      .select('id, code, current_name')
      .in('id', [...allObjIds])
    for (const o of (objs ?? []) as { id: string; code: string; current_name: string }[]) {
      objMap.set(o.id, { code: o.code, current_name: o.current_name })
    }
  }
  // entity_links для всех событий разом
  const leByEvent = new Map<string, string[]>()
  if (allEvIds.length > 0) {
    const { data: links } = await supabaseAdmin
      .from('entity_links')
      .select('from_id, to_id, to_type')
      .eq('from_type', 'event')
      .in('from_id', allEvIds)
      .eq('to_type', 'legal_entity')
    const leIds = [...new Set((links ?? []).map(l => l.to_id as string))]
    let leNames = new Map<string, string>()
    if (leIds.length > 0) {
      const { data: les } = await supabaseAdmin
        .from('legal_entities')
        .select('id, name, short_name')
        .in('id', leIds)
      for (const le of (les ?? []) as { id: string; name: string; short_name: string | null }[]) {
        leNames.set(le.id, le.short_name || le.name)
      }
    }
    for (const l of (links ?? []) as { from_id: string; to_id: string }[]) {
      const arr = leByEvent.get(l.from_id) ?? []
      const name = leNames.get(l.to_id)
      if (name) arr.push(name)
      leByEvent.set(l.from_id, arr)
    }
  }

  // Прогоняем по одному (последовательно — не насилуем LLM-провайдера)
  const results: Array<{ id: string; before: string; after: Importance; reason: string; saved: boolean }> = []
  const errors: Array<{ id: string; error: string }> = []
  const stats = { low: 0, normal: 0, high: 0, critical: 0 }

  for (const ev of (events ?? [])) {
    try {
      const objs = (ev.object_ids ?? [])
        .map((oid: string) => objMap.get(oid))
        .filter(Boolean) as { code: string; current_name: string }[]
      const entities = leByEvent.get(ev.id as string) ?? []

      const r = await classifyLLM({
        eventType: ev.event_type as string,
        title:     (ev.title as string) || '(без названия)',
        note:      (ev.note as string) || '',
        date:      (ev.date_end as string) || null,
        objects:   objs,
        entities,
        source:    (ev.derived_source as string) || 'manual',
      })

      stats[r.importance]++

      if (!dryRun && r.importance !== ev.importance) {
        const { error: updErr } = await supabaseAdmin
          .from('events')
          .update({ importance: r.importance })
          .eq('id', ev.id as string)
        if (updErr) { errors.push({ id: ev.id as string, error: updErr.message }); continue }
      }

      results.push({
        id: ev.id as string,
        before: (ev.importance as string) || 'normal',
        after:  r.importance,
        reason: r.reason,
        saved:  !dryRun && r.importance !== ev.importance,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ id: ev.id as string, error: msg })
    }
  }

  return NextResponse.json({
    processed: results.length,
    errors:    errors.length,
    dry_run:   dryRun,
    distribution: stats,
    changes_saved: results.filter(r => r.saved).length,
    results_sample: results.slice(0, 20),
    errors_sample:  errors.slice(0, 10),
  })
}

// ─── Промпт и LLM вызов (дублирует /[id]/classify-importance/route.ts) ────
function buildPrompt(opts: {
  eventType: string
  title: string
  note: string
  date: string | null
  objects: { code: string; current_name: string }[]
  entities: string[]
  source: string
}): string {
  const { eventType, title, note, date, objects, entities, source } = opts
  const objCtx  = objects.length > 0 ? objects.map(o => `${o.code} — ${o.current_name}`).join('; ') : 'не указаны'
  const leCtx   = entities.length > 0 ? entities.join('; ') : 'не указаны'
  const dateCtx = date ?? 'не указана'

  return `Ты — помощник руководителя строительного проекта «Золотые пески России». Оцени важность записи журнала проекта по 4-уровневой шкале для формирования управленческих отчётов.

═══ ШКАЛА ВАЖНОСТИ ═══

critical — критическое: требует немедленного внимания руководства
  • приостановка/прекращение работ
  • серьёзные риски, инциденты (срыв сроков, юр.проблемы, конфликты сторон)
  • отказ от договора, существенные финансовые потери
  • решения, меняющие состав или стоимость работ
  • обнаружение ошибок, влияющих на стройку или согласования

high — важное: ключевая управленческая веха, попадает в еженедельный отчёт
  • подписание/получение договоров и доп.соглашений
  • получение/отправка ФЗ, ТЗ, ИРД, ТУ, важных согласований
  • прохождение/получение результатов ключевых согласований
  • начало/окончание этапа работ
  • важные собрания с решениями
  • существенные изменения проектных решений
  • получение/отправка ТЭП, КП с цифрами

normal — обычное: рабочая коммуникация, журнал работы команды
  • уточняющие вопросы, обмен материалами
  • рабочие созвоны без принятых решений
  • мелкие правки, доуточнения
  • рутинные напоминания

low — фоновое: техническая запись, малозначимое
  • автоматические корректировки, дубли
  • справочная информация без действий
  • технические уведомления, спам-фильтрация
  • перенос дат без значимых последствий

═══ ЗАПИСЬ ДЛЯ ОЦЕНКИ ═══

Тип события: ${eventType}
Источник:    ${source}
Дата:        ${dateCtx}
Заголовок:   ${title}
Объекты:     ${objCtx}
Подрядчики:  ${leCtx}

ТЕКСТ ЗАПИСИ:
${note || '(пусто)'}

═══ ЗАДАЧА ═══

Верни JSON: {"importance": "low"|"normal"|"high"|"critical", "reason": "1 короткое предложение"}

Правила:
- critical — только реальное управленческое внимание, не «вообще важно».
- low — только техническое/автоматическое.
- meeting обычно high, если только не явный технический созвон.
- protocol_correction обычно normal/low.
- Слова «срочно», «приостановка», «отказ», «риск» → critical.
- Слова «подписан», «получен», «утверждён» → high.

Верни ТОЛЬКО JSON без markdown.`
}

async function classifyLLM(opts: {
  eventType: string
  title: string
  note: string
  date: string | null
  objects: { code: string; current_name: string }[]
  entities: string[]
  source: string
}): Promise<{ importance: Importance; reason: string }> {
  const prompt = buildPrompt(opts)
  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err}`)
  }
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'
  const m = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\{[\s\S]*\})/)
  const jsonStr = m ? (m[1] ?? m[0]) : content
  const parsed = JSON.parse(jsonStr)
  const imp = parsed.importance as string
  if (!['low','normal','high','critical'].includes(imp)) {
    throw new Error(`Неожиданное importance: ${imp}`)
  }
  return {
    importance: imp as Importance,
    reason: String(parsed.reason ?? '').trim().slice(0, 500),
  }
}
