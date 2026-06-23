/**
 * Экспорт calendar_entries → MSPDI XML.
 *
 * Поток:
 *   1. SELECT calendar_entries (включая outline_*, parent_entry_id, mspdi_uid, etc.)
 *   2. Для строк без mspdi_uid — генерируем UID начиная с (max + 1, мин. 10_000_000),
 *      back-fill в БД, чтобы при следующем импорте они идентифицировались.
 *   3. SELECT calendar_predecessors → массив связей (резолвим UUID → mspdi_uid).
 *   4. SELECT entity_links calendar_entry → object → имя объекта в Text1.
 *   5. serializeMspdi(...) → XML.
 */

import { serializeMspdi, type SerializeOptions, type SerializeTask } from './mspdiSerializer'
import type { MspdiPassthroughField } from './mspdiTypes'
import { supabaseAdmin } from '../supabase-admin'

export interface ExportOptions {
  /**
   * Имя поля для записи кода объекта в задачу. Если не указано —
   * берётся `object_field` из версии (round-trip).
   * Если истории нет — fallback на 'Text1'.
   */
  objectField?: string
  /** Имя проекта в MSPDI (для шапки). */
  projectName?: string
  /**
   * ID версии (schedule_imports.id). Если указан — экспортируется конкретная версия.
   * Если не указан — берётся активная версия (is_active=true).
   * Если нет активной — экспортируются все строки (legacy-режим).
   */
  versionId?: string | null
}

interface ImportMetaRow {
  object_field: string | null
  object_field_id: string | null
  extended_attribute_defs: Array<{ fieldId: string; fieldName: string; alias: string | null }> | null
  project_start_date: string | null
  project_finish_date: string | null
  project_name: string | null
  project_calendar_settings: {
    minutes_per_day?: number | null
    minutes_per_week?: number | null
    days_per_month?: number | null
    default_start_time?: string | null
    default_finish_time?: string | null
    calendar_uid?: string | null
  } | null
}

const NEW_UID_BASE = 10_000_000  // мин. для UI-созданных задач, чтобы не пересекаться с MSP

interface CalendarEntryRow {
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
  /** Round-trip passthrough (jsonb). null → UI-задача (шаблон), undefined в типе не используется. */
  mspdi_passthrough: MspdiPassthroughField[] | null
}

interface PredecessorRow {
  calendar_id: string
  predecessor_id: string
  link_type: 'FF' | 'FS' | 'SF' | 'SS'
  lag: number
  lag_type: 'calendar' | 'working'
}

interface ObjectRow {
  id: string
  code: string
  current_name: string | null
}

export async function exportMspdiXml(opts: ExportOptions = {}): Promise<string> {
  // Определяем версию для экспорта
  let targetVersionId: string | null = opts.versionId ?? null

  if (!targetVersionId) {
    // Берём активную версию
    const { data: activeImp } = await supabaseAdmin
      .from('schedule_imports')
      .select('id')
      .eq('is_active', true)
      .maybeSingle()
    targetVersionId = activeImp?.id ?? null
  }

  // Метаданные версии для round-trip (object_field, FieldID, декларации, даты проекта)
  let importMeta: ImportMetaRow | null = null
  if (targetVersionId) {
    const { data } = await supabaseAdmin
      .from('schedule_imports')
      .select('object_field, object_field_id, extended_attribute_defs, project_start_date, project_finish_date, project_name, project_calendar_settings')
      .eq('id', targetVersionId)
      .maybeSingle()
    importMeta = (data ?? null) as ImportMetaRow | null
  }
  if (!importMeta) {
    // legacy-режим: берём последний импорт
    const { data } = await supabaseAdmin
      .from('schedule_imports')
      .select('object_field, object_field_id, extended_attribute_defs, project_start_date, project_finish_date, project_name, project_calendar_settings')
      .order('imported_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    importMeta = (data ?? null) as ImportMetaRow | null
  }

  const objectField = opts.objectField ?? importMeta?.object_field ?? 'Text1'
  const projectName = opts.projectName ?? 'ZPR_Schedule'

  // FieldID для объектного поля — приоритет: import.object_field_id (для того же поля)
  const objectFieldId = (() => {
    if (objectField === 'Notes') return null
    if (importMeta?.object_field === objectField && importMeta?.object_field_id) {
      return importMeta.object_field_id
    }
    // Иначе ищем в декларациях по fieldName
    const def = importMeta?.extended_attribute_defs?.find(d => d.fieldName === objectField)
    return def?.fieldId ?? null
  })()

  // 1. Загружаем calendar_entries для указанной версии (или все если версии нет — legacy).
  let entriesQuery = supabaseAdmin
    .from('calendar_entries')
    .select(
      `id, mspdi_uid, mspdi_id, title, outline_level, outline_number, parent_entry_id,
       is_summary, is_project_wide, task_mode, date_start, date_end, percent_complete,
       mspdi_notes, mspdi_duration, schedule_raw_text, object_ids, entry_type, mspdi_passthrough`,
    )

  if (targetVersionId) {
    entriesQuery = entriesQuery.eq('schedule_version_id', targetVersionId)
  } else {
    // legacy: все schedule-записи (без фильтра по версии)
    entriesQuery = entriesQuery.or('mspdi_uid.not.is.null,entry_type.like.schedule_%')
  }

  const { data: entries, error: entriesErr } = await entriesQuery
  if (entriesErr) throw new Error(`calendar_entries select failed: ${entriesErr.message}`)

  const rows = (entries ?? []) as CalendarEntryRow[]
  if (rows.length === 0) {
    return serializeMspdi([], { projectName, projectTitle: projectName })
  }

  // 2. Back-fill mspdi_uid для строк без uid
  const existingUids = rows
    .map(r => r.mspdi_uid)
    .filter((u): u is number => u !== null)
  const maxUid = existingUids.length > 0 ? Math.max(...existingUids) : 0
  let nextUid = Math.max(maxUid + 1, NEW_UID_BASE)

  const newAssignments: Array<{ id: string; mspdi_uid: number }> = []
  for (const r of rows) {
    if (r.mspdi_uid === null) {
      r.mspdi_uid = nextUid++
      newAssignments.push({ id: r.id, mspdi_uid: r.mspdi_uid })
    }
  }
  if (newAssignments.length > 0) {
    // back-fill batch (последовательно, чтобы не перегружать)
    for (const { id, mspdi_uid } of newAssignments) {
      const { error } = await supabaseAdmin
        .from('calendar_entries')
        .update({ mspdi_uid })
        .eq('id', id)
      if (error) console.warn(`[schedule/export] back-fill mspdi_uid for ${id} failed: ${error.message}`)
    }
  }

  // 3. Загружаем предшественники.
  //    .in() с 400+ UUID превышает лимит длины URL у PostgREST (тихий пустой ответ),
  //    поэтому селектим всё и фильтруем в JS — у нас связей всего сотни/тысячи.
  const idSet = new Set(rows.map(r => r.id))
  // PostgREST режет ответ жёстким cap (обычно 1000). Грузим связи постранично,
  // иначе связи последних версий (после 1000-й строки таблицы) теряются.
  const allPreds: PredecessorRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data: page, error: pErr } = await supabaseAdmin
      .from('calendar_predecessors')
      .select('calendar_id, predecessor_id, link_type, lag, lag_type')
      .range(from, from + 999)
    if (pErr) { console.warn(`calendar_predecessors select: ${pErr.message}`); break }
    if (!page || page.length === 0) break
    allPreds.push(...(page as PredecessorRow[]))
    if (page.length < 1000) break
  }
  const predRows = allPreds
    .filter(p => idSet.has(p.calendar_id) && idSet.has(p.predecessor_id))

  // 4. Имена объектов для Text1
  const allObjectIds = new Set<string>()
  for (const r of rows) {
    for (const oid of r.object_ids) allObjectIds.add(oid)
  }
  const objectMap = new Map<string, ObjectRow>()
  if (allObjectIds.size > 0) {
    const { data: objs, error: objErr } = await supabaseAdmin
      .from('objects')
      .select('id, code, current_name')
      .in('id', Array.from(allObjectIds))
    if (objErr) console.warn(`objects select: ${objErr.message}`)
    for (const o of (objs ?? []) as ObjectRow[]) objectMap.set(o.id, o)
  }

  // 5. Маппинг uuid → mspdi_uid
  const uuidToUid = new Map<string, number>()
  for (const r of rows) uuidToUid.set(r.id, r.mspdi_uid as number)

  // 5b. Гарантируем маппинги «код объекта → этот объект» в schedule_object_mapping.
  //     Это обеспечивает round-trip: после экспорта в Текст15 окажутся коды,
  //     при следующем импорте они должны резолвиться через mapping.
  //     Уникальный индекс — на lower(raw_text), supabase-js не умеет ON CONFLICT
  //     на expression-индекс, поэтому SELECT + INSERT отсутствующих.
  const desiredCodes = Array.from(objectMap.values()).map(o => ({ raw_text: o.code, object_id: o.id }))
  desiredCodes.push({ raw_text: 'ЗПР', object_id: null as unknown as string })

  const { data: existingMaps } = await supabaseAdmin
    .from('schedule_object_mapping')
    .select('raw_text')
  const existingSet = new Set((existingMaps ?? []).map(m => m.raw_text.trim().toLowerCase()))

  const toInsert = desiredCodes
    .filter(d => !existingSet.has(d.raw_text.trim().toLowerCase()))
    .map(d => d.raw_text === 'ЗПР'
      ? { raw_text: 'ЗПР', object_id: null, is_project_wide: true }
      : { raw_text: d.raw_text, object_id: d.object_id, is_project_wide: false })

  if (toInsert.length > 0) {
    const { error } = await supabaseAdmin.from('schedule_object_mapping').insert(toInsert)
    if (error) console.warn(`[export] auto-mapping insert: ${error.message}`)
    else console.log(`[export] auto-created ${toInsert.length} code mappings: ${toInsert.map(r => r.raw_text).join(', ')}`)
  }

  // 6. Конвертируем в SerializeTask[]
  // Пишем УТВЕРЖДЁННЫЕ ШИФРЫ ЗПР (objects.code) в поле привязки —
  // унифицированный язык графика. Round-trip обеспечивается тем, что мы
  // ниже UPSERT-им маппинги «код объекта → тот же объект», так что повторный
  // импорт того же файла найдёт привязку.
  // Флаги по объектам (Флаг1..Флаг8): значение хранится в задаче → едет с файлом.
  // Пользователь создаёт фильтр «Флаг_N = Да» один раз. Флаг_i = 1 для задач
  // объекта_i ИЛИ общих «ВСЕ ОБЪЕКТЫ» (как в исходной логике фильтров).
  const FLAG_SERVICE = new Set(['ВСЕ ОБЪЕКТЫ', 'Градостроительная документация', 'Работы ДонАвтоДор', 'Работы по межеванию и кадастрированию'])
  const FLAG_FIELD_BASE = 188743752  // FieldID Флаг1 (далее +1: Флаг2..Флаг8)
  const flagObjects = Array.from(new Set(rows.map(r => r.schedule_raw_text).filter((x): x is string => !!x && !FLAG_SERVICE.has(x)))).sort()
  // MS Project молча отклоняет alias со скобками/слешем → поле остаётся без имени.
  // Чистим: убираем «()», слеш → дефис, схлопываем пробелы.
  const cleanAlias = (s: string) => s.replace(/[()]/g, '').replace(/\//g, '-').replace(/\s+/g, ' ').trim()
  const flagDefs = flagObjects.map((obj, i) => ({
    fieldName: `Флаг${i + 1}`,
    alias: cleanAlias(obj),
    fieldId: String(FLAG_FIELD_BASE + i),
  }))

  // outline_level=0 — пустые строки-разделители MS Project, не экспортируем (ломают иерархию XML)
  const serTasks: SerializeTask[] = rows.filter(r => r.outline_level !== 0 && r.outline_level !== null).map(r => {
    const codes = r.object_ids.map(id => objectMap.get(id)?.code).filter(Boolean) as string[]
    const objectText = (() => {
      if (r.is_project_wide) return 'ЗПР'
      if (codes.length > 0) return codes.join(', ')
      // Fallback для записей без привязки: возвращаем оригинальный raw_text если есть
      if (r.schedule_raw_text) return r.schedule_raw_text
      return null
    })()

    // Заголовок: чистый title + суффикс «— {code}» (или «— ЗПР»), если в title его ещё нет
    const exportTitle = (() => {
      const baseTitle = (r.title ?? '').trim()
      if (!baseTitle) return baseTitle
      let suffix: string | null = null
      if (r.is_project_wide) suffix = 'ЗПР'
      else if (codes.length > 0) suffix = codes.join(', ')
      if (!suffix) return baseTitle
      // не дублируем если уже есть в заголовке
      if (baseTitle.toLowerCase().includes(suffix.toLowerCase())) return baseTitle
      return `${baseTitle} — ${suffix}`
    })()

    const ext: Record<string, string> = {}
    if (objectText && objectField !== 'Notes') ext[objectField] = objectText
    // Проставляем флаги: объект задачи + общие «ВСЕ ОБЪЕКТЫ» попадают во все флаги
    const rt = r.schedule_raw_text
    if (rt) {
      flagObjects.forEach((obj, i) => {
        if (rt === obj || rt === 'ВСЕ ОБЪЕКТЫ') ext[`Флаг${i + 1}`] = '1'
      })
    }

    const notes = (() => {
      if (objectField === 'Notes' && objectText) return objectText
      return r.mspdi_notes
    })()

    return {
      uid: r.mspdi_uid as number,
      id: r.mspdi_id,
      name: exportTitle,
      outlineLevel: r.outline_level,
      outlineNumber: r.outline_number,
      parentUid: r.parent_entry_id ? uuidToUid.get(r.parent_entry_id) ?? null : null,
      isSummary: r.is_summary,
      // Веха — по типу записи, НЕ по совпадению дат: 1-дневная задача тоже
      // имеет date_start==date_end, но это не milestone (у неё своя длительность).
      isMilestone: r.entry_type === 'schedule_milestone',
      // Задачи после Форэскиза (разделы 5+: Концепция, Проект, Экспертиза, РНС) —
      // AUTO, чтобы Project пересчитывал по предшественникам (пользователь играет
      // с графиком). Форэскиз/ИРД/кадастр (разделы 1–4) — как в БД (manual, договорные).
      manual: (parseInt((r.outline_number ?? '0').split('.')[0], 10) >= 5)
        ? false
        : (r.task_mode === 'manual'),
      start: r.date_start,
      finish: r.date_end,
      duration: r.mspdi_duration,
      percentComplete: r.percent_complete,
      notes,
      extendedAttributes: ext,
      predecessors: predRows
        .filter(p => p.calendar_id === r.id)
        .map(p => ({
          predecessorUid: uuidToUid.get(p.predecessor_id) ?? -1,
          type: p.link_type,
          lagDays: p.lag,
          lagType: p.lag_type,
        }))
        .filter(p => p.predecessorUid > 0),
      // Round-trip: массив → восстановить из оригинала; null → UI-задача (шаблон).
      passthrough: Array.isArray(r.mspdi_passthrough) ? r.mspdi_passthrough : null,
    }
  })

  // Декларации ExtendedAttribute — восстанавливаем из последнего импорта,
  // плюс гарантируем наличие нашего objectField.
  const extDefs: Array<{ fieldName: string; alias: string; fieldId?: string }> = []
  for (const d of importMeta?.extended_attribute_defs ?? []) {
    extDefs.push({
      fieldName: d.fieldName,
      alias: d.alias ?? '',
      fieldId: d.fieldId,
    })
  }
  // Гарантируем декларацию objectField, если её ещё нет
  if (objectField !== 'Notes' && !extDefs.find(d => d.fieldName === objectField)) {
    extDefs.push({
      fieldName: objectField,
      alias: 'Наименование объекта',
      fieldId: objectFieldId ?? undefined,
    })
  }
  // Декларации флагов по объектам (Флаг1..Флаг8) — alias = название объекта
  for (const fd of flagDefs) {
    if (!extDefs.find(d => d.fieldName === fd.fieldName)) extDefs.push(fd)
  }

  const cal = importMeta?.project_calendar_settings ?? null
  const serializeOpts: SerializeOptions = {
    projectName,
    projectTitle: importMeta?.project_name ?? 'ЗПР — Совмещённый график',
    startDate:  importMeta?.project_start_date  ?? null,
    finishDate: importMeta?.project_finish_date ?? null,
    calendar: cal ? {
      minutesPerDay:     cal.minutes_per_day,
      minutesPerWeek:    cal.minutes_per_week,
      daysPerMonth:      cal.days_per_month,
      defaultStartTime:  cal.default_start_time,
      defaultFinishTime: cal.default_finish_time,
    } : undefined,
    extendedAttributes: extDefs,
    // Фильтры в XML НЕ генерируем: MS Project хранит их в Global.mpt (профиль ПК),
    // а не в файле — из .xml они не подхватываются. Разбивка по объектам делается
    // через поле Текст15 (группировка/автофильтр), которое едет с файлом.
  }

  return serializeMspdi(serTasks, serializeOpts)
}
