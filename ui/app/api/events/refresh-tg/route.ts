// POST /api/events/refresh-tg — ручной триггер классификации TG-сообщений из UI.
// Запускает tg_classifier.py --apply --layer rule --json-summary на сервере.
// Возвращает JSON-summary со счётчиками для кнопки «Считать из TG».

import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'node:child_process'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 минут — classifier + LLM могут идти долго

// Пути на сервере (RU Beget, /opt/zpr/)
const PYTHON_BIN = process.env.CLASSIFIER_PYTHON ?? '/opt/zpr/venv/bin/python'
const CLASSIFIER_SCRIPT = process.env.CLASSIFIER_SCRIPT ?? '/opt/zpr/code/tg_classifier.py'
const CLASSIFIER_CWD = process.env.CLASSIFIER_CWD ?? '/opt/zpr/code'

export async function POST(req: NextRequest) {
  let days = 3
  let layer: 'rule' | 'all' = 'rule'  // rule = быстро (~5 сек), all = с LLM (~минуты)
  try {
    const body = await req.json()
    if (typeof body?.days === 'number' && body.days >= 1 && body.days <= 30) {
      days = body.days
    }
    if (body?.layer === 'all') {
      layer = 'all'
    }
  } catch {
    // тело может отсутствовать — ok
  }

  const t0 = Date.now()

  return new Promise<NextResponse>((resolve) => {
    const args = [
      CLASSIFIER_SCRIPT,
      '--apply',
      '--days', String(days),
      '--layer', layer,
      '--json-summary',
    ]

    const ps = spawn(PYTHON_BIN, args, {
      cwd: CLASSIFIER_CWD,
      timeout: 4 * 60 * 1000,  // 4 минуты
    })

    let stdout = ''
    let stderr = ''

    ps.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8') })
    ps.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8') })

    ps.on('error', (err) => {
      resolve(NextResponse.json(
        { success: false, error: `Не удалось запустить классификатор: ${err.message}` },
        { status: 500 }
      ))
    })

    ps.on('close', (code) => {
      const duration = Math.round((Date.now() - t0) / 1000)

      // Ищем JSON-строку с маркером __JSON__
      const jsonLine = stdout.split(/\r?\n/).find(l => l.startsWith('__JSON__'))
      if (jsonLine) {
        try {
          const data = JSON.parse(jsonLine.slice('__JSON__'.length))
          resolve(NextResponse.json({
            success: data.success ?? true,
            backfill_new: 0,                          // backfill теперь на US-сервере, всегда 0
            classifier_new: data.classifier_new ?? 0,
            classifier_merged: data.classifier_merged ?? 0,
            duration_seconds: data.duration_seconds ?? duration,
            messages_scanned: data.messages_scanned ?? 0,
            error: null,
          }))
          return
        } catch (e) {
          // JSON parse failed — fall through
        }
      }

      // Fallback: парсим текстовый вывод регуляркой
      const insertMatch = stdout.match(/Записано в БД:\s*(\d+)\s*новых.*?(\d+)\s*слито/)
      const noMsgsMatch = stdout.match(/Нет новых сообщений/)
      const noCandsMatch = stdout.match(/Нет кандидатов/)

      if (noMsgsMatch || noCandsMatch) {
        resolve(NextResponse.json({
          success: true,
          backfill_new: 0,
          classifier_new: 0,
          classifier_merged: 0,
          duration_seconds: duration,
          error: null,
        }))
      } else if (insertMatch) {
        resolve(NextResponse.json({
          success: true,
          backfill_new: 0,
          classifier_new: parseInt(insertMatch[1], 10),
          classifier_merged: parseInt(insertMatch[2], 10),
          duration_seconds: duration,
          error: null,
        }))
      } else {
        // Не удалось распарсить
        const log = stdout.split(/\r?\n/).filter(Boolean).slice(-20)
        const errLog = stderr.split(/\r?\n/).filter(Boolean).slice(-10)
        resolve(NextResponse.json({
          success: false,
          backfill_new: 0,
          classifier_new: 0,
          classifier_merged: 0,
          duration_seconds: duration,
          error: code !== 0
            ? `Классификатор завершился с кодом ${code}`
            : 'Не удалось распарсить ответ классификатора',
          log: [...log, ...errLog].slice(-20),
        }, { status: 500 }))
      }
    })
  })
}
