/**
 * Прямой вызов exportMspdiXml без Next.js dev-сервера —
 * проверить, что обновлённый код пишет правильный FieldID.
 */
import fs from 'fs'
import { exportMspdiXml } from '../exportMspdi'

async function main() {
  const xml = await exportMspdiXml({})
  const out = 'D:/Dropbox/ЗПР/ГРАФИКИ/XML/_exported_direct.xml'
  fs.writeFileSync(out, xml, 'utf-8')
  console.log(`saved: ${out}`)
  console.log(`size: ${xml.length} chars`)
  // Quick checks
  console.log(`Total <Task>: ${xml.split('<Task>').length - 1}`)
  console.log(`PredecessorLink: ${xml.split('<PredecessorLink>').length - 1}`)
  console.log(`FieldID 188744001 lines: ${xml.split('<FieldID>188744001</FieldID>').length - 1}`)
  console.log(`FieldID 188743731 lines: ${xml.split('<FieldID>188743731</FieldID>').length - 1}`)
  // unique Value values for 188744001
  const re = /<FieldID>188744001<\/FieldID>\s*<Value>([^<]+)<\/Value>/g
  const vals = new Set<string>()
  let m
  while ((m = re.exec(xml))) vals.add(m[1])
  console.log(`Unique Текст15 values:`, vals.size)
  for (const v of vals) console.log(`  - ${v}`)
}

main().catch(e => { console.error(e); process.exit(1) })
