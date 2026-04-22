import { NextRequest, NextResponse } from 'next/server'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

type ObjectInfo = { code: string; current_name: string; contractor: string | null; aliases: string[] }

export async function POST(request: NextRequest) {
  try {
    const { texts, objects } = await request.json() as {
      texts: Array<{ name: string; text: string }>
      objects: ObjectInfo[]
    }

    if (!texts?.length) {
      return NextResponse.json({ error: 'Нет текста для анализа' }, { status: 400 })
    }

    const combinedText = texts.map(t => `=== ${t.name} ===\n${t.text}`).join('\n\n')
    const prompt = buildPrompt(combinedText, objects ?? [])
    const result = await callLLM(prompt)
    result._text = combinedText

    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[analyze]', message)
    return NextResponse.json({ error: message }, { status: 500 })
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

РОЛИ СТОРОН:
- ЗПР = технический заказчик строительства. В договорах именуется как:
  «ООО Золотые Пески России», «Технический заказчик», «Заказчик», «ЗПР».
- Подрядчик (Исполнитель) = организация, выполняющая работы для ЗПР.
- Инвестор / Девелопер — вышестоящий заказчик над ЗПР (не является контрагентом этого договора).

Проанализируй текст пакета документов и верни ТОЛЬКО JSON-объект без пояснений.

═══ ПОЛЯ JSON ═══

"date" — дата подписания договора (YYYY-MM-DD).
  ГДЕ ИСКАТЬ: начало документа («г. Москва, «__» ___ 202_ г.»), рядом с подписями,
  в реквизитах («Договор № ___ от ДД.ММ.ГГГГ»).
  ФОРМАТЫ: ДД.ММ.ГГГГ → YYYY-MM-DD, «10 января 2026 г.» → 2026-01-10.
  Если не найдена — пустая строка.

"direction": "outgoing" по умолчанию (ЗПР выдаёт задание подрядчику).
  "incoming" только если ЗПР получает документ от вышестоящего инвестора.

"from_to" — ТОЛЬКО подрядчик / исполнитель (не ЗПР, не инвестор).
  В договоре он именуется «Подрядчик», «Исполнитель», «Проектировщик».
  Верни краткое наименование организации. Пример: «ООО МЛА+» → «МЛА+».

"method": ЭДО / Электронная_почта / Курьер / Скан / Факс / Лично.
  Если упоминается ЭДО или электронный документооборот → "ЭДО". По умолчанию "ЭДО".

"contract_type": "Договор" / "ДС" / "Акт".

"version": "v1" для первичного, "ДС1"/"ДС2"... для доп. соглашений.

"title" — до 60 символов. Включи номер договора если есть. Пример: «Договор МЛА+-2026-003».

"parties" — стороны через «↔». Пример: «ЗПР ↔ МЛА+».

"subject" — предмет договора, одно предложение (что делает подрядчик).

"amount" — итоговая сумма. Пример: «1 250 000 ₽». Пустая строка если нет.

"object_codes" — коды объектов из таблицы ниже. Сопоставляй по коду, названию, псевдониму.
  Таблица объектов:
${objectsHint}
  Верни только коды из таблицы. Пустой массив если не нашёл.

"milestones" — ВСЕ этапы с датами. Искать ВЕЗДЕ в тексте:

  ПРИОРИТЕТ ИСТОЧНИКОВ:
  1. «График производства работ» / «Календарный план работ» в последнем ДС → ТОЛЬКО его
  2. Любое Приложение с таблицей этапов (Приложение №2, №3, №4...)
  3. Раздел «Этапы выполнения работ» / «Сроки выполнения»
  4. Любые упоминания конкретных этапов с датами в тексте

  КАК ЧИТАТЬ ТАБЛИЦЫ ИЗ PDF (текст часто перемешан):
  - Ищи паттерн: [номер/название этапа] + [дата или «до ДД.ММ.ГГГГ»]
  - В строке таблицы обычно две даты: начало и конец. due_date = ВТОРАЯ (окончание)
  - Форматы дат: ДД.ММ.ГГГГ, «до 31.10.2026», «31 октября 2026 г.», «IV квартал 2026»
  - Квартал: Q1=31.03, Q2=30.06, Q3=30.09, Q4=31.12 соответствующего года
  - Опечатки типа 2626→2026 исправляй по контексту соседних дат

  Каждый этап:
  - "milestone_name": название (как в документе, не сокращай)
  - "date_start": дата начала (YYYY-MM-DD), пустая строка если нет
  - "due_date": дата окончания (YYYY-MM-DD), пустая строка если нет
  - "responsible": исполнитель (обычно подрядчик = значение from_to)
  - "source": «ДС-1», «Приложение №3», «Раздел 4.2» и т.п.

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

  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ?? content.match(/(\{[\s\S]*\})/)
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content

  try {
    return JSON.parse(jsonStr)
  } catch {
    return { error: 'Не удалось разобрать ответ LLM', raw: content }
  }
}
