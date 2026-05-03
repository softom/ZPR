/**
 * Находит файл договора в хранилище для дальнейшей обработки на сервере.
 * Используется при повторном анализе (`/reparse`) и других операциях,
 * требующих исходного PDF.
 *
 * STORAGE_DIR + documents.folder_path → ищем .pdf-файлы.
 * Если несколько — приоритет: имена с «Договор» / «contract» в названии.
 * Иначе — первый по алфавиту.
 */

import { readdir, stat } from 'fs/promises'
import path from 'path'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export async function findContractFile(folderPath: string): Promise<string | null> {
  if (!folderPath) return null
  const folderRel = folderPath.replace(/[\\/]/g, path.sep)
  const targetDir = path.join(STORAGE_DIR, folderRel)

  try {
    const s = await stat(targetDir)
    if (!s.isDirectory()) return null
  } catch {
    return null
  }

  let files: string[]
  try {
    files = await readdir(targetDir)
  } catch {
    return null
  }

  const pdfs = files.filter(f => f.toLowerCase().endsWith('.pdf')).sort()
  if (pdfs.length === 0) return null

  // Приоритет: основной договор (имя содержит «Договор» или «contract»)
  const main = pdfs.find(f => /договор|contract/i.test(f)) ?? pdfs[0]
  return path.join(targetDir, main)
}
