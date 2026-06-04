/**
 * Smoke-тест MSPDI parser + serializer.
 * Запуск: npx tsx ui/lib/schedule/__test__/smokeTest.ts
 *
 * Тест round-trip: synthetic XML → parse → serialize → parse → проверки.
 */

import { parseMspdi } from '../mspdiParser'
import { serializeMspdi } from '../mspdiSerializer'

const SYNTHETIC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>ZPR_Test</Name>
  <Title>ЗПР — Тестовый график</Title>
  <StartDate>2026-03-01T08:00:00</StartDate>
  <FinishDate>2026-12-31T17:00:00</FinishDate>
  <CalendarUID>1</CalendarUID>
  <ExtendedAttributes>
    <ExtendedAttribute>
      <FieldID>188743731</FieldID>
      <FieldName>Text1</FieldName>
      <Alias>Объект ЗПР</Alias>
    </ExtendedAttribute>
  </ExtendedAttributes>
  <Tasks>
    <Task>
      <UID>0</UID>
      <ID>0</ID>
      <Name>Корень</Name>
      <Active>1</Active>
      <Manual>0</Manual>
    </Task>
    <Task>
      <UID>1</UID>
      <ID>1</ID>
      <Name>Форэскиз</Name>
      <OutlineLevel>1</OutlineLevel>
      <OutlineNumber>1</OutlineNumber>
      <Summary>1</Summary>
      <Manual>0</Manual>
      <Start>2026-03-01T08:00:00</Start>
      <Finish>2026-05-31T17:00:00</Finish>
    </Task>
    <Task>
      <UID>2</UID>
      <ID>2</ID>
      <Name>Объект 002 — Массинг</Name>
      <OutlineLevel>2</OutlineLevel>
      <OutlineNumber>1.1</OutlineNumber>
      <Summary>0</Summary>
      <Manual>0</Manual>
      <Start>2026-03-01T08:00:00</Start>
      <Finish>2026-04-15T17:00:00</Finish>
      <PercentComplete>50</PercentComplete>
      <Notes>102_ГОСТИНИЦА_800</Notes>
      <ExtendedAttribute>
        <FieldID>188743731</FieldID>
        <Value>102_ГОСТИНИЦА_800</Value>
      </ExtendedAttribute>
    </Task>
    <Task>
      <UID>3</UID>
      <ID>3</ID>
      <Name>Объект 002 — Форэскиз</Name>
      <OutlineLevel>2</OutlineLevel>
      <OutlineNumber>1.2</OutlineNumber>
      <Summary>0</Summary>
      <Manual>0</Manual>
      <Start>2026-04-16T08:00:00</Start>
      <Finish>2026-05-31T17:00:00</Finish>
      <PercentComplete>0</PercentComplete>
      <Notes>102_ГОСТИНИЦА_800</Notes>
      <PredecessorLink>
        <PredecessorUID>2</PredecessorUID>
        <Type>1</Type>
        <CrossProject>0</CrossProject>
        <LinkLag>0</LinkLag>
        <LagFormat>5</LagFormat>
      </PredecessorLink>
      <ExtendedAttribute>
        <FieldID>188743731</FieldID>
        <Value>102_ГОСТИНИЦА_800</Value>
      </ExtendedAttribute>
    </Task>
    <Task>
      <UID>4</UID>
      <ID>4</ID>
      <Name>Сдача-приёмка ЗПР</Name>
      <OutlineLevel>1</OutlineLevel>
      <OutlineNumber>2</OutlineNumber>
      <Summary>0</Summary>
      <Milestone>1</Milestone>
      <Manual>0</Manual>
      <Start>2026-12-31T08:00:00</Start>
      <Finish>2026-12-31T17:00:00</Finish>
      <PercentComplete>0</PercentComplete>
      <Notes>ЗПР</Notes>
      <PredecessorLink>
        <PredecessorUID>3</PredecessorUID>
        <Type>1</Type>
        <CrossProject>0</CrossProject>
        <LinkLag>96000</LinkLag>
        <LagFormat>5</LagFormat>
      </PredecessorLink>
    </Task>
  </Tasks>
</Project>
`

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    console.error(`❌ ${msg}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`)
    process.exit(1)
  }
  console.log(`✓ ${msg}`)
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`)
    process.exit(1)
  }
  console.log(`✓ ${msg}`)
}

// ─── Парсинг ────────────────────────────────────────────────────────────
console.log('\n=== ПАРСИНГ ===')
const parsed = parseMspdi(SYNTHETIC_XML)

assertEq(parsed.name, 'ZPR_Test', 'project.name')
assertEq(parsed.title, 'ЗПР — Тестовый график', 'project.title')
assertEq(parsed.startDate, '2026-03-01', 'project.startDate')
assertEq(parsed.finishDate, '2026-12-31', 'project.finishDate')
assertEq(parsed.tasks.length, 4, 'tasks count (UID=0 пропущен)')

const t1 = parsed.tasks.find(t => t.uid === 1)!
assertTrue(!!t1, 't1 found')
assertEq(t1.name, 'Форэскиз', 't1.name')
assertEq(t1.isSummary, true, 't1.isSummary')
assertEq(t1.outlineLevel, 1, 't1.outlineLevel')
assertEq(t1.parentUid, null, 't1.parentUid (top-level)')

const t2 = parsed.tasks.find(t => t.uid === 2)!
assertEq(t2.parentUid, 1, 't2.parentUid → t1')
assertEq(t2.percentComplete, 50, 't2.percentComplete')
assertEq(t2.extendedAttributes['Text1'], '102_ГОСТИНИЦА_800', 't2.Text1')
assertEq(t2.notes, '102_ГОСТИНИЦА_800', 't2.notes')

const t3 = parsed.tasks.find(t => t.uid === 3)!
assertEq(t3.predecessors.length, 1, 't3.predecessors count')
assertEq(t3.predecessors[0].predecessorUid, 2, 't3.pred.uid')
assertEq(t3.predecessors[0].type, 'FS', 't3.pred.type')
assertEq(t3.predecessors[0].lagDays, 0, 't3.pred.lagDays=0')

const t4 = parsed.tasks.find(t => t.uid === 4)!
assertEq(t4.isMilestone, true, 't4.isMilestone')
assertEq(t4.parentUid, null, 't4.parentUid (top-level)')
// LagFormat=5 (days), LinkLag=96000 → 96000/(10*60*8) = 20 рабочих дней
assertEq(t4.predecessors[0].lagDays, 20, 't4.pred.lagDays=20')
assertEq(t4.predecessors[0].lagType, 'working', 't4.pred.lagType')

// ─── Сериализация ──────────────────────────────────────────────────────
console.log('\n=== СЕРИАЛИЗАЦИЯ ===')
const serialized = serializeMspdi(
  parsed.tasks.map(t => ({
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
  })),
  {
    projectName: parsed.name,
    projectTitle: parsed.title,
    startDate: parsed.startDate,
    finishDate: parsed.finishDate,
    extendedAttributes: [{ fieldName: 'Text1', alias: 'Объект ЗПР' }],
  },
)

assertTrue(serialized.includes('<?xml'), 'XML declaration')
assertTrue(serialized.includes('<Project xmlns="http://schemas.microsoft.com/project">'), 'Project root')
assertTrue(serialized.includes('<Name>ZPR_Test</Name>'), 'Name')
assertTrue(serialized.includes('<UID>2</UID>'), 'UID 2')
assertTrue(serialized.includes('<PercentComplete>50</PercentComplete>'), 'PercentComplete 50')
assertTrue(serialized.includes('<PredecessorLink>'), 'PredecessorLink present')
assertTrue(serialized.includes('102_ГОСТИНИЦА_800'), 'cyrillic Text1 value')

// ─── Round-trip парсинг ────────────────────────────────────────────────
console.log('\n=== ROUND-TRIP ===')
const reparsed = parseMspdi(serialized)
assertEq(reparsed.tasks.length, 4, 'reparsed tasks count')
assertEq(reparsed.tasks.find(t => t.uid === 2)?.percentComplete, 50, 'reparsed t2.percentComplete')
assertEq(reparsed.tasks.find(t => t.uid === 4)?.predecessors[0].lagDays, 20, 'reparsed t4.pred.lagDays')

console.log('\n🎉 Все проверки пройдены')
