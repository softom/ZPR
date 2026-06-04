/**
 * Сериализатор MS Project XML (MSPDI).
 *
 * На вход — нормализованный список задач + связей + дефиниции ExtendedAttributes.
 * На выход — строка XML, готовая к скачиванию пользователем и открытию в MS Project.
 *
 * Намеренно ручная сборка строк XML (без XMLBuilder), т.к. структура MSPDI
 * фиксирована и нам нужен контроль над порядком/отступами для читаемости в Project.
 */

import { LINK_TYPE_TO_MSPDI, MSPDI_EXTENDED_FIELD_BY_NAME } from './mspdiTypes'

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

  let nextId = 1
  for (const t of ordered) {
    xml += '    <Task>\n'
    xml += tag('UID',  t.uid)
    xml += tag('ID',   t.id ?? nextId++)
    xml += tag('Name', t.name)
    xml += tagBool('Active', true)
    xml += tagBool('Manual', t.manual)
    xml += tagBool('Summary', t.isSummary)
    xml += tagBool('Milestone', t.isMilestone)
    if (t.outlineLevel !== null)  xml += tag('OutlineLevel',  t.outlineLevel)
    if (t.outlineNumber !== null) xml += tag('OutlineNumber', t.outlineNumber)
    if (t.outlineNumber !== null) xml += tag('WBS',           t.outlineNumber)

    const startMspdiT  = dateToMspdi(t.start,  'start')
    const finishMspdiT = dateToMspdi(t.finish, 'finish')
    if (startMspdiT)  xml += tag('Start',  startMspdiT)
    if (finishMspdiT) xml += tag('Finish', finishMspdiT)
    // Длительность — критично, иначе Project помечает срок «?».
    // Если из БД пришло сохранённое mspdi_duration — используем его.
    // Иначе вычисляем календарную разницу start..finish и переводим в PT-формат
    //   (для milestone — PT0H0M0S, для обычных — start..finish в днях × 8 часов).
    if (t.duration) {
      xml += tag('Duration', t.duration)
    } else if (t.isMilestone || (t.start && t.finish && t.start === t.finish)) {
      xml += tag('Duration', 'PT0H0M0S')
    } else if (t.start && t.finish) {
      const ms = new Date(t.finish).getTime() - new Date(t.start).getTime()
      const days = Math.max(1, Math.round(ms / 86400000) + 1)
      xml += tag('Duration', `PT${days * 8}H0M0S`)
    }
    xml += tag('DurationFormat', '7')   // 7 = days (стандартный)
    xml += tagBool('Estimated', false)  // явно не estimated — без этого Project показывает «?»
    if (t.percentComplete !== null) xml += tag('PercentComplete', t.percentComplete)

    if (t.notes) xml += tag('Notes', t.notes)

    // ExtendedAttribute (значения) — резолвим FieldID через карту opts → стандарт
    for (const [fieldName, value] of Object.entries(t.extendedAttributes)) {
      const fieldId = resolveFieldId(fieldName)
      if (!fieldId) continue
      xml += '      <ExtendedAttribute>\n'
      xml += tag('FieldID', fieldId, '        ')
      xml += tag('Value',   value,   '        ')
      xml += '      </ExtendedAttribute>\n'
    }

    // PredecessorLink
    for (const p of t.predecessors) {
      const linkType = LINK_TYPE_TO_MSPDI[p.type]
      // LinkLag хранится в MSPDI как «1/10 минуты». Выгружаем working-дни как days,
      // calendar (elapsed) — как elapsed days.
      const minutesPerDay = p.lagType === 'calendar' ? 60 * 24 : 60 * 8
      const linkLag = p.lagDays * minutesPerDay * 10
      const lagFormat = p.lagType === 'calendar' ? 11 : 5  // 5=days, 11=elapsed days
      xml += '      <PredecessorLink>\n'
      xml += tag('PredecessorUID', p.predecessorUid, '        ')
      xml += tag('Type',           linkType,         '        ')
      xml += tag('CrossProject',   '0',              '        ')
      xml += tag('LinkLag',        linkLag,          '        ')
      xml += tag('LagFormat',      lagFormat,        '        ')
      xml += '      </PredecessorLink>\n'
    }

    xml += '    </Task>\n'
  }

  xml += '  </Tasks>\n'
  xml += '</Project>\n'

  return xml
}
