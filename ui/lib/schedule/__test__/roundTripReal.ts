/**
 * Round-trip на реальном файле «Совмещенный график v014.xml».
 *
 * Без БД: parse → serialize (с эмуляцией метаданных импорта) → parse
 * → проверки сохранения структуры, кастомного FieldID, кириллицы.
 */

import fs from 'fs'
import { parseMspdi } from '../mspdiParser'
import { serializeMspdi, type SerializeTask } from '../mspdiSerializer'

const XML_PATH = 'D:/Dropbox/ЗПР/ГРАФИКИ/XML/Совмещенный график v014.xml'
const xml = fs.readFileSync(XML_PATH, 'utf-8')

console.log('=== PARSE ORIG ===')
const t0 = Date.now()
const orig = parseMspdi(xml)
console.log(`  parsed ${orig.tasks.length} tasks in ${Date.now() - t0} ms`)

// FieldID 188744001 для «Текст15»
const tekst15Def = Object.values(orig.extendedAttributeDefs).find(d => d.fieldName === 'Текст15')
console.log(`  Текст15 fieldId: ${tekst15Def?.fieldId}  alias: «${tekst15Def?.alias}»`)
const sample = orig.tasks.find(t => t.extendedAttributes['Текст15'])
console.log(`  sample task: «${sample?.name}» Текст15="${sample?.extendedAttributes['Текст15']}"`)

console.log('\n=== SERIALIZE (round-trip) ===')

// Эмулируем сохранение из БД: декларации из orig + FieldID для каждого fieldName
const extDefs = Object.values(orig.extendedAttributeDefs).map(d => ({
  fieldName: d.fieldName,
  alias: d.alias ?? '',
  fieldId: d.fieldId,
}))

const serTasks: SerializeTask[] = orig.tasks.map(t => ({
  uid: t.uid,
  id: t.id,
  name: t.name,
  outlineLevel: t.outlineLevel,
  outlineNumber: t.outlineNumber,
  parentUid: t.parentUid,
  isSummary: t.isSummary,
  isMilestone: t.isMilestone,
  manual: t.manual,
  start: t.start,
  finish: t.finish,
  duration: t.durationText,
  percentComplete: t.percentComplete,
  notes: t.notes,
  extendedAttributes: t.extendedAttributes,
  predecessors: t.predecessors.map(p => ({
    predecessorUid: p.predecessorUid,
    type: p.type,
    lagDays: p.lagDays,
    lagType: p.lagType,
  })),
}))

const t1 = Date.now()
const xml2 = serializeMspdi(serTasks, {
  projectName: orig.name,
  projectTitle: orig.title,
  startDate: orig.startDate,
  finishDate: orig.finishDate,
  extendedAttributes: extDefs,
})
console.log(`  serialized ${(xml2.length / 1024 / 1024).toFixed(2)} MB in ${Date.now() - t1} ms`)

// Сохраним для визуальной проверки
const outPath = 'D:/Dropbox/ЗПР/ГРАФИКИ/XML/_round_trip_result.xml'
fs.writeFileSync(outPath, xml2, 'utf-8')
console.log(`  saved: ${outPath}`)

console.log('\n=== PARSE RE-SERIALIZED ===')
const t2 = Date.now()
const back = parseMspdi(xml2)
console.log(`  parsed ${back.tasks.length} tasks in ${Date.now() - t2} ms`)

// ─── Проверки ─────────────────────────────────────────────────────────
function fail(msg: string): never {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
function ok(msg: string): void { console.log(`✓ ${msg}`) }

console.log('\n=== ASSERTIONS ===')

if (back.tasks.length !== orig.tasks.length) fail(`tasks count: ${back.tasks.length} vs ${orig.tasks.length}`)
ok(`tasks count preserved: ${back.tasks.length}`)

const tekst15Back = Object.values(back.extendedAttributeDefs).find(d => d.fieldName === 'Текст15')
if (!tekst15Back) fail('Текст15 declaration lost')
if (tekst15Back.fieldId !== tekst15Def?.fieldId) fail(`Текст15 fieldId changed: ${tekst15Back.fieldId} vs ${tekst15Def?.fieldId}`)
ok(`Текст15 fieldId preserved: ${tekst15Back.fieldId}`)

const sampleBack = back.tasks.find(t => t.uid === sample?.uid)
if (sampleBack?.extendedAttributes['Текст15'] !== sample?.extendedAttributes['Текст15']) {
  fail(`Текст15 value changed for UID ${sample?.uid}`)
}
ok(`Текст15 value preserved for sample task: «${sampleBack?.extendedAttributes['Текст15']}»`)

// Иерархия
const samplesWithParent = orig.tasks.filter(t => t.parentUid !== null).slice(0, 5)
for (const t of samplesWithParent) {
  const tback = back.tasks.find(b => b.uid === t.uid)
  if (tback?.parentUid !== t.parentUid) {
    fail(`parentUid changed for UID ${t.uid}: ${tback?.parentUid} vs ${t.parentUid}`)
  }
}
ok(`parentUid preserved for ${samplesWithParent.length} sample tasks`)

// Predecessors
const totalPredsOrig = orig.tasks.reduce((s, t) => s + t.predecessors.length, 0)
const totalPredsBack = back.tasks.reduce((s, t) => s + t.predecessors.length, 0)
if (totalPredsOrig !== totalPredsBack) fail(`predecessors count: ${totalPredsBack} vs ${totalPredsOrig}`)
ok(`predecessors count preserved: ${totalPredsBack}`)

// Lag preservation (выборочно: первая задача с lag>0)
const taskWithLag = orig.tasks.find(t => t.predecessors.some(p => p.lagDays > 0))
if (taskWithLag) {
  const tback = back.tasks.find(t => t.uid === taskWithLag.uid)
  const origLag = taskWithLag.predecessors.find(p => p.lagDays > 0)!
  const backLag = tback?.predecessors.find(p => p.predecessorUid === origLag.predecessorUid)
  if (!backLag) fail(`predecessor lost`)
  if (backLag.lagDays !== origLag.lagDays || backLag.lagType !== origLag.lagType) {
    fail(`lag changed: ${backLag.lagDays}/${backLag.lagType} vs ${origLag.lagDays}/${origLag.lagType}`)
  }
  ok(`lag preserved: UID=${taskWithLag.uid} pred=${origLag.predecessorUid} lag=${origLag.lagDays} ${origLag.lagType}`)
}

// PercentComplete (выборочно)
const taskWithPercent = orig.tasks.find(t => (t.percentComplete ?? 0) > 0)
if (taskWithPercent) {
  const tback = back.tasks.find(t => t.uid === taskWithPercent.uid)
  if (tback?.percentComplete !== taskWithPercent.percentComplete) {
    fail(`percent_complete changed for UID ${taskWithPercent.uid}`)
  }
  ok(`percent_complete preserved: UID=${taskWithPercent.uid} pct=${taskWithPercent.percentComplete}`)
}

// Кириллица в названии
const taskCyr = orig.tasks.find(t => /[А-Яа-я]/.test(t.name))
if (taskCyr) {
  const tback = back.tasks.find(t => t.uid === taskCyr.uid)
  if (tback?.name !== taskCyr.name) fail(`cyrillic name changed for UID ${taskCyr.uid}`)
  ok(`cyrillic name preserved: «${taskCyr.name.slice(0, 60)}»`)
}

// Уникальные значения Текст15 совпадают
const valsOrig = new Set<string>()
const valsBack = new Set<string>()
for (const t of orig.tasks) if (t.extendedAttributes['Текст15']) valsOrig.add(t.extendedAttributes['Текст15'])
for (const t of back.tasks) if (t.extendedAttributes['Текст15']) valsBack.add(t.extendedAttributes['Текст15'])
if (valsOrig.size !== valsBack.size) fail(`unique Текст15 count: ${valsBack.size} vs ${valsOrig.size}`)
for (const v of valsOrig) {
  if (!valsBack.has(v)) fail(`Текст15 value lost: «${v}»`)
}
ok(`Текст15 unique values preserved: ${valsBack.size}`)

console.log('\n🎉 ROUND-TRIP НА РЕАЛЬНОМ ФАЙЛЕ ПРОЙДЕН')
