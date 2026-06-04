/**
 * POST /api/schedule/preview-fields
 *
 * Принимает .xml в multipart, парсит его (без записи в БД!),
 * возвращает список деклараций ExtendedAttributes + статистику заполненности.
 * Используется UI для динамического выбора `objectField`.
 *
 * Тело запроса:
 *   file: File (.xml)
 *
 * Ответ:
 *   {
 *     fields: [
 *       { fieldName, alias, fieldId, nonEmpty, totalTasks, sample: ["..."] }
 *     ],
 *     hasNotes: { nonEmpty, totalTasks, sample: ["..."] },
 *     project: { name, title, startDate, finishDate, tasksCount }
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { parseMspdi } from '@/lib/schedule/mspdiParser'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch (e) {
    return NextResponse.json({ error: `multipart: ${e}` }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Поле "file" обязательно' }, { status: 400 })
  }

  const xml = await file.text()
  if (!xml.includes('<Project')) {
    return NextResponse.json({ error: 'Не похоже на MSPDI (нет <Project>)' }, { status: 400 })
  }

  let project
  try {
    project = parseMspdi(xml)
  } catch (e) {
    return NextResponse.json(
      { error: `Парсер: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    )
  }

  const fields: Array<{
    fieldName: string
    alias: string
    fieldId: string
    nonEmpty: number
    totalTasks: number
    uniqueValues: number
    sample: string[]
  }> = []

  const totalTasks = project.tasks.length
  for (const def of Object.values(project.extendedAttributeDefs)) {
    const valSet = new Set<string>()
    let nonEmpty = 0
    for (const t of project.tasks) {
      const v = t.extendedAttributes[def.fieldName]
      if (v) {
        nonEmpty++
        valSet.add(v)
      }
    }
    if (nonEmpty === 0) continue   // не показываем пустые поля
    fields.push({
      fieldName: def.fieldName,
      alias: def.alias ?? '',
      fieldId: def.fieldId,
      nonEmpty,
      totalTasks,
      uniqueValues: valSet.size,
      sample: Array.from(valSet).slice(0, 5),
    })
  }
  fields.sort((a, b) => b.nonEmpty - a.nonEmpty)

  // Notes
  let notesNonEmpty = 0
  const notesSet = new Set<string>()
  for (const t of project.tasks) {
    if (t.notes) {
      notesNonEmpty++
      if (notesSet.size < 5) notesSet.add(t.notes.slice(0, 80))
    }
  }

  return NextResponse.json({
    project: {
      name: project.name,
      title: project.title,
      startDate: project.startDate,
      finishDate: project.finishDate,
      tasksCount: project.tasks.length,
    },
    fields,
    notes: {
      nonEmpty: notesNonEmpty,
      totalTasks,
      sample: Array.from(notesSet),
    },
  })
}
