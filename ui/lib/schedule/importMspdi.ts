/**
 * Импорт MSPDI XML → calendar_entries.
 *
 * Поток:
 *   1. parseMspdi(xml) → MspdiProject
 *   2. Загрузка справочников (objects, schedule_object_mapping) в память
 *   3. INSERT schedule_imports — получаем import_id
 *   4. Для каждой задачи: резолвим object_ids/is_project_wide через mapping
 *   5. UPSERT calendar_entries по mspdi_uid (один INSERT с ON CONFLICT)
 *   6. UPDATE parent_entry_id (второй проход — после получения uuid у всех новых)
 *   7. DELETE+INSERT calendar_predecessors для затронутых задач
 *   8. Recompute entity_links calendar_entry → object (belongs_to)
 *   9. UPDATE schedule_imports.tasks_* и mspdi_uid_max
 */

import { parseMspdi, readObjectField } from './mspdiParser'
import type { MspdiProject, MspdiTask } from './mspdiTypes'
import { supabaseAdmin } from '../supabase-admin'

export interface ImportInput {
  xml: string
  fileName: string
  fileSize: number
  /** Имя поля привязки задачи к объекту: 'Notes' | 'Text1'..'Text30'. Default 'Notes'. */
  objectField?: string
  importedByEmail?: string | null
  notes?: string | null
  /**
   * Режим импорта:
   *   - 'replace'       — полная замена (default). Все поля задачи перезаписываются,
   *                       привязки к объектам пересчитываются по mapping, title очищается.
   *                       Подходит для первой загрузки или когда правок в БД нет.
   *   - 'metadata-only' — обновляются только MSPDI-метаданные (mspdi_duration, mspdi_id,
   *                       outline_*, parent_entry_id, is_summary, task_mode, mspdi_notes,
   *                       predecessors). НЕ трогаются: title, date_start/end, object_ids,
   *                       is_project_wide, percent_complete, entity_links, schedule_raw_text.
   *                       Используется для пополнения новых полей в БД без потери ручных правок.
   */
  mode?: 'replace' | 'metadata-only'
}

export interface UnmappedRow {
  mspdiUid: number
  taskName: string
  rawText: string
}

export interface OrphanRow {
  id: string             // UUID в БД (для DELETE)
  mspdiUid: number       // Task UID из последнего импорта
  title: string | null
  dateStart: string | null
  dateEnd: string | null
}

export interface ImportResult {
  importId: string
  stats: {
    tasksTotal: number
    tasksInserted: number
    tasksUpdated: number
    tasksUnmapped: number
    tasksOrphaned: number     // были в БД, нет в новом XML
    predecessorsTotal: number
  }
  unmapped: UnmappedRow[]
  unknownRawTexts: string[]
  /** Задачи, которых нет в новом XML — кандидаты на удаление. */
  orphaned: OrphanRow[]
}

interface MappingRow {
  object_id: string | null
  is_project_wide: boolean
}

interface ObjectMeta {
  id: string
  code: string
  current_name: string | null
  aliases: string[]
}

// ─── Очистка заголовка от упоминаний объекта ───────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Удаляет из заголовка задачи упоминания привязанного объекта (по code и aliases),
 * чтобы не дублировать привязку, уже хранящуюся в object_ids.
 * Применяется только если после очистки остаётся осмысленный текст (≥3 символов),
 * иначе оставляем заголовок как есть (страховка от опустошения Summary-задач).
 */
function cleanTitle(
  rawTitle: string,
  objectId: string | null,
  objects: Map<string, ObjectMeta>,
  isSummary: boolean,
): string {
  // Summary-задачи (родительские группы) часто сами и есть «название объекта» —
  // их заголовок не трогаем.
  if (isSummary) return rawTitle
  if (!objectId) return rawTitle
  const obj = objects.get(objectId)
  if (!obj) return rawTitle

  // Кандидаты на удаление: aliases + code. current_name НЕ используем —
  // он часто содержит общие слова («Гостиница», «номеров»), которые ловят ложные срабатывания.
  const aliases = [...(obj.aliases ?? []), obj.code].filter(Boolean) as string[]
  // Длинные сначала — чтобы не вырезать частичные совпадения раньше полных
  aliases.sort((a, b) => b.length - a.length)

  let cleaned = rawTitle
  for (const alias of aliases) {
    if (alias.length < 3) continue
    const re = new RegExp(escapeRegex(alias), 'gi')
    const candidate = cleaned.replace(re, ' ').replace(/\s+/g, ' ').trim()
    // Чистим висячие разделители: тире, запятые, кавычки, точки, двоеточия.
    // Скобки НЕ трогаем — у них есть пары, висячая «)» без «(» бывает осмысленна.
    const stripped = candidate.replace(/^[\s\-—:,«»".]+|[\s\-—:,«»".]+$/g, '').trim()
    // Применяем очистку только если остался осмысленный текст:
    //   - длина ≥ 3 символа
    //   - есть хотя бы одна буква или цифра (не только пунктуация типа «( )»)
    if (stripped.length >= 3 && /[A-Za-zА-Яа-я0-9]/.test(stripped)) {
      cleaned = stripped
    }
  }
  // Финальная зачистка: пустые скобки/квадраты, двойные пробелы
  cleaned = cleaned
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
}

interface ResolvedObjects {
  objectIds: string[]
  isProjectWide: boolean
  unmapped: boolean
  rawText: string | null
}

// ─── Резолвер объектов ─────────────────────────────────────────────────────

function resolveObjects(
  task: MspdiTask,
  objectField: string,
  mapping: Map<string, MappingRow>,
): ResolvedObjects {
  const rawText = readObjectField(task, objectField)
  if (!rawText) {
    // Нет текста привязки — относим к проекту (общая задача)
    return { objectIds: [], isProjectWide: true, unmapped: false, rawText: null }
  }

  // Ключ маппинга — case-insensitive (как в БД)
  const key = rawText.trim().toLowerCase()
  const m = mapping.get(key)
  if (!m) {
    return { objectIds: [], isProjectWide: false, unmapped: true, rawText }
  }
  if (m.is_project_wide) {
    return { objectIds: [], isProjectWide: true, unmapped: false, rawText }
  }
  return {
    objectIds: m.object_id ? [m.object_id] : [],
    isProjectWide: false,
    unmapped: false,
    rawText,
  }
}

// ─── Эвристика entry_type по имени и иерархии ──────────────────────────────

function inferEntryType(task: MspdiTask): string {
  if (task.isMilestone) return 'schedule_milestone'
  if (task.isSummary)   return 'schedule_summary'
  return 'schedule_task'
}

// ─── Главная функция ───────────────────────────────────────────────────────

export async function importMspdiXml(input: ImportInput): Promise<ImportResult> {
  const objectField = input.objectField ?? 'Notes'
  const mode: 'replace' | 'metadata-only' = input.mode ?? 'replace'
  const project: MspdiProject = parseMspdi(input.xml)

  // 1. Загружаем mapping в память
  const { data: mapRows, error: mapErr } = await supabaseAdmin
    .from('schedule_object_mapping')
    .select('raw_text, object_id, is_project_wide')
  if (mapErr) throw new Error(`schedule_object_mapping select failed: ${mapErr.message}`)

  const mapping = new Map<string, MappingRow>()
  for (const r of (mapRows ?? [])) {
    mapping.set(r.raw_text.trim().toLowerCase(), {
      object_id: r.object_id,
      is_project_wide: r.is_project_wide,
    })
  }

  // 1b. Загружаем объекты (для очистки заголовков по aliases+code)
  const { data: objRows } = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name, aliases')
  const objects = new Map<string, ObjectMeta>()
  for (const o of (objRows ?? [])) {
    objects.set(o.id, {
      id: o.id,
      code: o.code,
      current_name: o.current_name,
      aliases: Array.isArray(o.aliases) ? o.aliases : [],
    })
  }

  // 2. Создаём запись schedule_imports (для FK last_import_id)
  const mspdiUidMax = project.tasks.reduce((m, t) => Math.max(m, t.uid), 0)

  // Найти FieldID для objectField из деклараций исходного файла (для round-trip)
  const objectFieldId = (() => {
    if (objectField === 'Notes') return null
    for (const d of Object.values(project.extendedAttributeDefs)) {
      if (d.fieldName === objectField) return d.fieldId
    }
    return null
  })()

  const extDefsJson = Object.values(project.extendedAttributeDefs).map(d => ({
    fieldId: d.fieldId,
    fieldName: d.fieldName,
    alias: d.alias,
  }))

  const { data: imp, error: impErr } = await supabaseAdmin
    .from('schedule_imports')
    .insert({
      file_name: input.fileName,
      file_size: input.fileSize,
      project_name: project.name,
      project_start_date: project.startDate,
      project_finish_date: project.finishDate,
      object_field: objectField,
      object_field_id: objectFieldId,
      extended_attribute_defs: extDefsJson,
      project_calendar_settings: {
        minutes_per_day:     project.calendar.minutesPerDay,
        minutes_per_week:    project.calendar.minutesPerWeek,
        days_per_month:      project.calendar.daysPerMonth,
        default_start_time:  project.calendar.defaultStartTime,
        default_finish_time: project.calendar.defaultFinishTime,
        calendar_uid:        project.calendar.calendarUid,
      },
      mspdi_uid_max: mspdiUidMax,
      tasks_total: project.tasks.length,
      imported_by_email: input.importedByEmail ?? null,
      notes: input.notes ?? null,
    })
    .select('id')
    .single()
  if (impErr || !imp) throw new Error(`schedule_imports insert failed: ${impErr?.message}`)
  const importId = imp.id as string

  try {
    return await runImport(importId, project, mapping, objects, objectField, mode)
  } catch (e) {
    // Если импорт упал — удаляем «осиротевшую» schedule_imports запись,
    // чтобы не копились пустые попытки.
    console.error(`[importMspdi] failed; cleaning up schedule_imports ${importId}`, e)
    await supabaseAdmin.from('schedule_imports').delete().eq('id', importId)
    throw e
  }
}

// ─── Внутренняя реализация импорта (всё после INSERT schedule_imports) ─────
async function runImport(
  importId: string,
  project: MspdiProject,
  mapping: Map<string, MappingRow>,
  objects: Map<string, ObjectMeta>,
  objectField: string,
  mode: 'replace' | 'metadata-only',
): Promise<ImportResult> {
  const unmapped: UnmappedRow[] = []
  const unknownRawTexts = new Set<string>()
  const upsertRows = project.tasks.map((t) => {
    const resolved = resolveObjects(t, objectField, mapping)
    if (resolved.unmapped && resolved.rawText) {
      unmapped.push({ mspdiUid: t.uid, taskName: t.name, rawText: resolved.rawText })
      unknownRawTexts.add(resolved.rawText)
    }

    // Поля MSPDI-метаданных (обновляются в любом режиме)
    const metaFields = {
      mspdi_uid: t.uid,
      mspdi_id: t.id,
      title_original: t.name,
      entry_type: inferEntryType(t),
      outline_level: t.outlineLevel,
      outline_number: t.outlineNumber,
      is_summary: t.isSummary,
      task_mode: t.manual ? 'manual' as const : 'auto' as const,
      mspdi_notes: t.notes,
      mspdi_duration: t.durationText,
      last_import_id: importId,
    }

    if (mode === 'metadata-only') {
      // Только метаданные — title, даты, привязки и % не трогаем
      return metaFields
    }

    // Полная замена (default)
    const singleObjectId = resolved.objectIds.length === 1 ? resolved.objectIds[0] : null
    const cleanedTitle = cleanTitle(t.name, singleObjectId, objects, t.isSummary)
    return {
      ...metaFields,
      title: cleanedTitle,
      percent_complete: t.percentComplete,
      date_mode: 'absolute' as const,
      date_start: t.start,
      date_end: t.finish,
      object_ids: resolved.objectIds,
      is_project_wide: resolved.isProjectWide,
      schedule_raw_text: resolved.rawText,
    }
  })

  // 4. UPSERT calendar_entries по mspdi_uid
  // Подсчитываем inserted/updated через сравнение с существующими (по mspdi_uid).
  const incomingUids = upsertRows.map(r => r.mspdi_uid)
  const incomingUidsSet = new Set(incomingUids)
  const { data: existing, error: exErr } = await supabaseAdmin
    .from('calendar_entries')
    .select('id, mspdi_uid')
    .in('mspdi_uid', incomingUids)
  if (exErr) throw new Error(`calendar_entries select existing failed: ${exErr.message}`)
  const existingUids = new Set((existing ?? []).map(r => r.mspdi_uid as number))
  const tasksInserted = incomingUids.filter(u => !existingUids.has(u)).length
  const tasksUpdated = incomingUids.length - tasksInserted

  // 4b. ОСИРОТЕВШИЕ: были в БД (mspdi_uid IS NOT NULL), нет в новом XML
  const { data: allMspdi } = await supabaseAdmin
    .from('calendar_entries')
    .select('id, mspdi_uid, title, date_start, date_end')
    .not('mspdi_uid', 'is', null)
  const orphaned: OrphanRow[] = []
  for (const row of (allMspdi ?? [])) {
    if (!incomingUidsSet.has(row.mspdi_uid as number)) {
      orphaned.push({
        id: row.id as string,
        mspdiUid: row.mspdi_uid as number,
        title: row.title as string | null,
        dateStart: row.date_start as string | null,
        dateEnd: row.date_end as string | null,
      })
    }
  }

  const BATCH = 200

  if (mode === 'replace') {
    // Делим upsert на батчи по 200 — supabase-js имеет лимиты на размер тела запроса
    for (let i = 0; i < upsertRows.length; i += BATCH) {
      const batch = upsertRows.slice(i, i + BATCH)
      const { error: upErr } = await supabaseAdmin
        .from('calendar_entries')
        .upsert(batch, { onConflict: 'mspdi_uid' })
      if (upErr) throw new Error(`calendar_entries upsert failed at batch ${i / BATCH}: ${upErr.message}`)
    }
  } else {
    // metadata-only: для существующих UPDATE по mspdi_uid; новые задачи (не было в БД) — пропускаем.
    // INSERT-режим не годится — postgres всё равно прогоняет проверки NOT NULL до ON CONFLICT.
    const existingSet = new Set(Array.from(existingUids))
    let updatedCount = 0
    let skippedNew = 0
    for (const row of upsertRows) {
      if (!existingSet.has(row.mspdi_uid)) { skippedNew++; continue }
      const { mspdi_uid, ...patch } = row
      const { error } = await supabaseAdmin
        .from('calendar_entries')
        .update(patch)
        .eq('mspdi_uid', mspdi_uid)
      if (error) console.warn(`[metadata-only] update mspdi_uid=${mspdi_uid}: ${error.message}`)
      else updatedCount++
    }
    if (skippedNew > 0) {
      console.warn(`[metadata-only] ${skippedNew} новых задач из XML не созданы (в этом режиме только UPDATE). Запустите 'replace' если нужно их добавить.`)
    }
    console.log(`[metadata-only] updated ${updatedCount}`)
  }

  // 5. После upsert — собираем mapping mspdi_uid → uuid
  const { data: allRows, error: allErr } = await supabaseAdmin
    .from('calendar_entries')
    .select('id, mspdi_uid')
    .in('mspdi_uid', incomingUids)
  if (allErr) throw new Error(`calendar_entries select uuid map failed: ${allErr.message}`)
  const uidToUuid = new Map<number, string>()
  for (const r of (allRows ?? [])) uidToUuid.set(r.mspdi_uid as number, r.id as string)

  // 6. UPDATE parent_entry_id
  for (const t of project.tasks) {
    const childUuid = uidToUuid.get(t.uid)
    if (!childUuid) continue
    const parentUuid = t.parentUid !== null ? uidToUuid.get(t.parentUid) ?? null : null
    if (parentUuid !== undefined) {
      const { error } = await supabaseAdmin
        .from('calendar_entries')
        .update({ parent_entry_id: parentUuid })
        .eq('id', childUuid)
      if (error) console.warn(`parent_entry_id update failed for ${t.uid}: ${error.message}`)
    }
  }

  // 7. Predecessors: чистим старые для затронутых задач, INSERT новые
  const affectedUuids = Array.from(uidToUuid.values())
  await supabaseAdmin
    .from('calendar_predecessors')
    .delete()
    .in('calendar_id', affectedUuids)

  let predecessorsTotal = 0
  const predRows: Array<{
    calendar_id: string
    predecessor_id: string
    link_type: 'FF' | 'FS' | 'SF' | 'SS'
    lag: number
    lag_type: 'calendar' | 'working'
    notes: string | null
  }> = []
  for (const t of project.tasks) {
    const calId = uidToUuid.get(t.uid)
    if (!calId) continue
    for (const p of t.predecessors) {
      const predId = uidToUuid.get(p.predecessorUid)
      if (!predId || predId === calId) continue   // self-link или ссылка на не-импортированную задачу
      predRows.push({
        calendar_id: calId,
        predecessor_id: predId,
        link_type: p.type,
        lag: p.lagDays,
        lag_type: p.lagType,
        notes: p.lagFormat !== null ? `MSPDI LagFormat=${p.lagFormat}` : null,
      })
    }
  }
  if (predRows.length > 0) {
    for (let i = 0; i < predRows.length; i += BATCH) {
      const batch = predRows.slice(i, i + BATCH)
      const { error: predErr } = await supabaseAdmin
        .from('calendar_predecessors')
        .insert(batch)
      if (predErr) console.warn(`calendar_predecessors insert batch ${i / BATCH}: ${predErr.message}`)
      else predecessorsTotal += batch.length
    }
  }

  // 8. entity_links calendar_entry → object (belongs_to)
  // В режиме metadata-only пропускаем — существующие привязки могут быть
  // ручными правками пользователя, не трогаем.
  if (mode === 'replace') {
    await supabaseAdmin
      .from('entity_links')
      .delete()
      .eq('from_type', 'calendar_entry')
      .eq('to_type', 'object')
      .eq('link_type', 'belongs_to')
      .in('from_id', affectedUuids)

    const linkRows: Array<{
      from_type: 'calendar_entry'
      from_id: string
      to_type: 'object'
      to_id: string
      link_type: 'belongs_to'
    }> = []
    for (const row of upsertRows) {
      // object_ids есть только в режиме 'replace' (поле опущено в metadata-only)
      const objectIds = (row as { object_ids?: string[] }).object_ids ?? []
      const calId = uidToUuid.get(row.mspdi_uid)
      if (!calId) continue
      for (const objId of objectIds) {
        linkRows.push({
          from_type: 'calendar_entry',
          from_id: calId,
          to_type: 'object',
          to_id: objId,
          link_type: 'belongs_to',
        })
      }
    }
    if (linkRows.length > 0) {
      for (let i = 0; i < linkRows.length; i += BATCH) {
        const batch = linkRows.slice(i, i + BATCH)
        const { error } = await supabaseAdmin.from('entity_links').insert(batch)
        if (error) console.warn(`entity_links insert batch ${i / BATCH}: ${error.message}`)
      }
    }
  }

  // 9. Финал: обновляем счётчики в schedule_imports
  const tasksUnmappedCount = unmapped.length
  const { error: updImpErr } = await supabaseAdmin
    .from('schedule_imports')
    .update({
      tasks_inserted: tasksInserted,
      tasks_updated: tasksUpdated,
      tasks_unmapped: tasksUnmappedCount,
      predecessors_total: predecessorsTotal,
    })
    .eq('id', importId)
  if (updImpErr) console.warn(`schedule_imports stats update failed: ${updImpErr.message}`)

  return {
    importId,
    stats: {
      tasksTotal: project.tasks.length,
      tasksInserted,
      tasksUpdated,
      tasksUnmapped: tasksUnmappedCount,
      tasksOrphaned: orphaned.length,
      predecessorsTotal,
    },
    unmapped,
    unknownRawTexts: Array.from(unknownRawTexts),
    orphaned,
  }
}
