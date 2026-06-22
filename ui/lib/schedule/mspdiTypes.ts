/**
 * MSPDI XML — типы и константы.
 *
 * Документация формата: https://learn.microsoft.com/en-us/office-project/xml-data-interchange/exchanging-project-plan-data-with-other-applications-using-xml
 *
 * Главные сущности, которые мы поддерживаем:
 *  - Project (метаданные)
 *  - Tasks/Task (включая иерархию по OutlineLevel)
 *  - Task/PredecessorLink (FS/SS/FF/SF + lag)
 *  - Task/ExtendedAttribute (Text1..Text30 — пользовательские поля)
 *  - Task/Notes (текстовые заметки)
 *
 * Resources/Assignments — читаем минимально (для аудита), привязка к подрядчику
 * у нас идёт через договорную базу (entity_links calendar_entry → legal_entity).
 */

/** Числовой код связи MSPDI → строковый код в нашей БД. */
export const MSPDI_LINK_TYPE: Record<number, 'FF' | 'FS' | 'SF' | 'SS'> = {
  0: 'FF',
  1: 'FS',
  2: 'SF',
  3: 'SS',
}

export const LINK_TYPE_TO_MSPDI: Record<'FF' | 'FS' | 'SF' | 'SS', number> = {
  FF: 0,
  FS: 1,
  SF: 2,
  SS: 3,
}

/**
 * LagFormat → семантика. LinkLag хранится в десятых долях минут MS Project
 * (т.е. целое число «10ths of a minute»), но для рабочих единиц (дни/недели/
 * месяцы) пересчёт строится через рабочий календарь, а не реальные минуты.
 *
 * Соглашение для нашей БД: lag хранится в днях (int), lag_type ∈ {calendar, working}.
 * При парсинге переводим:
 *   d/w/mo/y/h/m   → working   (рабочий календарь)
 *   ed/ew/eh/em    → calendar  (elapsed = непрерывные)
 *   % (19)         → 0  (процент-lag не поддерживаем)
 */
export const MSPDI_LAG_FORMAT: Record<number, { unit: 'm' | 'h' | 'd' | 'w' | 'mo' | 'y' | 'p'; elapsed: boolean }> = {
  3:  { unit: 'm',  elapsed: false }, // minutes
  4:  { unit: 'h',  elapsed: false }, // hours
  5:  { unit: 'd',  elapsed: false }, // days
  6:  { unit: 'w',  elapsed: false }, // weeks
  7:  { unit: 'mo', elapsed: false }, // months
  8:  { unit: 'y',  elapsed: false }, // years
  9:  { unit: 'p',  elapsed: false }, // percent (deprecated)
  10: { unit: 'p',  elapsed: false }, // null (no format)
  11: { unit: 'd',  elapsed: true  }, // elapsed days
  12: { unit: 'w',  elapsed: true  }, // elapsed weeks
  19: { unit: 'p',  elapsed: false }, // %
  20: { unit: 'm',  elapsed: true  }, // elapsed minutes
  21: { unit: 'h',  elapsed: true  }, // elapsed hours
}

/** Field ID → имя кастомного поля. MSPDI хранит ExtendedAttribute по FieldID (большое целое). */
export const MSPDI_EXTENDED_FIELD_BY_ID: Record<string, string> = {
  // Text1..Text30
  '188743731': 'Text1',  '188743734': 'Text2',  '188743737': 'Text3',  '188743740': 'Text4',
  '188743743': 'Text5',  '188743746': 'Text6',  '188743749': 'Text7',  '188743752': 'Text8',
  '188743755': 'Text9',  '188743758': 'Text10', '188743761': 'Text11', '188743764': 'Text12',
  '188743767': 'Text13', '188743770': 'Text14', '188743773': 'Text15', '188743776': 'Text16',
  '188743779': 'Text17', '188743782': 'Text18', '188743785': 'Text19', '188743788': 'Text20',
  '188743791': 'Text21', '188743794': 'Text22', '188743797': 'Text23', '188743800': 'Text24',
  '188743803': 'Text25', '188743806': 'Text26', '188743809': 'Text27', '188743812': 'Text28',
  '188743815': 'Text29', '188743818': 'Text30',
}

/** Обратная карта: имя поля → FieldID (для сериализации). */
export const MSPDI_EXTENDED_FIELD_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(MSPDI_EXTENDED_FIELD_BY_ID).map(([id, name]) => [name, id]),
)

// ─── Round-trip passthrough ─────────────────────────────────────────────────

/**
 * Один сохранённый «как есть» узел <Task> из исходного MSPDI.
 * Лист: {tag, value}. Составной (ExtendedAttribute/Baseline/PredecessorLink):
 * {tag, children:[...]}. Порядок элементов массива = порядку тегов в оригинале.
 */
export interface MspdiPassthroughField {
  tag: string
  value?: string
  children?: MspdiPassthroughField[]
}

/**
 * Owned-теги <Task>: ЗПР пишет их из реляционных колонок БД, поэтому при импорте
 * они НЕ попадают в passthrough (исключение хранится в одном месте — здесь —
 * и используется и парсером, и сериализатором).
 *
 * DurationFormat/FreeformDurationFormat/Estimated формально owned, но если оригинал
 * содержал отличающееся значение (summary имеет DurationFormat=21) — корректнее
 * сохранять оригинал в passthrough. Поэтому их в OWNED_TASK_TAGS НЕТ: при наличии
 * passthrough они берутся из него, для UI-задач — из шаблона.
 */
export const OWNED_TASK_TAGS: ReadonlySet<string> = new Set<string>([
  'UID',
  'ID',
  'Name',
  'OutlineLevel',
  'OutlineNumber',
  'WBS',
  'Summary',
  'Milestone',
  'Active',
  'Manual',
  'Start',
  'Finish',
  'Duration',
  'ManualStart',
  'ManualFinish',
  'ManualDuration',
  'ConstraintType',
  'ConstraintDate',
  'PercentComplete',
  'Notes',
  'ExtendedAttribute',
  'PredecessorLink',
  'IsNull',
])

// ─── Типы парсинга ──────────────────────────────────────────────────────────

export interface ExtendedAttributeDef {
  fieldId: string
  fieldName: string  // 'Text1', 'Text2', ...
  alias: string | null  // пользовательский псевдоним поля, например «Объект»
}

export interface MspdiPredecessor {
  predecessorUid: number
  type: 'FF' | 'FS' | 'SF' | 'SS'
  lagDays: number
  lagType: 'calendar' | 'working'
  lagFormat: number | null
}

export interface MspdiTask {
  uid: number
  id: number | null
  name: string
  outlineLevel: number | null
  outlineNumber: string | null
  parentUid: number | null      // вычисляется из иерархии
  isSummary: boolean
  isMilestone: boolean
  active: boolean
  manual: boolean
  start: string | null          // ISO date 'YYYY-MM-DD'
  finish: string | null         // ISO date 'YYYY-MM-DD'
  durationText: string | null   // PT240H0M0S — оставляем сырое, не парсим (нам не нужно)
  percentComplete: number | null
  notes: string | null
  /** Map FieldName → значение, например {'Text1': '102_ГОСТИНИЦА_800'}. */
  extendedAttributes: Record<string, string>
  predecessors: MspdiPredecessor[]
  /**
   * Упорядоченный массив не-owned полей <Task> из оригинала (для round-trip).
   * Заполняется ВСЕГДА при импорте из XML. Для UI-задач (не из XML) — null.
   */
  passthrough: MspdiPassthroughField[]
}

export interface CalendarSettings {
  /** Минут в рабочем дне (MS Project default = 480 = 8 часов). */
  minutesPerDay: number | null
  minutesPerWeek: number | null
  daysPerMonth: number | null
  defaultStartTime: string | null   // 'HH:MM:SS'
  defaultFinishTime: string | null
  calendarUid: string | null
}

export interface MspdiProject {
  name: string | null
  title: string | null
  startDate: string | null
  finishDate: string | null
  calendar: CalendarSettings
  /** FieldID → описание поля (имя + alias). */
  extendedAttributeDefs: Record<string, ExtendedAttributeDef>
  tasks: MspdiTask[]
}
