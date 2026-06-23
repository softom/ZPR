/**
 * Сериализатор MS Project XML (MSPDI).
 *
 * На вход — нормализованный список задач + связей + дефиниции ExtendedAttributes.
 * На выход — строка XML, готовая к скачиванию пользователем и открытию в MS Project.
 *
 * Намеренно ручная сборка строк XML (без XMLBuilder), т.к. структура MSPDI
 * фиксирована и нам нужен контроль над порядком/отступами для читаемости в Project.
 */

import {
  LINK_TYPE_TO_MSPDI,
  MSPDI_EXTENDED_FIELD_BY_NAME,
  OWNED_TASK_TAGS,
  type MspdiPassthroughField,
} from './mspdiTypes'

// ─── Входные типы ──────────────────────────────────────────────────────────

export interface SerializeTask {
  /** UID для MSPDI. Должен быть стабилен между выгрузками. */
  uid: number
  id: number | null
  name: string
  outlineLevel: number | null
  outlineNumber: string | null
  /** UID родительской задачи (для проверки иерархии и сортировки). */
  parentUid: number | null
  isSummary: boolean
  isMilestone: boolean
  manual: boolean
  start: string | null     // 'YYYY-MM-DD'
  finish: string | null
  /** Длительность в формате MSPDI: «PT240H0M0S». Если null — Project пометит срок «?». */
  duration: string | null
  percentComplete: number | null
  notes: string | null
  /** {fieldName → value}, e.g. {'Text1': '102_ГОСТИНИЦА_800'}. */
  extendedAttributes: Record<string, string>
  predecessors: Array<{
    predecessorUid: number
    type: 'FF' | 'FS' | 'SF' | 'SS'
    lagDays: number
    lagType: 'calendar' | 'working'
  }>
  /**
   * Сохранённый round-trip набор не-owned полей <Task> (упорядоченный).
   * null → UI-задача: сериализатор применяет шаблон newTaskTemplate.
   * Если undefined/отсутствует — обратная совместимость: старая генерация.
   */
  passthrough?: MspdiPassthroughField[] | null
}

export interface CalendarSerializeSettings {
  minutesPerDay?: number | null
  minutesPerWeek?: number | null
  daysPerMonth?: number | null
  defaultStartTime?: string | null
  defaultFinishTime?: string | null
}

export interface SerializeOptions {
  projectName?: string | null
  projectTitle?: string | null
  startDate?: string | null
  finishDate?: string | null
  /** Календарные настройки шапки (MinutesPerDay и т.п.). */
  calendar?: CalendarSerializeSettings
  /**
   * Декларации ExtendedAttributes для шапки. Если у поля есть `fieldId` —
   * сериализатор использует его при записи `<ExtendedAttribute>` в задачах.
   * Это даёт round-trip с Project: пишем в то же кастомное поле, что было в исходном XML.
   *
   * Если `fieldId` не задан — fallback на стандартный Text1..Text30 через
   * MSPDI_EXTENDED_FIELD_BY_NAME.
   */
  extendedAttributes?: Array<{ fieldName: string; alias: string; fieldId?: string }>
}

// ─── Хелперы XML ───────────────────────────────────────────────────────────

const XML_AMP = /&/g
const XML_LT = /</g
const XML_GT = />/g
const XML_QUOT = /"/g
const XML_APOS = /'/g

function xmlEscape(s: string): string {
  return s
    .replace(XML_AMP, '&amp;')
    .replace(XML_LT, '&lt;')
    .replace(XML_GT, '&gt;')
    .replace(XML_QUOT, '&quot;')
    .replace(XML_APOS, '&apos;')
}

function tag(name: string, value: string | number | null | undefined, indent = '      '): string {
  if (value === null || value === undefined || value === '') return ''
  return `${indent}<${name}>${xmlEscape(String(value))}</${name}>\n`
}

function tagBool(name: string, value: boolean, indent = '      '): string {
  return `${indent}<${name}>${value ? '1' : '0'}</${name}>\n`
}

/** Стандартный рабочий день для русского MS Project: 9:00–18:00 (9 часов). */
const DEFAULT_START_TIME  = '09:00:00'
const DEFAULT_FINISH_TIME = '18:00:00'

/** ISO-дата 'YYYY-MM-DD' → MSPDI datetime 'YYYY-MM-DDTHH:MM:SS'. */
function dateToMspdi(date: string | null | undefined, time: 'start' | 'finish'): string | null {
  if (!date) return null
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const t = time === 'start' ? DEFAULT_START_TIME : DEFAULT_FINISH_TIME
  return `${m[1]}-${m[2]}-${m[3]}T${t}`
}

// ─── Канонический порядок тегов <Task> (по образцу реального MS Project) ───

/**
 * Полный порядок тегов <Task> в MSPDI. Зафиксирован по orig_sample.xml.
 * Owned-теги (см. OWNED_TASK_TAGS) рендерятся из реляционных колонок,
 * остальные — из passthrough (или шаблона для UI-задач). Теги, которых нет
 * в этом списке, дописываются после канона в исходном порядке passthrough.
 *
 * Важные позиции: ConstraintDate ПОСЛЕ CalendarUID; PredecessorLink перед
 * IsPublished; ExtendedAttribute и Baseline — в самом конце.
 */
const CANONICAL_TASK_ORDER: readonly string[] = [
  'UID', 'GUID', 'ID', 'Name', 'Active', 'Manual', 'Type', 'IsNull', 'CreateDate',
  'WBS', 'OutlineNumber', 'OutlineLevel', 'Priority',
  'Start', 'Finish', 'Duration', 'ManualStart', 'ManualFinish', 'ManualDuration',
  'DurationFormat', 'FreeformDurationFormat', 'Work', 'ResumeValid', 'EffortDriven',
  'Recurring', 'OverAllocated', 'Estimated', 'Milestone', 'Summary', 'DisplayAsSummary',
  'Critical', 'IsSubproject', 'IsSubprojectReadOnly', 'ExternalTask',
  'EarlyStart', 'EarlyFinish', 'LateStart', 'LateFinish',
  'StartVariance', 'FinishVariance', 'WorkVariance',
  'FreeSlack', 'TotalSlack', 'StartSlack', 'FinishSlack',
  'FixedCost', 'FixedCostAccrual', 'PercentComplete', 'PercentWorkComplete',
  'Cost', 'OvertimeCost', 'OvertimeWork',
  'ActualDuration', 'ActualCost', 'ActualOvertimeCost', 'ActualWork', 'ActualOvertimeWork',
  'RegularWork', 'RemainingDuration', 'RemainingCost', 'RemainingWork',
  'RemainingOvertimeCost', 'RemainingOvertimeWork', 'ACWP', 'CV',
  'ConstraintType', 'CalendarUID', 'ConstraintDate',
  'LevelAssignments', 'LevelingCanSplit', 'LevelingDelay', 'LevelingDelayFormat',
  'IgnoreResourceCalendar', 'HideBar', 'Rollup', 'BCWS', 'BCWP',
  'PhysicalPercentComplete', 'EarnedValueMethod',
  'PredecessorLink', 'IsPublished', 'CommitmentType', 'Notes',
  'ExtendedAttribute', 'Baseline',
]

// ─── Топологическая сортировка по иерархии (родители раньше детей) ─────────

function sortByOutline(tasks: SerializeTask[]): SerializeTask[] {
  // Стабильная сортировка по (outline_number с числовой интерпретацией компонент,
  // затем по uid — fallback).
  const compareOutline = (a: string | null, b: string | null): number => {
    if (!a && !b) return 0
    if (!a) return 1
    if (!b) return -1
    const aParts = a.split('.').map(p => parseInt(p, 10) || 0)
    const bParts = b.split('.').map(p => parseInt(p, 10) || 0)
    const len = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < len; i++) {
      const av = aParts[i] ?? 0
      const bv = bParts[i] ?? 0
      if (av !== bv) return av - bv
    }
    return 0
  }
  return [...tasks].sort((a, b) => {
    const c = compareOutline(a.outlineNumber, b.outlineNumber)
    if (c !== 0) return c
    return a.uid - b.uid
  })
}

// ─── Рендер passthrough-узла (рекурсивно, с отступами) ─────────────────────

function renderNode(node: MspdiPassthroughField, indent: string): string {
  if (node.children && node.children.length > 0) {
    let s = `${indent}<${node.tag}>\n`
    for (const c of node.children) s += renderNode(c, indent + '  ')
    s += `${indent}</${node.tag}>\n`
    return s
  }
  const v = node.value ?? ''
  if (v === '') return `${indent}<${node.tag}></${node.tag}>\n`
  return `${indent}<${node.tag}>${xmlEscape(v)}</${node.tag}>\n`
}

/** Длительность задачи в PT-формате (milestone → PT0H0M0S; иначе сохранённая/расчётная). */
function computeDuration(t: SerializeTask): string | null {
  if (t.isMilestone) return 'PT0H0M0S'   // веха — только по типу, не по совпадению дат
  if (t.duration) return t.duration       // сохранённая длительность (mspdi_duration)
  if (t.start && t.finish) {
    const ms = new Date(t.finish).getTime() - new Date(t.start).getTime()
    const days = Math.max(1, Math.round(ms / 86400000) + 1)
    return `PT${days * 8}H0M0S`
  }
  return null
}

/** Карта passthrough по tag (для слияния и добора ValueGUID). */
function passthroughMap(pt: MspdiPassthroughField[] | null | undefined): Map<string, MspdiPassthroughField[]> {
  const m = new Map<string, MspdiPassthroughField[]>()
  for (const f of pt ?? []) {
    const arr = m.get(f.tag)
    if (arr) arr.push(f)
    else m.set(f.tag, [f])
  }
  return m
}

/**
 * Шаблон passthrough для UI-задачи (passthrough == null). Генерирует разумные
 * дефолты не-owned полей. Owned-поля подставляет общий merge-проход.
 */
function buildTemplatePassthrough(t: SerializeTask): MspdiPassthroughField[] {
  const startMspdi = dateToMspdi(t.start, 'start')
  const finishMspdi = dateToMspdi(t.finish, 'finish')
  const dur = computeDuration(t) ?? 'PT0H0M0S'
  const work = t.isMilestone ? 'PT0H0M0S' : dur
  const f = (tag: string, value: string): MspdiPassthroughField => ({ tag, value })
  const fields: MspdiPassthroughField[] = [
    f('GUID', generateGuid()),
    f('Type', t.isSummary ? '1' : '0'),
    f('IsNull', '0'),
    f('CreateDate', nowMspdi()),
    f('Priority', '500'),
    f('DurationFormat', '7'),
    f('FreeformDurationFormat', '7'),
    f('Work', work),
    f('ResumeValid', '0'),
    f('EffortDriven', '0'),
    f('Recurring', '0'),
    f('OverAllocated', '0'),
    f('Estimated', '0'),
    f('DisplayAsSummary', '0'),
    f('Critical', t.isSummary ? '1' : '0'),
    f('IsSubproject', '0'),
    f('IsSubprojectReadOnly', '0'),
    f('ExternalTask', '0'),
  ]
  if (startMspdi) { fields.push(f('EarlyStart', startMspdi), f('LateStart', startMspdi)) }
  if (finishMspdi) { fields.push(f('EarlyFinish', finishMspdi), f('LateFinish', finishMspdi)) }
  // EarlyStart/Finish и LateStart/Finish порядок: канон сам разложит по местам.
  fields.push(
    f('StartVariance', '0'),
    f('FinishVariance', '0'),
    f('WorkVariance', '0.00'),
    f('FreeSlack', '0'),
    f('TotalSlack', '0'),
    f('StartSlack', '0'),
    f('FinishSlack', '0'),
    f('FixedCost', '0'),
    f('FixedCostAccrual', '3'),
    f('PercentWorkComplete', '0'),
    f('Cost', '0'),
    f('OvertimeCost', '0'),
    f('OvertimeWork', 'PT0H0M0S'),
    f('ActualDuration', 'PT0H0M0S'),
    f('ActualCost', '0'),
    f('ActualOvertimeCost', '0'),
    f('ActualWork', 'PT0H0M0S'),
    f('ActualOvertimeWork', 'PT0H0M0S'),
    f('RegularWork', work),
    f('RemainingDuration', dur),
    f('RemainingCost', '0'),
    f('RemainingWork', work),
    f('RemainingOvertimeCost', '0'),
    f('RemainingOvertimeWork', 'PT0H0M0S'),
    f('ACWP', '0.00'),
    f('CV', '0.00'),
    f('CalendarUID', '-1'),
    f('LevelAssignments', '1'),
    f('LevelingCanSplit', '1'),
    f('LevelingDelay', '0'),
    f('LevelingDelayFormat', '8'),
    f('IgnoreResourceCalendar', '0'),
    f('HideBar', '0'),
    f('Rollup', '0'),
    f('BCWS', '0.00'),
    f('BCWP', '0.00'),
    f('PhysicalPercentComplete', '0'),
    f('EarnedValueMethod', '0'),
    f('IsPublished', t.isSummary ? '0' : '1'),
    f('CommitmentType', '0'),
  )
  return fields
}

/** Сгенерировать GUID в верхнем регистре (формат MS Project). */
function generateGuid(): string {
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0').toUpperCase()
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(8)}${hex(4)}`
}

/** Текущее время в MSPDI-формате YYYY-MM-DDTHH:MM:SS. */
function nowMspdi(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ─── Сериализация ──────────────────────────────────────────────────────────

export function serializeMspdi(tasks: SerializeTask[], opts: SerializeOptions = {}): string {
  const ordered = sortByOutline(tasks)

  // Карта fieldName → fieldId (приоритет — из opts, fallback на стандарт)
  const fieldNameToId = new Map<string, string>()
  for (const def of opts.extendedAttributes ?? []) {
    if (def.fieldId) fieldNameToId.set(def.fieldName, def.fieldId)
  }
  const resolveFieldId = (fieldName: string): string | null => {
    return fieldNameToId.get(fieldName)
        ?? MSPDI_EXTENDED_FIELD_BY_NAME[fieldName]
        ?? null
  }

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  xml += '<Project xmlns="http://schemas.microsoft.com/project">\n'

  // Шапка проекта.
  // StartDate/FinishDate: либо из opts, либо MIN/MAX по реальным датам задач —
  // это страхует от ошибки «задача начинается до начала проекта», когда у нас
  // нет явного startDate, а Project подставляет дефолт «сегодня».
  const minStart  = ordered.reduce<string | null>((acc, t) => (t.start  && (!acc || t.start  < acc) ? t.start  : acc), null)
  const maxFinish = ordered.reduce<string | null>((acc, t) => (t.finish && (!acc || t.finish > acc) ? t.finish : acc), null)
  const projectStart  = opts.startDate  ?? minStart
  const projectFinish = opts.finishDate ?? maxFinish

  xml += tag('Name', opts.projectName ?? 'ZPR_Schedule', '  ')
  xml += tag('Title', opts.projectTitle ?? opts.projectName ?? 'ЗПР — Совмещённый график', '  ')
  const startMspdi = dateToMspdi(projectStart, 'start')
  const finishMspdi = dateToMspdi(projectFinish, 'finish')
  if (startMspdi)  xml += tag('StartDate',  startMspdi,  '  ')
  if (finishMspdi) xml += tag('FinishDate', finishMspdi, '  ')
  xml += tag('CalendarUID', '1', '  ')
  xml += tag('DefaultStartTime',  opts.calendar?.defaultStartTime  ?? DEFAULT_START_TIME,  '  ')
  xml += tag('DefaultFinishTime', opts.calendar?.defaultFinishTime ?? DEFAULT_FINISH_TIME, '  ')
  // Календарь рабочего времени. Без MinutesPerDay/Week Project не может пересчитать
  // длительности в дни → ставит «?» у всех сроков.
  xml += tag('MinutesPerDay',  opts.calendar?.minutesPerDay  ?? 480, '  ')
  xml += tag('MinutesPerWeek', opts.calendar?.minutesPerWeek ?? 2400, '  ')
  xml += tag('DaysPerMonth',   opts.calendar?.daysPerMonth   ?? 20,  '  ')

  // Декларации ExtendedAttributes.
  // <Alias> пишется ТОЛЬКО если непустой. MS Project ломается на явно пустом
  // <Alias></Alias> (трактует как невалидную декларацию), но при отсутствии
  // тега принимает декларацию как «алиас не задан» — это рабочий вариант.
  const extDefs = opts.extendedAttributes ?? []
  if (extDefs.length > 0) {
    xml += '  <ExtendedAttributes>\n'
    for (const def of extDefs) {
      const fieldId = def.fieldId ?? MSPDI_EXTENDED_FIELD_BY_NAME[def.fieldName]
      if (!fieldId) continue
      xml += '    <ExtendedAttribute>\n'
      xml += `      <FieldID>${xmlEscape(fieldId)}</FieldID>\n`
      xml += `      <FieldName>${xmlEscape(def.fieldName)}</FieldName>\n`
      const alias = (def.alias ?? '').trim()
      if (alias) xml += `      <Alias>${xmlEscape(alias)}</Alias>\n`
      xml += '    </ExtendedAttribute>\n'
    }
    xml += '  </ExtendedAttributes>\n'
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────
  xml += '  <Tasks>\n'

  // UID=0 — обязательный «корень проекта»
  xml += '    <Task>\n'
  xml += tag('UID', 0)
  xml += tag('ID',  0)
  xml += tagBool('Active', true)
  xml += tagBool('Manual', false)
  xml += '    </Task>\n'

  // ─── Owned-рендеры (из реляционных колонок) ──────────────────────────────
  // Возвращают XML-строку (возможно пустую) для одного owned-тега <Task>.

  const renderExtendedAttributes = (t: SerializeTask, ptExt: MspdiPassthroughField[] | undefined): string => {
    // База — ВСЕ ExtendedAttribute-блоки из passthrough (8 пользовательских полей:
    // Текст11..Текст15 с Value+ValueGUID). ЗПР владеет только полем привязки к объекту:
    // его Value накладываем поверх по FieldID. Прочие EA-блоки сохраняются дословно.
    const ownedByFieldId = new Map<string, string>()
    for (const [fieldName, value] of Object.entries(t.extendedAttributes)) {
      const fieldId = resolveFieldId(fieldName)
      if (fieldId) ownedByFieldId.set(fieldId, value)
    }

    let s = ''
    const seenFieldIds = new Set<string>()

    // 1. Проходим сохранённые EA-блоки в исходном порядке.
    for (const ext of ptExt ?? []) {
      const fieldId = ext.children?.find(c => c.tag === 'FieldID')?.value ?? null
      const origValue = ext.children?.find(c => c.tag === 'Value')?.value ?? null
      const origGuid  = ext.children?.find(c => c.tag === 'ValueGUID')?.value ?? null
      if (fieldId) seenFieldIds.add(fieldId)

      const override = fieldId ? ownedByFieldId.get(fieldId) : undefined
      s += '      <ExtendedAttribute>\n'
      if (fieldId) s += tag('FieldID', fieldId, '        ')
      if (override !== undefined) {
        // Значение от ЗПР (привязка к объекту). ValueGUID не пишем — старый GUID
        // указывал бы на прежнюю запись lookup-таблицы; Project разрешит сам.
        s += tag('Value', override, '        ')
      } else {
        if (origValue !== null) s += tag('Value', origValue, '        ')
        if (origGuid  !== null) s += tag('ValueGUID', origGuid, '        ')
      }
      s += '      </ExtendedAttribute>\n'
    }

    // 2. Owned-поля (привязка к объекту), которых не было в passthrough — добавляем.
    for (const [fieldId, value] of ownedByFieldId) {
      if (seenFieldIds.has(fieldId)) continue
      s += '      <ExtendedAttribute>\n'
      s += tag('FieldID', fieldId, '        ')
      s += tag('Value',   value,   '        ')
      s += '      </ExtendedAttribute>\n'
    }
    return s
  }

  const renderPredecessors = (t: SerializeTask): string => {
    let s = ''
    for (const p of t.predecessors) {
      const linkType = LINK_TYPE_TO_MSPDI[p.type]
      const minutesPerDay = p.lagType === 'calendar' ? 60 * 24 : 60 * 8
      const linkLag = p.lagDays * minutesPerDay * 10
      const lagFormat = p.lagType === 'calendar' ? 11 : 5  // 5=days, 11=elapsed days
      s += '      <PredecessorLink>\n'
      s += tag('PredecessorUID', p.predecessorUid, '        ')
      s += tag('Type',           linkType,         '        ')
      s += tag('CrossProject',   '0',              '        ')
      s += tag('LinkLag',        linkLag,          '        ')
      s += tag('LagFormat',      lagFormat,        '        ')
      s += '      </PredecessorLink>\n'
    }
    return s
  }

  /**
   * Рендер одного owned-тега. ctx содержит предрасчитанные значения.
   * Пустая строка → тег пропускается (условные ManualStart/ConstraintDate и т.п.).
   */
  const renderOwned = (
    tagName: string,
    t: SerializeTask,
    ctx: {
      idVal: number
      startMspdiT: string | null
      finishMspdiT: string | null
      durationStr: string | null
      constraintType: number | null
      ptExt: MspdiPassthroughField[] | undefined
    },
  ): string => {
    switch (tagName) {
      case 'UID':  return tag('UID', t.uid)
      case 'ID':   return tag('ID', ctx.idVal)
      case 'Name': return tag('Name', t.name)
      case 'Active':   return tagBool('Active', true)
      case 'Manual':   return tagBool('Manual', t.manual)
      case 'Summary':  return tagBool('Summary', t.isSummary)
      case 'Milestone':return tagBool('Milestone', t.isMilestone)
      case 'IsNull':   return tag('IsNull', 0)
      case 'OutlineLevel':  return t.outlineLevel !== null ? tag('OutlineLevel', t.outlineLevel) : ''
      case 'OutlineNumber': return t.outlineNumber !== null ? tag('OutlineNumber', t.outlineNumber) : ''
      case 'WBS':           return t.outlineNumber !== null ? tag('WBS', t.outlineNumber) : ''
      case 'Start':  return ctx.startMspdiT ? tag('Start', ctx.startMspdiT) : ''
      case 'Finish': return ctx.finishMspdiT ? tag('Finish', ctx.finishMspdiT) : ''
      case 'Duration': return ctx.durationStr ? tag('Duration', ctx.durationStr) : ''
      case 'ManualStart':    return t.manual && ctx.startMspdiT  ? tag('ManualStart', ctx.startMspdiT) : ''
      case 'ManualFinish':   return t.manual && ctx.finishMspdiT ? tag('ManualFinish', ctx.finishMspdiT) : ''
      case 'ManualDuration': return t.manual && ctx.durationStr  ? tag('ManualDuration', ctx.durationStr) : ''
      case 'ConstraintType': return ctx.constraintType !== null ? tag('ConstraintType', ctx.constraintType) : ''
      case 'ConstraintDate':
        // Только при ConstraintType != 0.
        return (ctx.constraintType && ctx.constraintType !== 0 && ctx.startMspdiT)
          ? tag('ConstraintDate', ctx.startMspdiT) : ''
      case 'PercentComplete': return t.percentComplete !== null ? tag('PercentComplete', t.percentComplete) : ''
      case 'Notes': return t.notes ? tag('Notes', t.notes) : ''
      case 'ExtendedAttribute': return renderExtendedAttributes(t, ctx.ptExt)
      case 'PredecessorLink':   return renderPredecessors(t)
      default: return ''
    }
  }

  let nextId = 1
  for (const t of ordered) {
    const idVal = t.id ?? nextId++
    const startMspdiT  = dateToMspdi(t.start,  'start')
    // Веха (нулевая длительность): Finish = Start (09:00), иначе Project рисует
    // интервал 09:00–18:00 и показывает «1 день» вопреки Duration=0/Milestone=1.
    // Только по isMilestone (тип записи) — 1-дневная задача с одной датой вехой НЕ является.
    const finishMspdiT = dateToMspdi(t.finish, t.isMilestone ? 'start' : 'finish')
    const durationStr = computeDuration(t)
    // ConstraintType:
    //  - manual-задача (Форэскиз, договорные даты) → SNET(4), держит дату от уезда;
    //  - auto-задача (Концепция и далее) → без constraint (ASAP), чтобы Project
    //    пересчитывал по предшественникам — пользователь играет с графиком;
    //  - summary → не пишем (Project считает по детям).
    const constraintType: number | null = (!t.isSummary && startMspdiT && t.manual) ? 4 : null

    // Обратная совместимость: passthrough === undefined → старая генерация.
    const hasPassthroughField = t.passthrough !== undefined

    if (!hasPassthroughField) {
      // ── Legacy-путь (как было до round-trip) ──────────────────────────
      xml += '    <Task>\n'
      xml += tag('UID',  t.uid)
      xml += tag('ID',   idVal)
      xml += tag('Name', t.name)
      xml += tagBool('Active', true)
      xml += tagBool('Manual', t.manual)
      xml += tagBool('Summary', t.isSummary)
      xml += tagBool('Milestone', t.isMilestone)
      if (t.outlineLevel !== null)  xml += tag('OutlineLevel',  t.outlineLevel)
      if (t.outlineNumber !== null) xml += tag('OutlineNumber', t.outlineNumber)
      if (t.outlineNumber !== null) xml += tag('WBS',           t.outlineNumber)
      if (startMspdiT)  xml += tag('Start',  startMspdiT)
      if (finishMspdiT) xml += tag('Finish', finishMspdiT)
      if (durationStr) xml += tag('Duration', durationStr)
      xml += tag('DurationFormat', '7')
      if (t.manual) {
        if (startMspdiT)  xml += tag('ManualStart',  startMspdiT)
        if (finishMspdiT) xml += tag('ManualFinish', finishMspdiT)
        if (durationStr)  xml += tag('ManualDuration', durationStr)
      }
      if (constraintType !== null) {
        xml += tag('ConstraintType', constraintType)
        if (startMspdiT) xml += tag('ConstraintDate', startMspdiT)
      }
      xml += tagBool('Estimated', false)
      if (t.percentComplete !== null) xml += tag('PercentComplete', t.percentComplete)
      if (t.notes) xml += tag('Notes', t.notes)
      xml += renderExtendedAttributes(t, undefined)
      xml += renderPredecessors(t)
      xml += '    </Task>\n'
      continue
    }

    // ── Round-trip merge-путь ─────────────────────────────────────────────
    // passthrough: массив (из XML) или null (UI-задача → шаблон).
    const pt = t.passthrough && t.passthrough.length > 0
      ? t.passthrough
      : (t.passthrough === null ? buildTemplatePassthrough(t) : [])
    const ptMap = passthroughMap(pt)
    const ptExt = ptMap.get('ExtendedAttribute')
    const ctx = { idVal, startMspdiT, finishMspdiT, durationStr, constraintType, ptExt }

    const emitted = new Set<string>()
    xml += '    <Task>\n'

    for (const tagName of CANONICAL_TASK_ORDER) {
      if (emitted.has(tagName)) continue
      emitted.add(tagName)
      if (OWNED_TASK_TAGS.has(tagName)) {
        xml += renderOwned(tagName, t, ctx)
      } else {
        // Не-owned: из passthrough (или шаблона). Может быть несколько (дубликаты).
        const nodes = ptMap.get(tagName)
        if (nodes) for (const n of nodes) xml += renderNode(n, '      ')
      }
    }

    // Неизвестные passthrough-теги, отсутствующие в каноне — дописываем как есть.
    for (const n of pt) {
      if (CANONICAL_TASK_ORDER.includes(n.tag)) continue
      if (OWNED_TASK_TAGS.has(n.tag)) continue
      xml += renderNode(n, '      ')
    }

    xml += '    </Task>\n'
  }

  xml += '  </Tasks>\n'
  xml += '</Project>\n'

  return xml
}
