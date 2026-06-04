/**
 * Показывает все уникальные значения по конкретному полю + примеры задач.
 * Запуск: npx tsx ui/lib/schedule/__test__/inspectField.ts <FieldName>
 *
 * Например:  npx tsx ui/lib/schedule/__test__/inspectField.ts Текст15
 */

import fs from 'fs'
import { parseMspdi } from '../mspdiParser'

const XML_PATH = 'D:/Dropbox/ЗПР/ГРАФИКИ/XML/Совмещенный график v014.xml'
const fieldName = process.argv[2] ?? 'Текст15'

const xml = fs.readFileSync(XML_PATH, 'utf-8')
const project = parseMspdi(xml)

const valueCounts = new Map<string, number>()
const sampleByValue = new Map<string, string[]>()

for (const t of project.tasks) {
  const v = t.extendedAttributes[fieldName]
  if (!v) continue
  valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1)
  const arr = sampleByValue.get(v) ?? []
  if (arr.length < 3) arr.push(`[L${t.outlineLevel}] ${t.outlineNumber} «${t.name.slice(0, 70)}»`)
  sampleByValue.set(v, arr)
}

console.log(`Поле: ${fieldName}`)
console.log(`Уникальных значений: ${valueCounts.size}`)
console.log(`Задач с заполненным полем: ${[...valueCounts.values()].reduce((a, b) => a + b, 0)} из ${project.tasks.length}`)
console.log()

const sorted = [...valueCounts.entries()].sort((a, b) => b[1] - a[1])
for (const [v, cnt] of sorted) {
  console.log(`\n«${v}»  (${cnt} задач)`)
  for (const s of sampleByValue.get(v) ?? []) {
    console.log(`    ${s}`)
  }
}

console.log('\n\n=== ВСЕ ДЕКЛАРАЦИИ EXTENDED ATTRIBUTES ===')
for (const d of Object.values(project.extendedAttributeDefs)) {
  let count = 0
  for (const t of project.tasks) {
    if (t.extendedAttributes[d.fieldName]) count++
  }
  console.log(`  ${d.fieldName.padEnd(15)} alias="${(d.alias ?? '').padEnd(30)}"  fieldId=${d.fieldId}  заполнено в ${count} задачах`)
}
