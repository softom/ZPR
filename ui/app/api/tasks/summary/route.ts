import { NextRequest, NextResponse } from 'next/server'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

type TaskItem = {
  code: string
  title: string
  explanation?: string | null
  status: string
  priority?: string | null
  due_date?: string | null
  created_at?: string | null
  source_meeting_date?: string | null
}

export async function POST(request: NextRequest) {
  try {
    const { groupBy, groupLabel, tasks } = (await request.json()) as {
      groupBy: 'object' | 'entity'
      groupLabel: string
      tasks: TaskItem[]
    }

    if (!POLZA_API_KEY) {
      return NextResponse.json({ error: 'POLZA_API_KEY не задан в окружении UI' }, { status: 500 })
    }
    if (!tasks?.length) {
      return NextResponse.json({ summary: 'По группе нет задач.' })
    }

    const summary = await callLLM(buildPrompt(groupBy, groupLabel, tasks))
    return NextResponse.json({ summary })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[tasks/summary]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

function buildPrompt(groupBy: 'object' | 'entity', groupLabel: string, tasks: TaskItem[]): string {
  const subject = groupBy === 'object' ? `объекту «${groupLabel}»` : `юридическому лицу «${groupLabel}»`

  const total = tasks.length
  const open = tasks.filter((t) => ['open', 'in_progress'].includes(t.status)).length
  const done = tasks.filter((t) => ['done', 'closed'].includes(t.status)).length
  const overdue = tasks.filter((t) => {
    if (!t.due_date) return false
    if (['done', 'closed', 'cancelled'].includes(t.status)) return false
    return new Date(t.due_date) < new Date()
  }).length

  // В резюме идут только незакрытые задачи — о выполненных не пишем
  const activeTasks = tasks.filter((t) => !['done', 'closed', 'cancelled'].includes(t.status))

  const lines = activeTasks.map((t, i) => {
    const parts: string[] = []
    parts.push(`${i + 1}. [${t.status}]`)
    if (t.priority) parts.push(`приоритет:${t.priority}`)
    parts.push(`«${t.title}»`)
    if (t.explanation) parts.push(`— ${t.explanation}`)
    if (t.due_date) parts.push(`(срок ${t.due_date})`)
    if (t.source_meeting_date) parts.push(`(собрание ${t.source_meeting_date})`)
    return parts.join(' ')
  }).join('\n')

  if (activeTasks.length === 0) {
    return `Верни одно короткое предложение (до 15 слов): «По ${subject} открытых задач нет — всё выполнено.» На русском, деловой тон. Без markdown, без кавычек вокруг.`
  }

  return `Ты — помощник руководителя строительного проекта «Золотые пески России». Сформируй краткое деловое резюме о ПРОБЛЕМАХ и приоритетах по ${subject}.

КОНТЕКСТ (для понимания, в тексте резюме НЕ упоминай):
- Открытых задач: ${open}
- Просроченных: ${overdue}

ОТКРЫТЫЕ ЗАДАЧИ (только незакрытые):
${lines}

ЗАДАЧА:
1. Один сплошной абзац **строго до 60 слов**. Без списков, без подзаголовков, без markdown.
2. Пиши ТОЛЬКО о проблемах и приоритетах. Что выполнено — НЕ упоминай.
3. Выдели 2–3 наиболее критичные открытые задачи и кратко объясни почему (срок, влияние, давность).
4. В конце — одно предложение про основной риск или необходимое действие.
5. Деловой нейтральный тон. Обобщай, не повторяй формулировки задач дословно.
6. Не используй фразы вроде «по списку», «как видно из задач» — пиши прямо.

Верни ТОЛЬКО текст резюме (без префиксов «Резюме:», без кавычек вокруг). Помни: до 60 слов.`
}

async function callLLM(prompt: string): Promise<string> {
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
    throw new Error(`LLM error ${response.status}: ${err}`)
  }

  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? ''
  return content.trim()
}
