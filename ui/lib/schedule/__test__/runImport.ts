/**
 * Прямой вызов importMspdiXml без Next.js dev-сервера —
 * проверить, что после правок импорт чистый.
 */
import fs from 'fs'
import { importMspdiXml } from '../importMspdi'

async function main() {
  const xml = fs.readFileSync('D:/Dropbox/ЗПР/ГРАФИКИ/XML/Совмещенный график v014.xml', 'utf-8')
  const t0 = Date.now()
  const result = await importMspdiXml({
    xml,
    fileName: 'Совмещенный график v014.xml',
    fileSize: xml.length,
    objectField: 'Текст15',
    notes: 'CLI прогон после правок (Космос+Emerald замаплены)',
  })
  console.log(`time: ${Date.now() - t0} ms`)
  console.log(`importId: ${result.importId}`)
  console.log(`stats:`, JSON.stringify(result.stats, null, 2))
  console.log(`unmapped raw_texts: ${result.unknownRawTexts.length}`)
  for (const rt of result.unknownRawTexts) {
    const cnt = result.unmapped.filter(u => u.rawText === rt).length
    console.log(`  - ${rt}  (${cnt} tasks)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
