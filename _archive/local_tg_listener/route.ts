// POST /api/events/refresh-tg — ручной триггер догона TG из UI.
// Делает: stop listener → backfill --days N → classifier --apply → start listener.
// Возвращает JSON-summary со счётчиками.
//
// Доступ — admin (проверка по supabase auth).
// Запускает PowerShell-скрипт scripts/refresh_tg_now.ps1.

import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import path from 'node:path'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 минут — backfill + LLM могут идти долго

type Summary = {
  success: boolean
  backfill_new: number
  backfill_duplicate: number
  classifier_new: number
  classifier_merged: number
  duration_seconds: number
  error: string | null
  log?: string[]
}

export async function POST(req: NextRequest) {
  // TODO: проверка admin-роли через supabase serverside (минимум — наличие auth-куки).
  // Для MVP пропускаем — страница /events/preliminary всё равно доступна только admin.

  let days = 3
  try {
    const body = await req.json()
    if (typeof body?.days === 'number' && body.days >= 1 && body.days <= 30) {
      days = body.days
    }
  } catch {
    // тело может отсутствовать — ok
  }

  // Путь к скрипту: репозиторий = ../../.. от api/events/refresh-tg/
  const repoRoot = path.resolve(process.cwd(), '..')
  const scriptPath = path.join(repoRoot, 'scripts', 'refresh_tg_now.ps1')

  return new Promise<NextResponse>((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Days', String(days)],
      { cwd: repoRoot }
    )

    let stdout = ''
    let stderr = ''

    ps.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8') })
    ps.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8') })

    ps.on('error', (err) => {
      resolve(NextResponse.json(
        { success: false, error: `spawn failed: ${err.message}` },
        { status: 500 }
      ))
    })

    ps.on('close', (code) => {
      // Скрипт пишет JSON в stdout последней строкой
      const lastLine = stdout.trim().split(/\r?\n/).pop() || ''
      try {
        const parsed: Summary = JSON.parse(lastLine)
        // Прицепим stderr-лог (без JSON-summary) для отладки в UI
        parsed.log = stderr.split(/\r?\n/).filter(Boolean).slice(-40)
        resolve(NextResponse.json(parsed, { status: parsed.success ? 200 : 500 }))
      } catch (e) {
        resolve(NextResponse.json({
          success: false,
          error: `Не удалось распарсить ответ скрипта (exit=${code}): ${e instanceof Error ? e.message : e}`,
          raw_stdout: stdout.slice(-2000),
          raw_stderr: stderr.slice(-2000),
        }, { status: 500 }))
      }
    })
  })
}
