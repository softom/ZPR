/**
 * Парсер MS Project XML (MSPDI) → MspdiProject.
 *
 * Реализация на fast-xml-parser. Игнорирует namespace-префиксы
 * (Project/@xmlns="http://schemas.microsoft.com/project").
 */

import { XMLParser } from 'fast-xml-parser'

import {
  MSPDI_EXTENDED_FIELD_BY_ID,
  MSPDI_LAG_FORMAT,
  MSPDI_LINK_TYPE,
  type ExtendedAttributeDef,
  type MspdiPredecessor,
  type MspdiProject,
  type MspdiTask,
} from './mspdiTypes'

// ─── Хелперы нормализации одиночных/массивных полей ─────────────────────────

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return []
  return Array.isArray(x) ? x : [x]
}

function trimText(x: unknown): string | null {
  if (x === undefined || x === null) return null
  const s = String(x).trim()
  return s.length > 0 ? s : null
}

function asInt(x: unknown): number | null {
  if (x === undefined || x === null || x === '') return null
  const n = Number(x)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function asBool(x: unknown): boolean {
  // MSPDI: '0' / '1' / true / false
  if (x === true || x === 1 || x === '1') return true
  return false
}

function isoDate(x: unknown): string | null {
  // Примеры в MSPDI: '2026-03-20T08:00:00' (NETWORKDATETIME). Иногда без времени.
  const s = trimText(x)
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

// ─── Lag перевод в дни ──────────────────────────────────────────────────────

/**
 * MSPDI хранит LinkLag в «десятых долях минут» (внутреннее представление).
 *  - 1 день = 600 минут × 10 (если рассматривать рабочий 8-часовой день: 60 × 8 × 10 = 4800)
 *  - 1 elapsed-день = 60 × 24 × 10 = 14400
 *
 * Возвращает {days, type} в нашей семантике.
 *
 * Если LagFormat не распознан или формат «процент» — возвращаем 0/calendar.
 */
function lagToDays(linkLagRaw: unknown, lagFormatRaw: unknown): { lagDays: number; lagType: 'calendar' | 'working' } {
  const linkLag = asInt(linkLagRaw) ?? 0
  const lagFormat = asInt(lagFormatRaw)
  if (linkLag === 0) return { lagDays: 0, lagType: 'calendar' }

  const fmt = lagFormat !== null ? MSPDI_LAG_FORMAT[lagFormat] : undefined
  if (!fmt || fmt.unit === 'p') return { lagDays: 0, lagType: 'calendar' }

  const minutesPerWorkDay = 60 * 8           // стандартный рабочий день MS Project
  const minutesPerCalDay  = 60 * 24
  const tenthMinutes      = linkLag           // 1/10 минуты

  let days: number
  if (fmt.elapsed) {
    days = tenthMinutes / 10 / minutesPerCalDay
    return { lagDays: Math.round(days), lagType: 'calendar' }
  } else {
    days = tenthMinutes / 10 / minutesPerWorkDay
    return { lagDays: Math.round(days), lagType: 'working' }
  }
}

// ─── Иерархия: вычисление parentUid из стека OutlineLevel ──────────────────

function computeParentUids(tasks: MspdiTask[]): void {
  // Стек последних задач каждого уровня: index = OutlineLevel.
  const lastByLevel = new Map<number, number>()
  for (const t of tasks) {
    const lvl = t.outlineLevel ?? null
    if (lvl === null || lvl <= 1) {
      t.parentUid = null
    } else {
      // Родитель = последняя задача с уровнем lvl-1, появившаяся ДО текущей.
      const parent = lastByLevel.get(lvl - 1)
      t.parentUid = parent ?? null
    }
    if (lvl !== null) {
      lastByLevel.set(lvl, t.uid)
      // Очистить кэш более глубоких уровней (мы спустились вверх по дереву)
      for (const key of Array.from(lastByLevel.keys())) {
        if (key > lvl) lastByLevel.delete(key)
      }
    }
  }
}

// ─── Главная функция ───────────────────────────────────────────────────────

export function parseMspdi(xml: string): MspdiProject {
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,        // строки → строки (даты сами разберём)
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => {
      // Поля, которые могут быть как одиночными, так и множественными — всегда массив
      return ['Task', 'PredecessorLink', 'ExtendedAttribute', 'Resource', 'Assignment'].includes(name)
    },
  })

  const root = parser.parse(xml) as Record<string, unknown>
  const project = (root?.Project ?? root) as Record<string, unknown>
  if (!project || typeof project !== 'object') {
    throw new Error('Не нашли корневой элемент <Project> в XML')
  }

  // ─── ExtendedAttributes (декларации полей в шапке) ────────────────────────
  const extDefs: Record<string, ExtendedAttributeDef> = {}
  const extDeclList = asArray((project.ExtendedAttributes as Record<string, unknown> | undefined)?.ExtendedAttribute)
  for (const def of extDeclList as Record<string, unknown>[]) {
    const fieldId = trimText(def.FieldID)
    if (!fieldId) continue
    const fieldName = trimText(def.FieldName) ?? MSPDI_EXTENDED_FIELD_BY_ID[fieldId] ?? fieldId
    extDefs[fieldId] = {
      fieldId,
      fieldName,
      alias: trimText(def.Alias),
    }
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────
  const taskNodes = asArray((project.Tasks as Record<string, unknown> | undefined)?.Task)
  const tasks: MspdiTask[] = []

  for (const node of taskNodes as Record<string, unknown>[]) {
    const uid = asInt(node.UID)
    if (uid === null || uid === 0) continue   // UID=0 — это «корень проекта», игнорируем

    // Extended attributes (значения полей конкретной задачи)
    const extValues: Record<string, string> = {}
    const extList = asArray(node.ExtendedAttribute) as Record<string, unknown>[]
    for (const ea of extList) {
      const fieldId = trimText(ea.FieldID)
      const value = trimText(ea.Value)
      if (!fieldId || value === null) continue
      // Имя поля — из деклараций или из карты по умолчанию
      const fieldName = extDefs[fieldId]?.fieldName ?? MSPDI_EXTENDED_FIELD_BY_ID[fieldId] ?? fieldId
      extValues[fieldName] = value
    }

    // Predecessors
    const predNodes = asArray(node.PredecessorLink) as Record<string, unknown>[]
    const predecessors: MspdiPredecessor[] = []
    for (const p of predNodes) {
      const predUid = asInt(p.PredecessorUID)
      if (predUid === null) continue
      const typeNum = asInt(p.Type) ?? 1   // default FS
      const linkType = MSPDI_LINK_TYPE[typeNum] ?? 'FS'
      const { lagDays, lagType } = lagToDays(p.LinkLag, p.LagFormat)
      predecessors.push({
        predecessorUid: predUid,
        type: linkType,
        lagDays,
        lagType,
        lagFormat: asInt(p.LagFormat),
      })
    }

    tasks.push({
      uid,
      id: asInt(node.ID),
      name: trimText(node.Name) ?? `Task ${uid}`,
      outlineLevel: asInt(node.OutlineLevel),
      outlineNumber: trimText(node.OutlineNumber),
      parentUid: null,                                   // заполним ниже
      isSummary: asBool(node.Summary),
      isMilestone: asBool(node.Milestone),
      active: node.Active === undefined ? true : asBool(node.Active),
      manual: asBool(node.Manual),
      start: isoDate(node.Start),
      finish: isoDate(node.Finish),
      durationText: trimText(node.Duration),
      percentComplete: asInt(node.PercentComplete),
      notes: trimText(node.Notes),
      extendedAttributes: extValues,
      predecessors,
    })
  }

  computeParentUids(tasks)

  return {
    name:        trimText(project.Name),
    title:       trimText(project.Title),
    startDate:   isoDate(project.StartDate),
    finishDate:  isoDate(project.FinishDate),
    calendar: {
      minutesPerDay:    asInt(project.MinutesPerDay),
      minutesPerWeek:   asInt(project.MinutesPerWeek),
      daysPerMonth:     asInt(project.DaysPerMonth),
      defaultStartTime: trimText(project.DefaultStartTime),
      defaultFinishTime: trimText(project.DefaultFinishTime),
      calendarUid:      trimText(project.CalendarUID),
    },
    extendedAttributeDefs: extDefs,
    tasks,
  }
}

/**
 * Утилита: достать значение поля привязки задачи к объекту по `objectField` из schedule_imports.
 *  - 'Notes' → task.notes
 *  - 'Text1'..'Text30' → task.extendedAttributes[fieldName]
 */
export function readObjectField(task: MspdiTask, objectField: string): string | null {
  if (!objectField || objectField === 'Notes') return task.notes
  return task.extendedAttributes[objectField] ?? null
}
