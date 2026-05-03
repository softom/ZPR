/**
 * POST /api/contracts/v2/[id]/upload
 *
 * Загружает PDF/DOCX файл договора в локальное хранилище:
 *   STORAGE_DIR\\<documents.folder_path>\\<filename>
 *
 * Запускается после успешного /api/contracts/v2/save.
 * Требует, чтобы запись в `documents` уже существовала.
 */

import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  console.log(`[v2/upload] doc=${id} STORAGE_DIR=${STORAGE_DIR}`)

  const { data: doc, error: dErr } = await supabaseAdmin
    .from('documents')
    .select('folder_path')
    .eq('id', id)
    .single()

  if (dErr || !doc?.folder_path) {
    console.error(`[v2/upload] doc not found: ${dErr?.message}`)
    return NextResponse.json({ error: 'Документ не найден' }, { status: 404 })
  }

  const folderRel = doc.folder_path.replace(/[\\/]/g, path.sep)
  const targetDir = path.join(STORAGE_DIR, folderRel)

  try {
    await mkdir(targetDir, { recursive: true })
  } catch (e) {
    return NextResponse.json({ error: `mkdir: ${e}` }, { status: 500 })
  }

  const formData = await request.formData()
  const files = formData.getAll('files') as File[]

  if (!files.length) {
    return NextResponse.json({ error: 'Нет файлов для загрузки' }, { status: 400 })
  }

  const saved: string[] = []
  const errors: string[] = []

  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer()
      const dest = path.join(targetDir, file.name)
      await writeFile(dest, Buffer.from(bytes))
      saved.push(file.name)
      console.log(`[v2/upload] saved: ${dest}`)
    } catch (e) {
      errors.push(`${file.name}: ${e}`)
    }
  }

  return NextResponse.json({ ok: true, folder: targetDir, saved, errors })
}
