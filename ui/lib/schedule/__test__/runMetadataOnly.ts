/**
 * Тест: пользователь поправил несколько задач, затем запускаем metadata-only.
 * Проверяем что правки сохранились, а mspdi_duration пополнился.
 */
import fs from 'fs'
import { importMspdiXml } from '../importMspdi'
import { supabaseAdmin } from '../../supabase-admin'

async function main() {
  // 1. Берём 3 задачи, симулируем правки
  const { data: tasks } = await supabaseAdmin
    .from('calendar_entries')
    .select('id, mspdi_uid, title, title_original, date_start, date_end, percent_complete, object_ids, is_project_wide')
    .not('mspdi_uid', 'is', null)
    .order('mspdi_uid')
    .limit(3)

  if (!tasks || tasks.length < 3) { console.error('Не хватает задач'); process.exit(1) }

  console.log('=== ДО ===')
  for (const t of tasks) console.log(`  uid=${t.mspdi_uid} title="${t.title}" % =${t.percent_complete}`)

  // Симулируем правки
  const editedTasks = tasks.map(t => ({
    id: t.id,
    mspdi_uid: t.mspdi_uid,
    title_edit:        '✏ EDITED ' + (t.title ?? ''),
    percent_complete_edit: 77,
  }))

  for (const e of editedTasks) {
    await supabaseAdmin
      .from('calendar_entries')
      .update({ title: e.title_edit, percent_complete: e.percent_complete_edit })
      .eq('id', e.id)
  }

  // Также убедимся, что mspdi_duration НА ВСЕХ задачах есть после первой импорта
  const { data: durStat } = await supabaseAdmin
    .from('calendar_entries')
    .select('id', { count: 'exact', head: true })
    .not('mspdi_uid', 'is', null)
    .is('mspdi_duration', null)
  console.log(`\nЗадач с пустым mspdi_duration перед metadata-only: ${durStat ? '(rows)' : '?'}`)

  // Принудительно стираем mspdi_duration у одной задачи (чтобы проверить, что metadata-only его восстановит)
  const probeUid = editedTasks[0].mspdi_uid
  await supabaseAdmin.from('calendar_entries').update({ mspdi_duration: null }).eq('id', editedTasks[0].id)

  // 2. Запускаем import в режиме metadata-only
  console.log('\n=== metadata-only IMPORT ===')
  const xml = fs.readFileSync('D:/Dropbox/ЗПР/ГРАФИКИ/XML/Совмещенный график v014.xml', 'utf-8')
  const result = await importMspdiXml({
    xml,
    fileName: 'v014.xml (metadata-only test)',
    fileSize: xml.length,
    objectField: 'Текст15',
    mode: 'metadata-only',
  })
  console.log('  inserted:', result.stats.tasksInserted, 'updated:', result.stats.tasksUpdated)

  // 3. Проверяем — title и % остались, mspdi_duration восстановился
  const { data: after } = await supabaseAdmin
    .from('calendar_entries')
    .select('id, mspdi_uid, title, percent_complete, mspdi_duration')
    .in('id', editedTasks.map(e => e.id))
    .order('mspdi_uid')

  console.log('\n=== ПОСЛЕ metadata-only ===')
  for (const a of after ?? []) {
    const original = editedTasks.find(e => e.id === a.id)!
    const titleKept = a.title === original.title_edit
    const percentKept = a.percent_complete === original.percent_complete_edit
    const durationFilled = a.mspdi_duration !== null
    console.log(`  uid=${a.mspdi_uid}`)
    console.log(`    title:      "${a.title}"`)
    console.log(`    title_kept: ${titleKept ? '✓' : '✗ ПРОВАЛ'}`)
    console.log(`    %_kept:     ${percentKept ? '✓' : '✗ ПРОВАЛ'} (${a.percent_complete})`)
    console.log(`    duration:   ${a.mspdi_duration ?? 'NULL'} → ${durationFilled ? '✓' : '✗'}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
