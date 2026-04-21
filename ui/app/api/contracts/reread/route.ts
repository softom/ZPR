import { NextRequest, NextResponse } from 'next/server'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4-6'

type Milestone = {
  milestone_name: string
  due_date: string
  responsible: string
  source: string
}

export async function POST(request: NextRequest) {
  const { text, current_milestones, hint } = await request.json()

  const prompt = `Ты помощник по обработке строительных договоров.

Ранее ты извлёк следующие этапы из договора:
${JSON.stringify(current_milestones, null, 2)}

Оператор указал: "${hint}"

Перечитай текст договора с учётом подсказки и верни исправленный список этапов в виде JSON-массива.
Только JSON-массив, без пояснений.

Каждый объект:
- "milestone_name": название этапа
- "due_date": дата окончания (YYYY-MM-DD)
- "responsible": ответственная сторона
- "source": источник ("ДС-1", "Приложение №3", "Раздел 4" и т.п.)

Текст договора:
${text.slice(0, 20000)}`

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
    return NextResponse.json({ error: `LLM error ${response.status}` }, { status: 500 })
  }

  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '[]'

  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\[[\s\S]*\])/)
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content

  try {
    const milestones: Milestone[] = JSON.parse(jsonStr)
    return NextResponse.json({ milestones })
  } catch {
    return NextResponse.json({ error: 'Не удалось разобрать ответ LLM', raw: content }, { status: 500 })
  }
}
