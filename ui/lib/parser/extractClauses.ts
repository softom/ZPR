/**
 * Серверная обёртка над LLM (Polza.AI / Claude Sonnet 4.6) — извлекает из текста
 * договора структурированные данные для модуля A (Загрузчик договора).
 *
 * ВЫХОД — соответствует таблицам legal_entities + documents + contract_clauses
 * (см. 17_Сущность_Договор_и_ЮрЛицо.md, 19_Сущность_Юридическое_лицо.md).
 *
 * Не работает с событиями (events). События появляются в модуле C (Этап 3).
 */

import { PROJECT_GLOSSARY } from '@/lib/llm/projectGlossary'

const POLZA_BASE_URL = process.env.POLZA_BASE_URL ?? 'https://polza.ai/api/v1'
const POLZA_API_KEY  = process.env.POLZA_API_KEY ?? ''
const LLM_MODEL      = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-4.6'

// Поднято с 90_000 до 180_000 (2026-05-19): Claude Sonnet 4.6 имеет 200K токенов
// контекста, ~180K символов кириллицы ≈ ~70K токенов — впритык, но безопасно.
// Прежний лимит 90K обрезал длинные договоры на середине: например, у договора
// 26-01-1 (146 852 chars) «Приложение №3 Календарный план» начинается на pos 91 071
// и оставался невидим для LLM → даты этапов терялись.
const TEXT_LIMIT = 180_000

export interface ObjectInfo {
  code: string
  current_name: string
  contractor: string | null
  aliases: string[]
}

export interface ProjectStage {
  code: string       // 'foresketch' | 'concept' | 'project' | 'working_docs' | 'expertise' | ...
  label: string      // 'Фор-Эскиз', 'Концепция', ...
  sort_order: number
}

/**
 * Информация о типе события договора из классификатора `contract_event_types`.
 * Передаётся в LLM-промпт `extractContractClauses` чтобы LLM мог проставить
 * `event_type_code` каждому пункту. ID сервер резолвит сам.
 */
export interface ContractEventTypeInfo {
  code: string                                            // 'fin_advance', 'work_stage' и т.п.
  category: 'fin'|'work'|'term'|'legal'|'appr'|'comm'|'ctrl'
  label: string                                           // «Аванс»
  is_intermediate: boolean
  is_anchor: boolean
}

export interface PartyInfo {
  name: string
  inn: string
  kpp: string
  address: string
  signatory_name: string
  signatory_position: string
  role: string  // как в договоре: «Заказчик» / «Подрядчик» / «Исполнитель» и т.п.
}

/**
 * База отсчёта относительного срока в пункте договора.
 * Совпадает с CHECK-ограничением `contract_clauses.term_base`.
 *
 * ⛔ ЕДИНСТВЕННОЕ ДОПУСТИМОЕ ЗНАЧЕНИЕ — 'clause'.
 *
 * Все ссылки идут на КОНКРЕТНЫЙ пункт договора через `term_ref_clause_id`.
 * Для семантики «с подписания договора» оператор выбирает в UI **якорный пункт**
 * (is_anchor=true, всегда первый, описание «Дата заключения договора»).
 *
 * См. WIKI 17 → «⛔ Запрещённые term_base».
 */
export type TermBase =
  | 'clause'      // от КОНКРЕТНОГО пункта (term_ref_clause_id обязателен)

export interface ClauseInfo {
  order_index: number

  // Абсолютная дата (если в тексте прямо указана)
  clause_date: string | null   // YYYY-MM-DD

  // Относительный срок (если в тексте формула «N дней от <базы>»).
  // Может заполняться вместе с clause_date или вместо неё.
  term_days: number | null
  term_type: 'working' | 'calendar' | null
  term_base: TermBase | null
  term_text: string | null     // оригинальная формулировка из договора
  /**
   * Опционально — UUID конкретного пункта-источника (когда term_base='clause').
   * LLM это поле НЕ заполняет (не знает UUID); сервер резолвит из term_ref_event_type_code
   * + term_ref_stage_number, либо оператор задаёт вручную в UI.
   */
  term_ref_clause_id?: string | null

  /**
   * Структурная ссылка LLM на пункт-источник относительного срока (с 2026-05-18).
   *
   * Если term_text содержит ссылку на другое событие договора («5 раб. дней с даты
   * начала выполнения работ по Этапу 1»), LLM ставит:
   *   - term_ref_event_type_code = 'work_start' (тип источника)
   *   - term_ref_stage_number    = 1            (этап источника, если применимо)
   *
   * Сервер в /clauses/replace ищет в БД пункт с event_type_id=resolveCode и
   * stage_id=resolveStage; если ровно 1 кандидат → выставляет term_ref_clause_id.
   * Если 0/несколько — оставляет null, оператор довязывает в UI.
   *
   * Особый случай: ссылка на дату подписания договора → term_ref_event_type_code='legal_contract_sign'
   * (либо просто оставить null — сработает старая эвристика `refersToContractSigning`).
   */
  term_ref_event_type_code?: string | null
  term_ref_stage_number?: number | null

  description: string
  note: string | null
  source_page: number | null
  source_quote: string

  /**
   * Привязка пункта к этапу договора. Заполняется LLM по контексту
   * `contractStages` (из `extractContractStages`).
   * - число (1, 2, 3) — пункт относится к этапу с таким `stage_number`.
   * - null — пункт общий по договору (например, авансы без привязки к этапу,
   *   юридические пункты, обязательства сторон).
   * На сервере резолвится в `stage_id` через map `stage_number → contract_stages.id`.
   */
  stage_number?: number | null

  /**
   * Режим пункта — какое поле определяющее. См. WIKI 17 «Режим пункта».
   * - 'date': clause_date — источник истины, term_* read-only справка.
   * - 'term': term_* — источник истины, clause_date вычисляется.
   * - null:   ни дата, ни срок не введены (новый пустой пункт).
   * LLM не возвращает это поле — выставляется на сервере (см. buildClauseRows.inferMode).
   */
  date_mode?: 'date' | 'term' | null

  /**
   * Денормализованная категория (синкается на сервере из event_type_code).
   * 7 значений: fin/work/term/legal/appr/comm/ctrl.
   * LLM может вернуть для backward-compat, но основной источник — event_type_code.
   */
  category?: 'fin' | 'work' | 'term' | 'legal' | 'appr' | 'comm' | 'ctrl' | null

  /**
   * Код типа события договора (классификатор contract_event_types, см. WIKI 17 v1.3).
   * Возвращается LLM из списка из 31 кода (см. промпт). На сервере резолвится
   * в event_type_id (uuid). Если LLM не уверен — null; оператор поставит вручную в UI.
   * НЕ присваивать 'legal_contract_sign' — это код anchor-пункта, его сервер ставит сам.
   */
  event_type_code?: string | null

  // UI-only: стабильный id для dnd-kit drag&drop. Не передаётся в БД.
  _id?: string
}

export interface ContractAnalysis {
  title: string
  number: string
  signed_date: string | null   // YYYY-MM-DD
  contract_type: string        // «Договор» / «ДС» / «Акт»
  version: string              // «v1», «ДС1»
  subject: string
  amount: string
  project_stage: string | null // FK → project_stages.code
  customer: PartyInfo
  contractor: PartyInfo
  object_codes: string[]
  /**
   * Словарь { object_code: [имена_объекта_из_текста_договора] }.
   * Все варианты, которыми объект упомянут в договоре — для пополнения
   * `objects.aliases` («Публичные имена»). Заполняется LLM.
   */
  object_aliases?: Record<string, string[]>
  clauses: ClauseInfo[]
}

/**
 * Один проход LLM — извлекает метаданные + clauses.
 * Если `contractStages` передан (с предварительного прохода `extractContractStages`),
 * LLM также проставит каждому clause поле `stage_number` (привязка к этапу).
 * Если `eventTypes` передан — LLM проставит `event_type_code` (классификатор contract_event_types).
 */
export async function extractContractClauses(
  text: string,
  objects: ObjectInfo[],
  projectStages: ProjectStage[] = [],
  contractStages: { stage_number: number; stage_name: string }[] = [],
  eventTypes: ContractEventTypeInfo[] = [],
): Promise<ContractAnalysis> {
  const prompt = buildPrompt(text, objects, projectStages, contractStages, eventTypes)
  const raw = await callLLM(prompt)
  return raw as ContractAnalysis
}

/**
 * Облегчённый проход LLM — извлекает ТОЛЬКО метаданные (стороны, объекты, стадия,
 * заголовок, дата). НЕ трогает clauses и НЕ требует этапов договора.
 *
 * Используется при первичной загрузке договора (`/api/contracts/v2/analyze`).
 * Этапы и пункты выделяются позже через отдельные кнопки в карточке договора:
 *   - «🎯 Выделить этапы»            → POST /extract-stages
 *   - «🎯 Выделить события договора» → POST /reparse { skip_stages: true } + /clauses/replace
 *
 * Экономит ~50% LLM-токенов на первичной загрузке (раньше «холостой прогон»
 * пробегал по пунктам до выделения этапов).
 */
export async function extractContractMetadata(
  text: string,
  objects: ObjectInfo[],
  projectStages: ProjectStage[] = [],
): Promise<ContractAnalysis> {
  const prompt = buildMetadataPrompt(text, objects, projectStages)
  const raw = await callLLM(prompt) as Partial<ContractAnalysis>
  return {
    title:          raw.title          ?? '',
    number:         raw.number         ?? '',
    signed_date:    raw.signed_date    ?? null,
    contract_type:  raw.contract_type  ?? '',
    version:        raw.version        ?? '',
    subject:        raw.subject        ?? '',
    amount:         raw.amount         ?? '',
    project_stage:  raw.project_stage  ?? null,
    customer:       raw.customer       ?? { name:'', inn:'', kpp:'', address:'', signatory_name:'', signatory_position:'', role:'' },
    contractor:     raw.contractor     ?? { name:'', inn:'', kpp:'', address:'', signatory_name:'', signatory_position:'', role:'' },
    object_codes:   raw.object_codes   ?? [],
    object_aliases: raw.object_aliases ?? {},
    clauses:        [],   // пустой — извлекаются отдельно
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

function buildStagesHint(stages: ProjectStage[]): string {
  if (!stages.length) return '(стадии не заданы — верни null)'
  return stages
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(s => `  ${s.code} — ${s.label}`)
    .join('\n')
}

function buildEventTypesHint(types: ContractEventTypeInfo[]): string {
  if (!types.length) return '(классификатор не передан — оставь event_type_code = null)'
  const CAT_LABEL: Record<ContractEventTypeInfo['category'], string> = {
    fin:   'Финансовые',
    work:  'Производственные',
    term:  'Сроковые',
    legal: 'Юридические',
    appr:  'Согласовательные',
    ctrl:  'Контрольные / приёмочные',
    comm:  'Коммуникационные',
  }
  // Группируем по категории, anchor-типы помечаем чтобы LLM их не использовал
  const grouped = new Map<string, ContractEventTypeInfo[]>()
  for (const t of types) {
    const arr = grouped.get(t.category) ?? []
    arr.push(t)
    grouped.set(t.category, arr)
  }
  const order: ContractEventTypeInfo['category'][] = ['legal','work','fin','term','appr','ctrl','comm']
  return order
    .filter(cat => grouped.has(cat))
    .map(cat => {
      const lines = (grouped.get(cat) ?? []).map(t => {
        const flags: string[] = []
        if (t.is_anchor) flags.push('ANCHOR — не создавай руками')
        if (t.is_intermediate) flags.push('промежуточный')
        const flagStr = flags.length ? ` [${flags.join(', ')}]` : ''
        return `  ${t.code.padEnd(24)} — ${t.label}${flagStr}`
      }).join('\n')
      return `\n${CAT_LABEL[cat]} (${cat}):\n${lines}`
    })
    .join('\n')
}

function buildContractStagesHint(stages: { stage_number: number; stage_name: string }[]): string {
  if (!stages.length) {
    return '(этапы договора не выделены — оставь stage_number = null у всех clauses)'
  }
  return stages
    .map(s => `  ${s.stage_number} — ${s.stage_name}`)
    .join('\n')
}

/**
 * Промпт «только метаданные» — без секции пунктов договора.
 * Используется при первичной загрузке: пункты выделяются позже отдельной кнопкой.
 */
function buildMetadataPrompt(
  text: string,
  objects: ObjectInfo[],
  stages: ProjectStage[],
): string {
  const truncated = text.length > TEXT_LIMIT
    ? text.slice(0, TEXT_LIMIT) + '\n[...текст обрезан...]'
    : text
  const objectsHint = buildObjectsHint(objects)
  const stagesHint  = buildStagesHint(stages)

  return `Ты помощник по обработке строительных договоров. Проанализируй текст и верни ТОЛЬКО JSON-объект без пояснений.

${PROJECT_GLOSSARY}

В тексте сохранены маркеры страниц вида «[PAGE N]». Используй их, чтобы заполнить поле "source_page".

⚠️ ВАЖНО: На этом этапе извлекаются ТОЛЬКО метаданные и стороны.
Пункты договора (clauses) и этапы (stages) НЕ требуются — они выделяются отдельными запросами.

═══ МЕТАДАННЫЕ ДОГОВОРА ═══

"title"  — короткое название (до 80 символов). Включай номер договора. Пример: «Договор Альфа+ № 0000-00 ABC».
"number" — номер договора как в тексте (например «2604-01», «ХГ-2026-003», «20250611/К»). Пустая строка если нет.
"signed_date" — дата подписания в формате YYYY-MM-DD.
  ГДЕ ИСКАТЬ: «г. Москва, "__" ___ 202_ г.», рядом с подписями, в реквизитах «Договор № ___ от ДД.ММ.ГГГГ».
  Если не найдена — null.
"contract_type" — «Договор» / «ДС» / «Акт».
"version" — «v1» для первичного договора, «ДС1»/«ДС2»... для доп.соглашений.
"subject" — предмет договора одним предложением.
"amount" — итоговая сумма с валютой («1 250 000 ₽»). Пустая строка если нет.

═══ СТАДИЯ ПРОЕКТА ═══

"project_stage" — стадия проектирования, к которой относится договор. Один из кодов:
${stagesHint}

ПОДСКАЗКИ ПО КЛЮЧЕВЫМ СЛОВАМ:
  - «фор-эскиз», «эскизный проект», «эскиз»                       → foresketch
  - «концепция», «концептуальное решение», «АГК»,
    «архитектурно-градостроительная концепция»                    → concept
  - «проектная документация», «стадия П», просто «проект»
    (без слова «рабочая»)                                          → project
  - «рабочая документация», «РД», «стадия Р»                       → working_docs
  - «экспертиза», «прохождение экспертизы»,
    «государственная экспертиза», «негосударственная экспертиза»   → expertise

Если стадия не определяется или договор не привязан к конкретной стадии — null.

═══ СТОРОНЫ ДОГОВОРА ═══

Найди ЗАКАЗЧИКА и ПОДРЯДЧИКА (или ИСПОЛНИТЕЛЯ, ПРОЕКТИРОВЩИКА). Реквизиты ищи везде:
в шапке, в разделе «Реквизиты сторон», рядом с подписями в конце.

"customer" — сторона с ролью «Заказчик» / «Технический заказчик» / «Застройщик»:
  - "name": полное наименование как в договоре (например «ООО «Альфа»»)
  - "inn": ИНН — 10 цифр (юр.лица) или 12 цифр (ИП)
  - "kpp": КПП — 9 цифр. Пустая строка для ИП и физ.лиц.
  - "address": юридический адрес. Пустая строка если не найден.
  - "signatory_name": ФИО подписанта («Иванов Иван Иванович»). Пустая строка если не найден.
  - "signatory_position": должность («Генеральный директор», «Директор»). Пустая строка если не найдено.
  - "role": как написано в договоре («Заказчик», «Технический заказчик» и т.п.)

"contractor" — сторона с ролью «Подрядчик» / «Исполнитель» / «Проектировщик»:
  Те же поля. Реквизиты обычно в разделе «Реквизиты сторон» в конце.

═══ ОБЪЕКТЫ ═══

"object_codes" — коды объектов из таблицы. Сопоставляй по коду, названию, псевдониму.
Таблица объектов проекта:
${objectsHint}
Верни только коды из этой таблицы. Пустой массив если не нашёл соответствий.

"object_aliases" — словарь { object_code: [названия_из_текста, ...] }.
Для КАЖДОГО объекта из object_codes — собери ВСЕ варианты, как объект назван в тексте.

═══ ФОРМАТ ВОЗВРАТА ═══

Верни ОДИН JSON-объект (БЕЗ поля "clauses"):
{
  "title": "...",
  "number": "...",
  "signed_date": "YYYY-MM-DD" | null,
  "contract_type": "...",
  "version": "...",
  "subject": "...",
  "amount": "...",
  "project_stage": "foresketch" | "concept" | "project" | "working_docs" | "expertise" | null,
  "customer": { name, inn, kpp, address, signatory_name, signatory_position, role },
  "contractor": { name, inn, kpp, address, signatory_name, signatory_position, role },
  "object_codes": ["..."],
  "object_aliases": { "<code>": ["имя_из_текста1", ...], ... }
}

ТЕКСТ ДОКУМЕНТА:
${truncated}`
}

function buildPrompt(
  text: string,
  objects: ObjectInfo[],
  stages: ProjectStage[],
  contractStages: { stage_number: number; stage_name: string }[] = [],
  eventTypes: ContractEventTypeInfo[] = [],
): string {
  const truncated = text.length > TEXT_LIMIT
    ? text.slice(0, TEXT_LIMIT) + '\n[...текст обрезан...]'
    : text
  const objectsHint = buildObjectsHint(objects)
  const contractStagesHint = buildContractStagesHint(contractStages)
  const stagesHint  = buildStagesHint(stages)
  const eventTypesHint = buildEventTypesHint(eventTypes)

  return `Ты помощник по обработке строительных договоров. Проанализируй текст и верни ТОЛЬКО JSON-объект без пояснений.

${PROJECT_GLOSSARY}

В тексте сохранены маркеры страниц вида «[PAGE N]». Используй их, чтобы заполнить поле "source_page".

═══ МЕТАДАННЫЕ ДОГОВОРА ═══

"title"  — короткое название (до 80 символов). Включай номер договора. Пример: «Договор Альфа+ № 0000-00 ABC».
"number" — номер договора как в тексте (например «2604-01», «ХГ-2026-003», «20250611/К»). Пустая строка если нет.
"signed_date" — дата подписания в формате YYYY-MM-DD.
  ГДЕ ИСКАТЬ: «г. Москва, "__" ___ 202_ г.», рядом с подписями, в реквизитах «Договор № ___ от ДД.ММ.ГГГГ».
  Если не найдена — null.
"contract_type" — «Договор» / «ДС» / «Акт».
"version" — «v1» для первичного договора, «ДС1»/«ДС2»... для доп.соглашений.
"subject" — предмет договора одним предложением.
"amount" — итоговая сумма с валютой («1 250 000 ₽»). Пустая строка если нет.

═══ СТАДИЯ ПРОЕКТА ═══

"project_stage" — стадия проектирования, к которой относится договор. Один из кодов:
${stagesHint}

ПОДСКАЗКИ ПО КЛЮЧЕВЫМ СЛОВАМ:
  - «фор-эскиз», «эскизный проект», «эскиз»                       → foresketch
  - «концепция», «концептуальное решение», «АГК»,
    «архитектурно-градостроительная концепция»                    → concept
  - «проектная документация», «стадия П», просто «проект»
    (без слова «рабочая»)                                          → project
  - «рабочая документация», «РД», «стадия Р»                       → working_docs
  - «экспертиза», «прохождение экспертизы»,
    «государственная экспертиза», «негосударственная экспертиза»   → expertise

Если стадия не определяется или договор не привязан к конкретной стадии — null.

═══ СТОРОНЫ ДОГОВОРА ═══

Найди ЗАКАЗЧИКА и ПОДРЯДЧИКА (или ИСПОЛНИТЕЛЯ, ПРОЕКТИРОВЩИКА). Реквизиты ищи везде:
в шапке, в разделе «Реквизиты сторон», рядом с подписями в конце.

"customer" — сторона с ролью «Заказчик» / «Технический заказчик» / «Застройщик»:
  - "name": полное наименование как в договоре (например «ООО «Альфа»»)
  - "inn": ИНН — 10 цифр (юр.лица) или 12 цифр (ИП)
  - "kpp": КПП — 9 цифр. Пустая строка для ИП и физ.лиц.
  - "address": юридический адрес. Пустая строка если не найден.
  - "signatory_name": ФИО подписанта («Иванов Иван Иванович»). Пустая строка если не найден.
  - "signatory_position": должность («Генеральный директор», «Директор»). Пустая строка если не найдено.
  - "role": как написано в договоре («Заказчик», «Технический заказчик» и т.п.)

"contractor" — сторона с ролью «Подрядчик» / «Исполнитель» / «Проектировщик»:
  Те же поля. Реквизиты обычно в разделе «Реквизиты сторон» в конце.

═══ ОБЪЕКТЫ ═══

"object_codes" — коды объектов из таблицы. Сопоставляй по коду, названию, псевдониму.
Таблица объектов проекта:
${objectsHint}
Верни только коды из этой таблицы. Пустой массив если не нашёл соответствий.

"object_aliases" — словарь { object_code: [названия_из_текста, ...] }.
Для КАЖДОГО объекта из object_codes — собери ВСЕ варианты, как объект назван
в тексте договора (полные названия, сокращения, маркетинговые имена,
неформальные обозначения). Это для пополнения справочника публичных имён.

Примеры включай:
  - «Отель Health 5*», «Health-отель», «ОБЪЕКТ № 6», «4* Family Солнышко»
  - неформальные/маркетинговые имена: «Изумруд», «Жемчужина»
  - сокращения и аббревиатуры: «ГОСТ-400», «АПТ»

НЕ включай:
  - текущее «current_name» объекта из таблицы выше (его и так знаем)
  - сам код «106_ГОСТИНИЦА_350»
  - псевдонимы, которые УЖЕ есть в таблице (там после «псевдонимы:»)
  - общие слова без названия: «отель», «объект» — без конкретики

Формат: { "106_ГОСТИНИЦА_350": ["Health Отель", "Объект №6"], "102_ГОСТИНИЦА_800": ["Family Солнышко"] }
Пустой объект {} если в тексте только current_name/код, без вариантов.

═══ ПУНКТЫ ДОГОВОРА (ГЛАВНОЕ) ═══

"clauses" — массив пунктов договора с датами. **Один пункт = одно событие с одной датой/сроком.**

ИСТОЧНИКИ ПУНКТОВ (в порядке приоритета):
  1. План работ / Календарный план (Приложение №2/3/4) — таблица «Этап | Наименование | Срок»
  2. ДС с собственными датами — переопределяют этапы основного договора
  3. Раздел «Сроки выполнения работ» / «Этапы выполнения»
  4. Любые упоминания дат в тексте (платежи, сдача документации, утверждение и т.п.)

ВАЖНО: пункт договора ≠ событие проекта. Извлекай ВСЁ что имеет дату: этапы работ,
аванс, окончательный расчёт, сдачу акта, согласование, подписание ДС и т.п.

🛑 НЕ СОЗДАВАЙ пункт «Подписание (настоящего) Договора» / «Заключение Договора» / «Дата заключения договора»:
  Этот пункт **уже добавляется автоматически** системой как якорный пункт #1
  с описанием «Дата заключения договора» (на основе signed_date).
  Не дублируй его. Если в тексте видишь «г. Москва, 20 марта 2026 г. ... заключили
  настоящий Договор» — это просто маркер даты подписания, отдельный пункт не нужен.

  Когда другие пункты ссылаются на дату подписания («5 рабочих дней с даты подписания
  Договора»), сохраняй формулировку в term_text — система автоматически привяжет
  такой пункт к якорю (term_ref_clause_id будет указывать на якорный пункт).

🛑 ПРАВИЛО ОДИН-ПУНКТ-ОДНО-СОБЫТИЕ — критическое для парных событий:

Если в одном фрагменте текста договора упомянуто **несколько** независимых событий
с разными датами/сроками — создай **столько же отдельных пунктов**. НЕ объединяй их
в один пункт «Окончание работ» с приме­чанием про начало.

ПАРНЫЕ СОБЫТИЯ — всегда два отдельных пункта:
  • «Начало выполнения работ» + «Окончание выполнения работ» по этапу
  • «Сдача документации» + «Подписание Акта» (или «Получение замечаний»)
  • «Аванс» + «Окончательный расчёт»
  • «Подписание Договора» + «Окончание срока действия»
  • «Запрос материалов» + «Получение материалов»

ПРИМЕР ❌ НЕПРАВИЛЬНО (объединил):
  Текст: «Этап 2. ОПР. Начало — дата, следующая за подписанием Акта Этапа 1.
          Окончание — 35 рабочих дней с даты начала.»
  ❌ Один пункт «Окончание выполнения работ по Этапу 2», в note: «Начало — после акта».

ПРИМЕР ✅ ПРАВИЛЬНО (две независимых записи):
  ✅ Пункт A: description='Начало выполнения работ по Этапу 2 (ОПР)',
              term_text='дата, следующая за подписанием Акта по Этапу 1',
              term_days=null или 1, source_quote из абзаца про Начало.
  ✅ Пункт B: description='Окончание выполнения работ по Этапу 2 (ОПР)',
              term_days=35, term_type='working',
              term_text='35 рабочих дней с даты начала Этапа 2',
              source_quote из абзаца про Окончание.

Каждый пункт получает свой order_index (последовательно). Оператор позже свяжет
их через term_ref_clause_id в UI («Окончание ссылается на Начало», «Начало
ссылается на Подписание Акта Этапа 1»).

Структура каждого пункта:
  - "order_index": порядковый номер в договоре (1, 2, 3...). Сохраняй последовательность как в документе.

  - "clause_date": **АБСОЛЮТНАЯ** дата срока YYYY-MM-DD, если в тексте прямо указана. Если только месяц/квартал —
    бери последний день периода (Q1=31.03, Q2=30.06, Q3=30.09, Q4=31.12).
    **НЕ ВЫЧИСЛЯЙ** clause_date из относительных сроков — это сделает редактор графика.
    Если в тексте только относительный срок («N дней с подписания»), а абсолютной даты нет — clause_date=null.

  - "term_days", "term_type", "term_text": **ОТНОСИТЕЛЬНЫЙ СРОК** (формула).
    Заполни если в тексте есть «через/в течение N рабочих/календарных дней <база>».
      • "term_days" — число (например 15, 35, 5).
      • "term_type" — 'working' (рабочие, пн–пт) или 'calendar' (календарные).
      • "term_text" — ОРИГИНАЛЬНАЯ формулировка срока, как написана в договоре.
        Пример: «15 (Пятнадцать) рабочих дней с даты подписания настоящего Договора».
    Если относительного срока в тексте нет — все три поля null.

  🛑 "term_base" и "term_ref_clause_id" — ВСЕГДА null. UUID сервер сам подставит.

  ═══ ПРИВЯЗКА ОТНОСИТЕЛЬНОГО СРОКА К ПУНКТУ-ИСТОЧНИКУ ═══

  Если term_text содержит относительную привязку к ДРУГОМУ событию договора —
  заполни **структурно** через два поля (не через UUID):

    - "term_ref_event_type_code" — код типа события-источника (из классификатора выше)
    - "term_ref_stage_number"    — номер этапа источника (если ссылка специфична к этапу)

  Сервер найдёт пункт с этим типом+этапом и проставит term_ref_clause_id автоматически.

  Маппинг типичных формулировок:
    «с даты подписания / заключения настоящего Договора»  → legal_contract_sign (этап null)
    «с даты начала выполнения работ по Этапу N»            → work_start (stage=N)
    «с даты окончания выполнения работ по Этапу N»         → work_result_delivery (stage=N)
    «с даты подписания Акта сдачи-приёмки по Этапу N»      → ctrl_act_signing (stage=N)
    «с даты получения замечаний Заказчика по Этапу N»      → appr_remarks (stage=N)
    «с даты передачи исходных данных»                      → work_input_handover (этап null или указанный)
    «с даты получения аванса по Этапу N»                   → fin_advance (stage=N)
    «после Этапа N-1»                                       → work_result_delivery (stage=N-1)

  Правила:
    • Если ссылка явно к этапу («по Этапу 2», «по Этапу 1 (Массинг)») — заполни term_ref_stage_number.
    • Если ссылка общего характера («с подписания договора», «с передачи исх. данных») — оставь
      term_ref_stage_number = null.
    • Если не уверен или ссылка неоднозначна («после сдачи документации» — какой документации?) —
      оба поля null, оператор довяжет в UI.
    • НЕ выдумывай связь, если в тексте её нет. Лучше null.

  - "description": краткое описание пункта (1-2 предложения). Пример: «Сдача форэскиза по объекту 001_TYPE_VAL».

  - "note": дополнительная информация для оператора — вторая дата (если диапазон), сумма для платежа,
    оговорки. **НЕ дублируй сюда term_text** — для срока есть отдельные поля. null если нет.

  - "source_page": номер страницы PDF, где найден пункт (по маркеру [PAGE N]). null если не уверен.
  - "source_quote": точная цитата из договора (1-3 предложения), которая стала источником пункта.

  - "event_type_code": код типа события договора из классификатора ниже.
                       Это ОСНОВНОЙ способ типизации пункта. Категория (category)
                       выводится сервером автоматически из выбранного кода.

═══ КЛАССИФИКАТОР СОБЫТИЙ ДОГОВОРА (event_type_code) ═══

Выбирай НАИБОЛЕЕ ТОЧНЫЙ код из списка. Если не уверен — оставь null,
оператор поставит вручную. **Не используй legal_contract_sign** —
это код якорного пункта, который сервер создаёт сам.
${eventTypesHint}

  - "category": **denorm от event_type_code**. Можешь не возвращать (сервер сам
    проставит из таблицы classifier). Если возвращаешь, используй один из 7:
      'fin'   — финансовый
      'work'  — производственный
      'term'  — сроковый (дедлайн, перенос, приостановка, просрочка)
      'legal' — юридический
      'appr'  — согласовательный
      'comm'  — коммуникационный
      'ctrl'  — контрольный/приёмочный

ПРАВИЛО ДАТА vs СРОК:
  • Только абсолютная дата в тексте       → clause_date=YYYY-MM-DD, term_*=null
  • Только относительный срок              → clause_date=null,        term_* заполнено
  • И то, и другое (бывает: дата-ориентир + формула) → заполняй оба
  • Ничего нет                             → всё null

🛑 КРИТИЧЕСКИЙ ЗАПРЕТ — НЕ ВЫЧИСЛЯЙ clause_date САМОСТОЯТЕЛЬНО.

Если в тексте есть только относительный срок (например «5 рабочих дней с даты подписания»),
а конкретной абсолютной даты пункта в тексте НЕТ — **строго** clause_date=null.
НЕ складывай signed_date + term_days. НЕ интерпретируй формулу в дату.
Это работа редактора графика, не твоя.

ПРИМЕР ❌ НЕПРАВИЛЬНО (часто ошибаются):
  Текст пункта: «Аванс 30% по Этапу 1 — 5 рабочих дней с даты подписания договора»
  signed_date: 2026-01-21
  ❌ clause_date=2026-01-28, term_days=5 ...
  ✅ ПРАВИЛЬНО: clause_date=null, term_days=5, term_type='working', term_base='contract',
                term_text='5 рабочих дней с даты подписания договора'

ПРИМЕР ✅ только абсолютная дата:
  Текст: «Сдача форэскиза до 15.05.2026»
  ✅ clause_date='2026-05-15', term_*=null

ПРИМЕР ✅ обе даны явно:
  Текст: «Сдача КД до 15.05.2026 (что составляет 35 рабочих дней с начала работ)»
  ✅ clause_date='2026-05-15', term_days=35, term_type='working', term_base='start',
       term_text='35 рабочих дней с начала работ'

ПРИМЕР ✅ месяц/квартал без относительного срока:
  Текст: «Сдача — Q2 2026»
  ✅ clause_date='2026-06-30' (последний день квартала), term_*=null

ПРИНЦИП: чем больше пунктов извлечёшь, тем лучше. Оператор потом подчистит лишнее в редакторе.
Лучше 15 пунктов с разными датами, чем 3 «обобщённых».

═══ ПРИВЯЗКА ПУНКТА К ЭТАПУ ДОГОВОРА ═══

"stage_number" — номер этапа договора, к которому относится этот пункт. null если общий пункт.

Этапы договора (выделены на проходе 1):
${contractStagesHint}

Правила:
  • Если этапов нет (список выше пуст) — у всех clauses stage_number=null.
  • Если в описании пункта явно упоминается «Этап 1», «Этап 2», «АГК», «ОПР» и т.п.,
    которые совпадают с одним из этапов выше — поставь соответствующий stage_number.
  • Авансы и окончательные расчёты по этапу — относятся к этому этапу
    (например «Аванс 30% по Этапу 1» → stage_number=1).
  • Общие пункты договора (обязательства сторон, юридические условия, реквизиты,
    подписание самого договора) — stage_number=null.
  • Якорный пункт «Дата заключения договора» не создаётся LLM — у него
    автоматически stage_id=null на сервере.

═══ ФОРМАТ ВОЗВРАТА ═══

Верни ОДИН JSON-объект:
{
  "title": "...",
  "number": "...",
  "signed_date": "YYYY-MM-DD" | null,
  "contract_type": "...",
  "version": "...",
  "subject": "...",
  "amount": "...",
  "project_stage": "foresketch" | "concept" | "project" | "working_docs" | "expertise" | null,
  "customer": { name, inn, kpp, address, signatory_name, signatory_position, role },
  "contractor": { name, inn, kpp, address, signatory_name, signatory_position, role },
  "object_codes": ["..."],
  "object_aliases": { "<code>": ["имя_из_текста1", "имя_из_текста2"], ... },
  "clauses": [
    {
      "order_index": <int>,
      "clause_date": "YYYY-MM-DD" | null,
      "term_days":   <int> | null,
      "term_type":   "working" | "calendar" | null,
      "term_base":   null,                                  // всегда null — сервер ставит сам
      "term_text":   "<оригинальная формулировка>" | null,
      "term_ref_event_type_code": "<код из классификатора>" | null,  // см. «ПРИВЯЗКА ОТНОСИТЕЛЬНОГО СРОКА»
      "term_ref_stage_number":    <int> | null,                       // этап источника (если специфичен)
      "description": "...",
      "note":        "..." | null,
      "source_page": <int> | null,
      "source_quote": "...",
      "event_type_code": "<код из классификатора>" | null,  // ← основной тип, см. КЛАССИФИКАТОР выше
      "category":        "fin"|"work"|"term"|"legal"|"appr"|"comm"|"ctrl" | null,  // denorm, можно опустить
      "stage_number":    <int> | null    // привязка к этапу договора из списка выше
    },
    ...
  ]
}

ТЕКСТ ДОКУМЕНТА:
${truncated}`
}

async function callLLM(prompt: string): Promise<unknown> {
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
    throw new Error(`Не удалось разобрать JSON-ответ LLM. Содержимое: ${content.slice(0, 200)}...`)
  }
}
