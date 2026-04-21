import { NextRequest, NextResponse } from 'next/server'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

type ObjectInfo = { code: string; current_name: string; contractor: string | null; aliases: string[] }

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const files = formData.getAll('files') as File[]
    const objectsJson = (formData.get('objects') as string) ?? '[]'

    if (!files.length) {
      return NextResponse.json({ error: 'Нет файлов' }, { status: 400 })
    }

    // Extract text from each PDF — scan PDFs are rejected
    const extractedTexts: string[] = []
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const { text, isScan } = await extractPdfText(buffer, file.name)
      if (isScan) {
        return NextResponse.json(
          { error: `Файл «${file.name}» является сканом и не содержит извлекаемого текста. Загрузите текстовый PDF.` },
          { status: 422 }
        )
      }
      extractedTexts.push(`=== ${file.name} ===\n${text}`)
    }

    const combinedText = extractedTexts.join('\n\n')
    const objects: ObjectInfo[] = JSON.parse(objectsJson)

    const prompt = buildPrompt(combinedText, objects)
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

async function extractPdfText(buffer: Buffer, filename: string): Promise<{ text: string; isScan: boolean }> {
  try {
    // Dynamic import avoids pdf-parse loading test PDF at module init time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js')
    const data = await pdfParse(buffer)
    const text = (data.text as string).trim()
    if (!text) return { text: '', isScan: true }
    return { text, isScan: false }
  } catch (e) {
    console.warn('[pdf-parse]', filename, e)
    return { text: '', isScan: true }
  }
}

function buildObjectsHint(objects: ObjectInfo[]): string {
  if (!objects.length) return '(объекты не заданы)'
  return objects.map(o => {
    const aliases = o.aliases?.length ? `, псевдонимы: ${o.aliases.join(', ')}` : ''
    const contractor = o.contractor ? `, подрядчик: ${o.contractor}` : ''
    return `  ${o.code} — ${o.current_name}${contractor}${aliases}`
  }).join('\n')
}

function buildPrompt(text: string, objects: ObjectInfo[]): string {
  const truncated = text.length > 30000 ? text.slice(0, 30000) + '\n[...текст обрезан...]' : text
  const objectsHint = buildObjectsHint(objects)

  return `Ты помощник по обработке строительных договоров проекта ЗПР (Золотые Пески России).
ЗПР — технический заказчик строительства. Подрядчики выполняют работы по заданию ЗПР.

Проанализируй текст пакета документов и верни ТОЛЬКО JSON-объект без пояснений.

═══ ПОЛЯ JSON ═══

"date" — дата подписания договора (YYYY-MM-DD).
  Ищи в начале документа строку вида «г. Москва, «__» ______ 202_ г.» или «от ДД.ММ.ГГГГ»
  или рядом с подписями сторон. Форматы: ДД.ММ.ГГГГ / «10 января 2026 г.» / 2026-01-10.
  Конвертируй в YYYY-MM-DD. Если не найдена — пустая строка.

"direction" — направление: "outgoing" (по умолчанию) или "incoming".
  ЗПР выдаёт задание подрядчику → "outgoing".
  "incoming" только если ЗПР получает документ от инвестора/заказчика ЗПР.

"from_to" — контрагент (вторая сторона, не ЗПР). Краткое наименование или аббревиатура.
  Пример: «ООО "Хэдс Групп"» → «ХГ», «МЛА+», «8D Studio» → «8D».

"method" — метод передачи: ЭДО / Электронная_почта / Курьер / Скан / Факс / Лично.
  Если в тексте упоминается ЭДО или электронный документооборот → "ЭДО".
  По умолчанию "ЭДО".

"contract_type" — тип: "Договор" / "ДС" / "Акт".

"version" — версия: "v1" для первичного договора, "ДС1"/"ДС2"/... для доп. соглашений.

"title" — краткое название до 60 символов. Пример: «Договор ХГ-2026-003» или «ДС-1 к договору ХГ-2026-003».

"parties" — стороны через «↔». Пример: «ЗПР ↔ ХГ».

"subject" — предмет договора, одно предложение. Что именно делает подрядчик.

"amount" — итоговая сумма с валютой. Пример: «1 250 000 ₽». Пустая строка если не указана.

"object_codes" — массив кодов объектов из договора.
  Сопоставляй с таблицей объектов по: коду, названию, псевдониму, номеру участка.
  Таблица объектов:
${objectsHint}
  Верни только коды из таблицы (например ["006_ГОСТИНИЦА_400"]). Пустой массив если не нашёл.

"milestones" — массив этапов и сроков. Искать в приоритете:
  1. «План работ» / «Календарный план» в последнем ДС (если есть ДС — берём только оттуда)
  2. Приложение №3 «Календарный план» основного договора
  3. Приложение №1 ТЗ, раздел «Этапы»
  4. Раздел «Сроки выполнения работ» (общие даты начала/окончания)

  Каждый этап:
  - "milestone_name": название этапа из документа
  - "due_date": дата окончания этапа (YYYY-MM-DD). Форматы в тексте: ДД.ММ.ГГГГ, «до 31.10.2025», «31 октября 2025 г.»
  - "responsible": исполнитель (обычно подрядчик, та же сторона что "from_to")
  - "source": источник — «ДС-1», «Приложение №3», «Раздел 4» и т.п.

  Важно: в PDF таблицы часто читаются построчно, колонки перемешаны.
  Паттерн строки таблицы: ЭТАП → название → дата начала → дата окончания.
  due_date = вторая дата (дата окончания). Опечатки в году (2626→2026) исправляй по контексту.

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
