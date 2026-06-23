/**
 * Общая модель данных для DHTMLX Gantt (Community/MIT) — типы + чистые мапперы.
 *
 * Этот модуль импортируют:
 *  - серверный роут, который грузит активную версию из calendar_entries и отдаёт
 *    DHTMLX-датасет {data: GanttTask[], links: GanttLink[]};
 *  - write-path (PATCH), который проверяет правки против OWNED_PATCH_FIELDS.
 *
 * ВАЖНО: модуль чисто функциональный — без побочных эффектов и без импорта
 * supabase. Любая работа с БД делается в вызывающем коде.
 *
 * ВНИМАНИЕ: маппинг кодов связей DHTMLX ОТЛИЧАЕТСЯ от числовых кодов MSPDI
 * (см. mspdiTypes.ts LINK_TYPE_TO_MSPDI). Здесь — коды именно DHTMLX Gantt:
 *   '0'=finish_to_start(FS), '1'=start_to_start(SS),
 *   '2'=finish_to_finish(FF), '3'=start_to_finish(SF).
 */

// ─── Типы связей в БД ───────────────────────────────────────────────────────

/** Строковый код связи в calendar_predecessors.link_type. SF в боевой БД нет, но тип поддерживаем. */
export type DbLinkType = 'FS' | 'SS' | 'FF' | 'SF'

/** Код типа связи в DHTMLX Gantt link.type (строка). */
export type DhtmlxLinkType = '0' | '1' | '2' | '3'

// ─── Выходные типы DHTMLX ────────────────────────────────────────────────────

/**
 * Задача в формате DHTMLX Gantt.
 *  - start_date: 'YYYY-MM-DD HH:mm' (формат конфигурируется в gantt, по умолчанию '%Y-%m-%d %H:%i').
 *  - duration: в днях; для вехи — 0.
 *  - progress: 0..1 (из percent_complete / 100).
 *  - type: 'project' (summary) | 'milestone' (entry_type==schedule_milestone) | 'task'.
 *  - parent: id родителя или '0' (корень DHTMLX). Совпадает с типом id.
 */
export interface GanttTask {
  id: string
  text: string
  start_date: string
  duration: number
  parent: string
  progress: number
  type: 'task' | 'project' | 'milestone'
  open: boolean
}

/**
 * Связь в формате DHTMLX Gantt.
 *  - source: предшественник (predecessor_id).
 *  - target: задача (calendar_id).
 *  - type: код DHTMLX ('0'..'3').
 *  - lag: в днях (знаковый; lead = отрицательный).
 */
export interface GanttLink {
  id: string
  source: string
  target: string
  type: DhtmlxLinkType
  lag: number
}

// ─── Входные строки из БД ────────────────────────────────────────────────────

/**
 * Строка calendar_entries — ровно те колонки, что нужны для рендера Gantt.
 * Зеркалит CalendarEntryRow из exportMspdi.ts плюс object_ids/schedule_raw_text
 * (нужны для привязки к объекту в UI).
 *
 * НЕ включает mspdi_passthrough — для рендера он не нужен и в write-path трогать
 * его нельзя (контракт сохранения экспорта, п.1).
 */
export interface CalendarEntryRow {
  id: string
  mspdi_uid: number | null
  mspdi_id: number | null
  title: string
  outline_level: number | null
  outline_number: string | null
  parent_entry_id: string | null
  is_summary: boolean
  is_project_wide: boolean
  task_mode: 'auto' | 'manual'
  date_start: string | null
  date_end: string | null
  entry_type: string
  percent_complete: number | null
  mspdi_notes: string | null
  mspdi_duration: string | null
  schedule_raw_text: string | null
  object_ids: string[]
}

/** Строка calendar_predecessors. */
export interface PredecessorRow {
  calendar_id: string
  predecessor_id: string
  link_type: DbLinkType
  lag: number
  lag_type: 'calendar' | 'working'
}

// ─── Маппинг типов связей ────────────────────────────────────────────────────

const DB_TO_DHTMLX: Record<DbLinkType, DhtmlxLinkType> = {
  FS: '0',
  SS: '1',
  FF: '2',
  SF: '3',
}

const DHTMLX_TO_DB: Record<DhtmlxLinkType, DbLinkType> = {
  '0': 'FS',
  '1': 'SS',
  '2': 'FF',
  '3': 'SF',
}

/** Код связи БД ('FS'|'SS'|'FF'|'SF') → код DHTMLX ('0'|'1'|'2'|'3'). */
export function linkTypeToDhtmlx(t: DbLinkType): DhtmlxLinkType {
  return DB_TO_DHTMLX[t]
}

/** Код связи DHTMLX ('0'|'1'|'2'|'3') → код связи БД ('FS'|'SS'|'FF'|'SF'). */
export function dhtmlxToLinkType(t: DhtmlxLinkType): DbLinkType {
  return DHTMLX_TO_DB[t]
}

// ─── Хелперы дат/длительности ────────────────────────────────────────────────

/** Кол-во полных суток в миллисекундах. */
const MS_PER_DAY = 86_400_000

/**
 * ISO-дата ('YYYY-MM-DD' или 'YYYY-MM-DDT...') → DHTMLX 'YYYY-MM-DD HH:mm'.
 * Время фиксируем 09:00 (рабочий день русского MS Project, см. сериализатор).
 * Возвращает '' если дата не распознана.
 */
function dateToDhtmlx(date: string | null | undefined): string {
  if (!date) return ''
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]} 09:00`
}

/**
 * Длительность задачи в днях для DHTMLX.
 *  - milestone → 0;
 *  - иначе по date_start..date_end включительно, минимум 1;
 *  - если дат нет — 1 (DHTMLX требует положительную длительность для не-вех).
 *
 * Длительность считается календарной (inclusive), чтобы полоса визуально
 * совпадала с диапазоном дат. Точную рабочую длительность хранит mspdi_duration,
 * но для read-only рендера достаточно календарной.
 */
function entryDurationDays(row: CalendarEntryRow, isMilestone: boolean): number {
  if (isMilestone) return 0
  if (!row.date_start || !row.date_end) return 1
  const startMs = Date.parse(row.date_start.slice(0, 10))
  const endMs = Date.parse(row.date_end.slice(0, 10))
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 1
  const days = Math.round((endMs - startMs) / MS_PER_DAY) + 1
  return Math.max(1, days)
}

/** percent_complete (0..100, может быть null) → progress DHTMLX (0..1). */
function percentToProgress(pct: number | null): number {
  if (pct === null || Number.isNaN(pct)) return 0
  return Math.min(1, Math.max(0, pct / 100))
}

// ─── Мапперы строк → DHTMLX ──────────────────────────────────────────────────

/**
 * calendar_entries строка → DHTMLX GanttTask.
 *  - type: milestone, если entry_type==='schedule_milestone'; иначе project, если
 *    is_summary; иначе task. (Веха определяется ТОЛЬКО по типу записи — не по
 *    равенству дат, см. контракт п.4.)
 *  - duration: 0 для вехи, иначе календарные дни (min 1).
 *  - parent: parent_entry_id или '0' (корень DHTMLX).
 */
export function entryToGanttTask(row: CalendarEntryRow): GanttTask {
  const isMilestone = row.entry_type === 'schedule_milestone'
  const type: GanttTask['type'] = isMilestone
    ? 'milestone'
    : row.is_summary
      ? 'project'
      : 'task'
  return {
    id: row.id,
    text: row.title,
    start_date: dateToDhtmlx(row.date_start),
    duration: entryDurationDays(row, isMilestone),
    parent: row.parent_entry_id ?? '0',
    progress: percentToProgress(row.percent_complete),
    type,
    open: true,
  }
}

/**
 * calendar_predecessors строка → DHTMLX GanttLink.
 *  - source = предшественник, target = текущая задача;
 *  - type — код DHTMLX из link_type;
 *  - lag — знаковый, в днях (lead = отрицательный).
 * id формируется детерминированно из пары + типа (роуты могут переопределить).
 */
export function predToGanttLink(p: PredecessorRow): GanttLink {
  return {
    id: `${p.predecessor_id}_${p.calendar_id}_${p.link_type}`,
    source: p.predecessor_id,
    target: p.calendar_id,
    type: linkTypeToDhtmlx(p.link_type),
    lag: p.lag,
  }
}

// ─── Контракт write-path ─────────────────────────────────────────────────────

/**
 * Белый список колонок calendar_entries, которые write-path вправе UPDATE-ить
 * (контракт сохранения экспорта, п.2 — OWNED-колонки).
 *
 * НИКОГДА не включать: mspdi_passthrough, mspdi_uid, schedule_raw_text
 * (нарушение ⇒ ломается round-trip MS Project, контракт п.1). Связи правятся
 * не здесь, а в calendar_predecessors. mspdi_id пересчитывается отдельно
 * (ROW_NUMBER() по WBS), в write-path руками не задаётся.
 */
export const OWNED_PATCH_FIELDS: readonly string[] = [
  'title',
  'date_start',
  'date_end',
  'outline_level',
  'outline_number',
  'parent_entry_id',
  'is_summary',
  'task_mode',
  'percent_complete',
  'entry_type',
  'mspdi_notes',
  'mspdi_duration',
] as const

const OWNED_SET: ReadonlySet<string> = new Set<string>(OWNED_PATCH_FIELDS)

/**
 * Отфильтровать объект правок до OWNED-колонок — ЕДИНСТВЕННАЯ реализация фильтра
 * write-path (чтобы whitelist жил в одном месте и не дрейфовал между роутом и
 * guard-тестом). Любой ключ вне OWNED_PATCH_FIELDS — включая mspdi_passthrough /
 * mspdi_uid / schedule_raw_text / mspdi_id — отбрасывается (контракт п.1).
 */
export function pickOwnedFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(body)) {
    if (OWNED_SET.has(key)) out[key] = body[key]
  }
  return out
}
