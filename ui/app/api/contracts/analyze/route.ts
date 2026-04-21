import { NextRequest, NextResponse } from 'next/server'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4-6'

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files') as File[]
    const objectsJson = (formData.get('objects') as string) ?? '[]'

    if (!files.length) {
      return NextResponse.json({ error: 'Нет файлов' }, { status: 400 })
    }

    // Extract text from each PDF
    const extractedTexts: string[] = []
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const text = await extractPdfText(buffer, file.name)
      extractedTexts.push(`=== ${file.name} ===\n${text}`)
    }

    const combinedText = extractedTexts.join('\n\n')
    const objects: Array<{ code: string }> = JSON.parse(objectsJson)
    const objectCodes = objects.map(o => o.code).join(', ')

    const prompt = buildPrompt(combinedText, objectCodes)
    const result = await callLLM(prompt)

    // Attach extracted text for re-read step
    result._text = combinedText

    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[analyze]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function extractPdfText(buffer: Buffer, filename: string): Promise<string> {
  try {
    // Dynamic import avoids pdf-parse loading test PDF at module init time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js')
    const data = await pdfParse(buffer)
    const text = (data.text as string).trim()
    if (!text) return '[PDF не содержит извлекаемого текста — возможно скан]'
    return text
  } catch (e) {
    console.warn('[pdf-parse]', filename, e)
    return '[Не удалось извлечь текст — заполните поля вручную]'
  }
}

function buildPrompt(text: string, objectCodes: string): string {
  // Limit text to avoid token overflow
  const truncated = text.length > 30000 ? text.slice(0, 30000) + '\n[...текст обрезан...]' : text

  return `Ты помощник по обработке строительных договоров проекта ЗПР (Золотые Пески России).

Проанализируй приведённый текст пакета документов и верни JSON-объект. Только JSON, без пояснений.

Поля JSON:
- "date": дата подписания (YYYY-MM-DD), пустая строка если не найдена
- "direction": "incoming" если документ получен нами, "outgoing" если отправлен нами
- "from_to": контрагент (вторая сторона, не ЗПР / не заказчик), пустая строка если не найден
- "method": метод — одно из: ЭДО, Электронная_почта, Курьер, Скан, Факс, Лично. По умолчанию "Скан"
- "contract_type": "Договор", "ДС" или "Акт"
- "version": "v1" для первичного, "ДС1"/"ДС2" для доп.соглашений
- "title": краткое название до 60 символов, например "Договор ХГ-2026-003"
- "object_codes": массив кодов объектов из списка [${objectCodes}], которые упоминаются в документе
- "parties": стороны через «↔», например "ЗПР ↔ ХГ"
- "subject": предмет договора, одно предложение
- "amount": сумма с валютой, например "1 250 000 ₽", пустая строка если не указана
- "milestones": массив этапов

Каждый этап в milestones:
- "milestone_name": название этапа
- "due_date": плановая дата окончания (YYYY-MM-DD)
- "responsible": ответственная сторона (обычно подрядчик)
- "source": источник — "ДС-1", "Приложение №3", "Раздел 4" и т.п.

Приоритет источников для этапов (в этом порядке):
1. «План Работ» в последнем ДС
2. Приложение №3 «Календарный план»
3. ТЗ Приложение №1, п.17
4. Раздел 4 «Сроки выполнения работ»

Если ДС есть — его этапы полностью заменяют этапы основного договора.
Если данные не найдены — используй пустую строку или пустой массив.

Текст документов:
${truncated}`
}

async function callLLM(prompt: string) {
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
    throw new Error(`LLM error ${response.status}: ${err}`)
  }

  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content ?? '{}'

  // Extract JSON from response (might be wrapped in ```json ... ```)
  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\{[\s\S]*\})/)
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content

  try {
    return JSON.parse(jsonStr)
  } catch {
    return { error: 'Не удалось разобрать ответ LLM', raw: content }
  }
}
