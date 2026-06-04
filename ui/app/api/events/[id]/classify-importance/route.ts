import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

type Importance = 'low' | 'normal' | 'high' | 'critical'

// POST /api/events/[id]/classify-importance
// Body: { save?: boolean } — default true. Если false — только возвращает оценку, не пишет в БД.
// Возвращает: { importance: 'low'|'normal'|'high'|'critical', reason: string, saved: boolean }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!POLZA_API_KEY) {
    return NextResponse.json({ error: 'POLZA_API_KEY не задан' }, { status: 500 })
  }
  const { id } = await ctx.params
  const body = await request.json().catch(() => ({}))
  const save = body?.save !== false   // default true

  // Загружаем событие + контекст
  const { data: ev, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, event_type, title, note, date_end, event_time, object_ids, stage_name, importance, derived_source')
    .eq('id', id)
    .maybeSingle()
  if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 })
  if (!ev)    return NextResponse.json({ error: 'Событие не найдено' }, { status: 404 })

  // Имена объектов
  let objectNames: { code: string; current_name: string }[] = []
  if (ev.object_ids && ev.object_ids.length > 0) {
    const { data } = await supabaseAdmin
      .from('objects')
      .select('code, current_name')
      .in('id', ev.object_ids)
    objectNames = (data as { code: string; current_name: string }[]) || []
  }

  // Связанные юр.лица (через entity_links)
  const { data: links } = await supabaseAdmin
    .from('entity_links')
    .select('to_id, to_type, link_type')
    .eq('from_type', 'event').eq('from_id', id)
  let entityNames: string[] = []
  const leIds = (links || []).filter(l => l.to_type === 'legal_entity').map(l => l.to_id)
  if (leIds.length > 0) {
    const { data: les } = await supabaseAdmin
      .from('legal_entities')
      .select('name, short_name')
      .in('id', leIds)
    entityNames = (les || []).map(le => le.short_name || le.name).filter(Boolean) as string[]
  }

  const result = await classifyLLM({
    eventType:   ev.event_type,
    title:       ev.title || '(без названия)',
    note:        ev.note || '',
    date:        ev.date_end || null,
    objects:     objectNames,
    entities:    entityNames,
    source:      ev.derived_source || 'manual',
  })

  if (save) {
    const { error: updErr } = await supabaseAdmin
      .from('events')
      .update({ importance: result.importance })
      .eq('id', id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  return NextResponse.json({ ...result, saved: save })
}

// ─── Промпт ──────────────────────────────────────────────────────────────
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

Верни JSON:
{
  "importance": "low" | "normal" | "high" | "critical",
  "reason": "..."   // 1 короткое предложение, почему именно этот уровень
}

Правила:
- ОСТОРОЖНО с critical — только для ситуаций реального управленческого внимания. Не используй для «обычно важных» — это high.
- low — для технических записей и автоматики. Если запись по сути нужна оператору — это normal, не low.
- meeting (собрание) — обычно high, если только не явно техническое (например, краткий созвон без решений → normal).
- protocol_correction — обычно normal или low (это корректировка, не самостоятельное событие).
- Если в тексте есть слова «срочно», «приостановка», «отказ», «риск», «спор» → склоняйся к critical.
- Если в тексте есть «подписан», «получен договор», «утверждён», «передан в работу» → склоняйся к high.

Верни ТОЛЬКО JSON без markdown-обёртки.`
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
      temperature: 0.1,   // ниже температуру — нужна стабильная классификация
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

  try {
    const parsed = JSON.parse(jsonStr)
    const imp = parsed.importance as string
    if (!['low','normal','high','critical'].includes(imp)) {
      throw new Error(`Неожиданное значение importance: ${imp}`)
    }
    return {
      importance: imp as Importance,
      reason: String(parsed.reason ?? '').trim().slice(0, 500),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Не удалось разобрать JSON LLM: ${msg} | content=${content.slice(0, 200)}`)
  }
}
