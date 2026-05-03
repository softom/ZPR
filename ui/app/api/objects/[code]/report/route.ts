import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

type Task = {
  id: string
  code: string
  title: string
  explanation: string | null
  status: string
  priority: string | null
  due_date: string | null
  done_date: string | null
  created_at: string
  source_meeting_date: string | null
}

// ─── Дата: понедельник—воскресенье недели ───────────────────────────────────
function weekRange(today: Date = new Date()): { start: string; end: string } {
  const d = new Date(today)
  d.setHours(0, 0, 0, 0)
  // ISO неделя: пн = 1, вс = 7. JS: вс = 0, пн = 1.
  const day = d.getDay() || 7
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day - 1))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  }
}

// ─── GET: последний отчёт по объекту ────────────────────────────────────────
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ code: string }> }
) {
  const { code } = await ctx.params
  const url = new URL(request.url)
  if (url.searchParams.get('latest') === '1' || !url.searchParams.has('latest')) {
    const { data, error } = await supabaseAdmin
      .from('object_reports_latest')
      .select('*')
      .eq('object_code', code)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ report: data ?? null })
  }
  // history
  const { data, error } = await supabaseAdmin
    .from('object_reports')
    .select('*')
    .eq('object_code', code)
    .order('generated_at', { ascending: false })
    .limit(20)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reports: data })
}

// ─── POST: сгенерировать новый отчёт ────────────────────────────────────────
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ code: string }> }
) {
  const { code } = await ctx.params

  if (!POLZA_API_KEY) {
    return NextResponse.json({ error: 'POLZA_API_KEY не задан' }, { status: 500 })
  }

  const { start: period_start, end: period_end } = weekRange()

  // Достаём задачи объекта
  const { data: tasks, error: taskErr } = await supabaseAdmin
    .from('tasks')
    .select('id, code, title, explanation, status, priority, due_date, done_date, created_at, source_meeting_date')
    .contains('object_codes', [code])
    .order('created_at', { ascending: true })

  if (taskErr) return NextResponse.json({ error: taskErr.message }, { status: 500 })

  // Имя объекта для промпта
  const { data: obj } = await supabaseAdmin
    .from('objects')
    .select('current_name')
    .eq('code', code)
    .maybeSingle()
  const objectLabel = obj?.current_name ? `${code} — ${obj.current_name}` : code

  let achievements = '', weekly_work = '', problems = ''
  try {
    const result = await callLLM(buildPrompt({
      objectLabel,
      period_start,
      period_end,
      tasks: (tasks as Task[]) || [],
    }))
    achievements = result.achievements ?? ''
    weekly_work = result.weekly_work ?? ''
    problems = result.problems ?? ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `LLM: ${msg}` }, { status: 500 })
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('object_reports')
    .insert({
      object_code: code,
      period_start,
      period_end,
      achievements,
      weekly_work,
      problems,
      model_used: LLM_MODEL,
    })
    .select()
    .single()

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
  return NextResponse.json({ report: inserted })
}

// ─── Промпт ─────────────────────────────────────────────────────────────────
function buildPrompt(opts: {
  objectLabel: string
  period_start: string
  period_end: string
  tasks: Task[]
}): string {
  const { objectLabel, period_start, period_end, tasks } = opts
  const today = new Date(new Date().toDateString())
  const periodStart = new Date(period_start)
  const periodEnd = new Date(period_end)

  const inPeriod = (d: string | null): boolean => {
    if (!d) return false
    const dd = new Date(d)
    return dd >= periodStart && dd <= periodEnd
  }

  const achievements = tasks.filter(
    (t) => ['done', 'closed'].includes(t.status) && inPeriod(t.done_date)
  )
  const weeklyOpen = tasks.filter(
    (t) => ['open', 'in_progress'].includes(t.status)
  )
  const problemsList = tasks.filter((t) => {
    if (!['open', 'in_progress', 'preliminary'].includes(t.status)) return false
    const overdue = t.due_date && new Date(t.due_date) < today
    const oldDays = (today.getTime() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24)
    const stale = oldDays > 30
    return Boolean(overdue) || stale
  })

  const fmtList = (arr: Task[]): string =>
    arr.length === 0 ? '— нет —' : arr.map((t, i) => {
      const parts = [`${i + 1}.`, `«${t.title}»`]
      if (t.priority) parts.push(`(${t.priority})`)
      if (t.due_date) parts.push(`[срок ${t.due_date}]`)
      if (t.done_date) parts.push(`[выполнено ${t.done_date}]`)
      if (t.explanation) parts.push(`— ${t.explanation}`)
      return parts.join(' ')
    }).join('\n')

  return `Ты — помощник руководителя строительного проекта «Золотые пески России». Сформируй еженедельный отчёт по объекту «${objectLabel}» за календарную неделю ${period_start}—${period_end}.

═══ КОНТЕКСТ ═══

ВЫПОЛНЕНО ЗА НЕДЕЛЮ (${achievements.length}):
${fmtList(achievements)}

В РАБОТЕ СЕЙЧАС (${weeklyOpen.length}):
${fmtList(weeklyOpen)}

ПРОБЛЕМЫ — просроченные или давно открытые (${problemsList.length}):
${fmtList(problemsList)}

═══ ЗАДАЧА ═══

Верни JSON-объект ровно с тремя полями (без пояснений, без markdown-обёртки):

{
  "achievements": "...",
  "weekly_work": "...",
  "problems": "..."
}

ТРЕБОВАНИЯ К КАЖДОМУ ПОЛЮ:
- Один сплошной абзац без подзаголовков и списков
- Строго до 60 слов
- Деловой нейтральный тон
- Обобщай, не цитируй формулировки задач дословно
- Не используй фразы «по списку», «как видно из задач»

КОНТЕКСТ ПОЛЕЙ:
- "achievements" — что именно сделано за эту неделю; если пусто — «За отчётную неделю выполненных задач нет.»
- "weekly_work" — над чем работа активна сейчас, какие приоритеты; если пусто — «Активных задач нет.»
- "problems" — критичные проблемы (просрочки, давно открытые), что блокирует, что требует внимания; если пусто — «Критичных проблем не выявлено.»

Верни ТОЛЬКО JSON. Без префиксов, без \`\`\`.`
}

// ─── LLM call ───────────────────────────────────────────────────────────────
async function callLLM(prompt: string): Promise<{ achievements: string; weekly_work: string; problems: string }> {
  const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  })
  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM ${response.status}: ${err}`)
  }
  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'

  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\{[\s\S]*\})/)
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content

  try {
    const parsed = JSON.parse(jsonStr)
    return {
      achievements: String(parsed.achievements ?? '').trim(),
      weekly_work: String(parsed.weekly_work ?? '').trim(),
      problems: String(parsed.problems ?? '').trim(),
    }
  } catch {
    throw new Error(`Не удалось разобрать ответ LLM: ${content.slice(0, 200)}`)
  }
}
