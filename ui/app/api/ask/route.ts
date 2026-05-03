import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const POLZA_BASE_URL  = process.env.POLZA_BASE_URL  ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY   = process.env.POLZA_API_KEY   ?? ''
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small'
const ASK_MODEL       = process.env.ASK_MODEL       ?? 'openai/gpt-4o-mini'

const MATCH_COUNT    = 10
const PER_DOC_LIMIT  = 3

// Русские стоп-слова + общие слова проекта (их не считаем keyword'ами,
// иначе каждый вопрос бустит все чанки и hybrid-поиск теряет смысл).
// NB: сравнение идёт ПОСЛЕ стемминга, поэтому здесь хранятся уже стеммированные формы.
const STOPWORDS = new Set([
  // предлоги / союзы / частицы
  'в','во','на','и','с','со','по','для','не','ни','что','это','из','от','до',
  'же','или','но','то','так','как','где','когда','почему','зачем','а','об','о',
  'если','бы','ли','уже','ещё','еще','при','под','над','за','у','к','про',
  // местоимения (и их стеммированные формы: кого/кому/ком → «ко», «ком»)
  'он','она','оно','они','его','её','их','меня','нас','вас','тебя','себя',
  'свой','своя','своё','свои','этот','эта','это','эти','тот','та','те',
  'какой','какая','какое','какие','каких','какой','каком','каким','какую',
  'какие','какаи','какое','каког','какой','каким','каких','какую',
  'который','которая','которое','которые','которо','которы',
  'чтобы','чем','все','всё','всех','всем',
  'мы','вы','ты','я','кто','кого','кому','ком','кем','что','чего','чему',
  'где','куда','откуда','есть','имее','имеются','имеется',
  // глаголы-связки и их стеммы
  'есть','быть','был','была','было','были','буду','будет','будут','будучи',
  'может','могут','можно','нужно','надо','стал','стала','стало','стали',
  // общие слова проекта — в стеммированной форме
  'догов','догово','документ','документе','документа','докуме','докумен',
  'проект','работ','работы','объект','объек','подряд','подрядч',
  'детал','детально','подробн','кратк','пожал','имеет','имеют',
  // служебные для вопроса
  'расскажи','пока','покажи','покаж','опиши','перечи','сколько','когда','есть',
])

// Простой стемминг для русских слов: срезаем типичные окончания.
// Без словарного анализа — чисто длинно-ориентированная эвристика.
// Для «Массингом» (9 символов) даёт «Массинг» (7). Цель — чтобы ILIKE
// в RPC находил все падежные формы одного термина.
function stem(word: string): string {
  if (word.length < 5) return word
  // Только для чисто-кириллических слов
  if (!/^[а-яё]+$/i.test(word)) return word
  // Правило: слова >=8 символов — срезаем 2, >=6 — срезаем 1.
  // Это грубо, но в 90% случаев даёт полезный префикс (общий стем форм).
  if (word.length >= 8) return word.slice(0, word.length - 2)
  if (word.length >= 6) return word.slice(0, word.length - 1)
  return word
}

function extractKeywords(question: string): string[] {
  // Токенизация: буквы (рус/лат), цифры, + и -, минимум 3 символа.
  // Даёт «Альфа+», «Массинг», «ОПР», «001», но не «и», «в», «на».
  const raw = question.toLowerCase().match(/[a-zа-яё0-9+\-]{3,}/gi) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const low = t.toLowerCase()
    const stemmed = stem(low)
    // Стоп-лист применяем к исходному слову И к стемме — ловим «кого» и «ко» одновременно
    if (STOPWORDS.has(low) || STOPWORDS.has(stemmed)) continue
    if (seen.has(stemmed)) continue
    seen.add(stemmed)
    out.push(stemmed)
  }
  return out
}

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─── System prompt — строго против cross-attribution ─────────────────────────

const SYSTEM_PROMPT = `Ты — ассистент проекта «Золотые Пески России» (строительство туристического комплекса).
Отвечаешь на вопросы по материалам проекта: договорам, письмам, документам.

СТРОГИЕ ПРАВИЛА (нарушение считается ошибкой):

1. АТРИБУЦИЯ. Каждый источник в блоке «Материалы» промаркирован метаданными:
   «Документ», «Тип», «Подрядчик», «Объекты». Эти поля — ЕДИНСТВЕННЫЙ способ
   определить, о какой сущности источник.

2. НЕ СМЕШИВАЙ ДОКУМЕНТЫ. Если пользователь спрашивает про конкретного
   подрядчика, объект или договор — используй ТОЛЬКО источники, где
   соответствующие метаданные ЯВНО указывают на эту сущность.
   • Пример ЗАПРЕЩЁННОГО: пользователь спросил про Альфа+, ты использовал
     факты из документа с «Подрядчик: Бета» и подписал их как «про Альфа+».
   • Если релевантных источников нет — отвечай: «В материалах нет данных
     по <сущность>», НЕ подменяй другими документами.

3. ЦИТАТЫ ОБЯЗАТЕЛЬНЫ. После каждого фактического утверждения ставь маркер
   [N] — номер источника. Утверждение без маркера — ошибка.

4. НЕ ВЫДУМЫВАЙ. Даты, суммы, номера, имена передавай только в исходном
   формате документа. Не домысливай то, чего нет в материалах.

5. НЕТ ОТВЕТА — СКАЖИ. Если в материалах нет ответа на вопрос, честно
   напиши: «В предоставленных материалах ответа нет».

6. ФОРМАТ. Язык — русский. Используй списки и таблицы Markdown, где уместно.
   Кратко и по делу.`

// ─── Типы ─────────────────────────────────────────────────────────────────────

type Chunk = {
  document_id: string
  chunk_text: string
  similarity: number | null
  title: string
  folder_path: string | null
  object_codes: string[] | null
  doc_type: string | null
  version: string | null
  contractor_name: string | null
  contractor_codes: string[] | null
}

type Citation = {
  n: number
  document_id: string
  title: string
  folder_path: string | null
  object_codes: string[] | null
  doc_type: string | null
  contractor_codes: string[] | null
  similarity: number | null
  snippet: string
}

type ContractorRow = { code: string; full_name: string }
type ObjectRow = { code: string; current_name: string; aliases: unknown }

type EntityFilters = {
  contractor_codes: string[]
  object_codes: string[]
  matched: Array<{ type: 'contractor' | 'object'; key: string; matched_from: string }>
}

// ─── Транслитерация кириллица↔латиница ───────────────────────────────────────

const CYR_TO_LAT: Record<string, string> = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh',
  'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
  'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts',
  'ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
}

function translitToLat(s: string): string {
  const lower = s.toLowerCase()
  let out = ''
  for (const ch of lower) out += CYR_TO_LAT[ch] ?? ch
  return out
}

// Проверяет, встречается ли ключ сущности в запросе (учитывая транслит)
function queryContainsEntity(query: string, entityKey: string): boolean {
  if (!entityKey || entityKey.length < 2) return false
  const ql = ` ${query.toLowerCase()} `
  const el = entityKey.toLowerCase()
  if (ql.includes(el)) return true
  // Транслит латиницей
  const elLat = translitToLat(el)
  if (elLat && elLat !== el && ql.includes(elLat)) return true
  // Транслит запроса — если пользователь ввёл латиницу, а сущность в кириллице
  const qlLat = translitToLat(ql)
  if (elLat && qlLat.includes(elLat)) return true
  return false
}

// ─── Entity extraction ────────────────────────────────────────────────────────

async function extractEntities(question: string): Promise<EntityFilters> {
  const filters: EntityFilters = {
    contractor_codes: [],
    object_codes: [],
    matched: [],
  }

  // 1. Подрядчики
  const { data: contractors } = await supabaseAdmin
    .from('contractors')
    .select('code, full_name')
    .returns<ContractorRow[]>()

  for (const c of contractors ?? []) {
    const candidates = [c.code, c.full_name].filter(Boolean) as string[]
    for (const candidate of candidates) {
      if (queryContainsEntity(question, candidate)) {
        if (!filters.contractor_codes.includes(c.code)) {
          filters.contractor_codes.push(c.code)
          filters.matched.push({ type: 'contractor', key: c.code, matched_from: candidate })
        }
        break
      }
    }
  }

  // 2. Объекты — по полному коду, текущему имени и алиасам
  const { data: objects } = await supabaseAdmin
    .from('objects')
    .select('code, current_name, aliases')
    .returns<ObjectRow[]>()

  for (const o of objects ?? []) {
    const aliases = Array.isArray(o.aliases) ? (o.aliases as unknown[]).map(x => String(x)) : []
    // Короткий код (цифровой префикс до первого _) тоже считаем алиасом
    const prefix = o.code.split('_')[0]
    const candidates = [o.code, o.current_name, prefix, ...aliases].filter(
      (x): x is string => typeof x === 'string' && x.length >= 3,
    )
    for (const candidate of candidates) {
      if (queryContainsEntity(question, candidate)) {
        if (!filters.object_codes.includes(o.code)) {
          filters.object_codes.push(o.code)
          filters.matched.push({ type: 'object', key: o.code, matched_from: candidate })
        }
        break
      }
    }
  }

  return filters
}

// ─── Контекст для LLM с полной атрибуцией ────────────────────────────────────

function buildContext(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => {
      const lines: string[] = [`[${i + 1}] Документ: ${c.title || '—'}`]
      const typeVersion = [c.doc_type, c.version].filter(Boolean).join(' · ')
      if (typeVersion) lines.push(`    Тип: ${typeVersion}`)
      const contractorParts: string[] = []
      if (c.contractor_codes?.length) contractorParts.push(c.contractor_codes.join(', '))
      if (c.contractor_name) contractorParts.push(`«${c.contractor_name}»`)
      if (contractorParts.length) lines.push(`    Подрядчик: ${contractorParts.join(' ')}`)
      if (c.object_codes?.length) lines.push(`    Объекты: ${c.object_codes.join(', ')}`)
      lines.push('')
      lines.push(c.chunk_text)
      return lines.join('\n')
    })
    .join('\n\n---\n\n')
}

// ─── Основной обработчик ──────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let question = ''
  try {
    const body = await request.json()
    question = (body?.question ?? '').toString().trim()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  if (question.length < 3) {
    return NextResponse.json({ error: 'Слишком короткий вопрос' }, { status: 400 })
  }

  // 1 — Извлекаем именованные сущности из вопроса (подрядчик, объект)
  const entities = await extractEntities(question)

  // 2 — Эмбеддинг вопроса
  const embResp = await fetch(`${POLZA_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: question }),
  })

  if (!embResp.ok) {
    const text = await embResp.text().catch(() => '')
    console.error('[ask] embeddings error:', embResp.status, text)
    return NextResponse.json({ error: 'Сервис эмбеддингов недоступен' }, { status: 502 })
  }

  const embData = await embResp.json()
  const embedding: number[] | undefined = embData?.data?.[0]?.embedding
  if (!embedding) {
    return NextResponse.json({ error: 'Пустой эмбеддинг' }, { status: 502 })
  }

  // 3 — Hybrid-поиск: вектор + keyword-boost + diversity-лимит на документ
  const keywords = extractKeywords(question)

  const rpcArgs: Record<string, unknown> = {
    query_embedding: embedding,
    match_count:     MATCH_COUNT,
    per_doc_limit:   PER_DOC_LIMIT,
  }
  if (entities.contractor_codes.length) rpcArgs.filter_contractor_codes = entities.contractor_codes
  if (entities.object_codes.length)     rpcArgs.filter_object_codes     = entities.object_codes
  if (keywords.length)                  rpcArgs.keyword_terms           = keywords

  const { data: rawChunks, error: rpcError } = await supabaseAdmin.rpc('search_documents', rpcArgs)

  if (rpcError) {
    console.error('[ask] rpc error:', rpcError.message)
    return NextResponse.json({ error: 'Ошибка поиска в БД', detail: rpcError.message }, { status: 500 })
  }

  const chunks = (rawChunks ?? []) as Chunk[]

  // 4 — Нет релевантных документов с учётом фильтров — честный отказ
  if (chunks.length === 0) {
    const matched = entities.matched.map(m =>
      m.type === 'contractor' ? `подрядчик «${m.key}»` : `объект «${m.key}»`,
    )
    const suffix = matched.length ? ` по запросу (${matched.join(', ')})` : ''
    return NextResponse.json({
      answer: `В предоставленных материалах ответа нет${suffix}.`,
      citations: [],
      entities_matched: entities.matched,
    })
  }

  // 5 — Собираем контекст с полной атрибуцией
  const context = buildContext(chunks)

  const entityHint = entities.matched.length
    ? `\n\nВ вопросе явно упомянуты сущности: ${entities.matched
        .map(m => `${m.type === 'contractor' ? 'подрядчик' : 'объект'} «${m.key}»`)
        .join(', ')}. Используй ТОЛЬКО источники, относящиеся к этим сущностям.`
    : ''

  const userMessage = `Вопрос: ${question}${entityHint}\n\nМатериалы:\n\n${context}`

  // 6 — Запрос к LLM
  const chatResp = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${POLZA_API_KEY}`,
    },
    body: JSON.stringify({
      model: ASK_MODEL,
      temperature: 0,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!chatResp.ok) {
    const text = await chatResp.text().catch(() => '')
    console.error('[ask] chat error:', chatResp.status, text)
    return NextResponse.json({ error: 'LLM недоступна' }, { status: 502 })
  }

  const chatData = await chatResp.json()
  const answer: string = chatData?.choices?.[0]?.message?.content?.trim() ?? ''

  if (!answer) {
    return NextResponse.json({ error: 'Пустой ответ LLM' }, { status: 502 })
  }

  // 7 — Цитаты
  const citations: Citation[] = chunks.map((c, i) => ({
    n: i + 1,
    document_id: c.document_id,
    title: c.title,
    folder_path: c.folder_path,
    object_codes: c.object_codes,
    doc_type: c.doc_type,
    contractor_codes: c.contractor_codes,
    similarity: c.similarity,
    snippet: c.chunk_text.length > 280 ? c.chunk_text.slice(0, 280) + '…' : c.chunk_text,
  }))

  return NextResponse.json({
    answer,
    citations,
    entities_matched: entities.matched,
    model: ASK_MODEL,
  })
}
