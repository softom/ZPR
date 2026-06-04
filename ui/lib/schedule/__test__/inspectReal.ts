/**
 * Inspect: прогоняет парсер на реальном файле «Совмещенный график v014.xml»
 * и печатает статистику + примеры raw_text-ов, которые встречаются в Notes
 * и ExtendedAttributes.
 *
 * Запуск: npx tsx ui/lib/schedule/__test__/inspectReal.ts
 */

import fs from 'fs'
import { parseMspdi, readObjectField } from '../mspdiParser'

const XML_PATH = 'D:/Dropbox/ЗПР/ГРАФИКИ/XML/Совмещенный график v014.xml'

const xml = fs.readFileSync(XML_PATH, 'utf-8')
console.log(`Файл: ${XML_PATH}`)
console.log(`Размер: ${(xml.length / 1024 / 1024).toFixed(2)} МБ\n`)

const t0 = Date.now()
const project = parseMspdi(xml)
console.log(`⏱ Парсинг: ${Date.now() - t0} мс\n`)

console.log('=== ПРОЕКТ ===')
console.log(`Name:       ${project.name}`)
console.log(`Title:      ${project.title}`)
console.log(`StartDate:  ${project.startDate}`)
console.log(`FinishDate: ${project.finishDate}`)
console.log()

console.log('=== EXTENDED ATTRIBUTES (декларации) ===')
const defs = Object.values(project.extendedAttributeDefs)
if (defs.length === 0) {
  console.log('  (нет деклараций)')
} else {
  for (const d of defs) {
    console.log(`  ${d.fieldName}  alias="${d.alias ?? ''}"  fieldId=${d.fieldId}`)
  }
}
console.log()

console.log('=== СТАТИСТИКА ЗАДАЧ ===')
console.log(`Всего задач:        ${project.tasks.length}`)
console.log(`С OutlineLevel=1:   ${project.tasks.filter(t => t.outlineLevel === 1).length}`)
console.log(`С OutlineLevel=2:   ${project.tasks.filter(t => t.outlineLevel === 2).length}`)
console.log(`С OutlineLevel=3:   ${project.tasks.filter(t => t.outlineLevel === 3).length}`)
console.log(`С OutlineLevel>=4:  ${project.tasks.filter(t => (t.outlineLevel ?? 0) >= 4).length}`)
console.log(`Summary (сводные):  ${project.tasks.filter(t => t.isSummary).length}`)
console.log(`Milestone (вехи):   ${project.tasks.filter(t => t.isMilestone).length}`)
console.log(`Manual:             ${project.tasks.filter(t => t.manual).length}`)
console.log(`С Notes:            ${project.tasks.filter(t => t.notes).length}`)
console.log(`С Text1..Text30:    ${project.tasks.filter(t => Object.keys(t.extendedAttributes).length > 0).length}`)
console.log(`С predecessors:     ${project.tasks.filter(t => t.predecessors.length > 0).length}`)
const totalPreds = project.tasks.reduce((s, t) => s + t.predecessors.length, 0)
console.log(`Всего связей:       ${totalPreds}`)
console.log()

console.log('=== ПЕРВЫЕ 5 ЗАДАЧ ВЕРХНЕГО УРОВНЯ ===')
const top = project.tasks.filter(t => t.outlineLevel === 1).slice(0, 5)
for (const t of top) {
  console.log(`  [UID=${t.uid}] ${t.outlineNumber ?? '?'} «${t.name}»  ${t.start}..${t.finish}  Summary=${t.isSummary}`)
}
console.log()

console.log('=== УНИКАЛЬНЫЕ ЗНАЧЕНИЯ ПО ПОЛЯМ (для определения, где привязка к объекту) ===')
const fields = ['Notes', 'Text1', 'Text2', 'Text3', 'Text4', 'Text5']
for (const field of fields) {
  const values = new Set<string>()
  for (const t of project.tasks) {
    const v = readObjectField(t, field)
    if (v) values.add(v.length > 80 ? v.slice(0, 80) + '…' : v)
  }
  console.log(`\n--- ${field} (${values.size} уникальных) ---`)
  if (values.size === 0) {
    console.log('  (нет значений)')
  } else {
    let i = 0
    for (const v of values) {
      console.log(`  ${++i}. ${v}`)
      if (i >= 12) {
        console.log(`  … и ещё ${values.size - 12}`)
        break
      }
    }
  }
}

console.log('\n=== ИЕРАРХИЯ: ПЕРВЫЕ 20 ЗАДАЧ ПО ПОРЯДКУ ===')
for (const t of project.tasks.slice(0, 20)) {
  const indent = '  '.repeat((t.outlineLevel ?? 1) - 1)
  console.log(
    `  ${indent}[L${t.outlineLevel}] ${t.outlineNumber ?? '?'} «${t.name.slice(0, 60)}»` +
    `  parent=${t.parentUid ?? '—'}  ${t.start ?? '?'}..${t.finish ?? '?'}`
  )
}
