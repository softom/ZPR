/**
 * Парсер файлов транскрипций собрания. Серверный модуль (использует fs).
 *
 * Поддерживает:
 * - .docx → mammoth → plain text
 * - .csv  → Speaker, Start, Text → форматированный диалог `[time] Speaker: text`
 * - .txt  → как есть
 *
 * При наличии speaker_map применяется substitution: Speaker N → реальное имя+орг.
 */

import { readFile } from 'fs/promises'
import path from 'path'
import mammoth from 'mammoth'

export type SpeakerMap = Record<string, { label?: string; org?: string }>

export interface ParseOptions {
  speakerMap?: SpeakerMap
}

export async function parseTranscriptFile(
  absPath: string,
  opts: ParseOptions = {},
): Promise<string> {
  const ext = path.extname(absPath).toLowerCase()
  switch (ext) {
    case '.docx': {
      const result = await mammoth.extractRawText({ path: absPath })
      return result.value || ''
    }
    case '.csv': {
      const buf = await readFile(absPath, 'utf-8')
      return parseCsv(stripBom(buf), opts.speakerMap)
    }
    case '.txt': {
      const buf = await readFile(absPath, 'utf-8')
      return stripBom(buf)
    }
    default:
      throw new Error(`Неподдерживаемый формат транскрипции: ${ext}`)
  }
}

/**
 * Возвращает уникальных спикеров CSV-транскрипции с подсчётом реплик
 * и образцами цитат (для UI секции маппинга).
 */
export async function extractSpeakers(
  absPath: string,
): Promise<Array<{ raw: string; count: number; samples: string[] }>> {
  const ext = path.extname(absPath).toLowerCase()
  if (ext !== '.csv') {
    // Для DOCX/TXT маппинг неприменим (диалог уже подписан) — отдаём пусто.
    return []
  }
  const buf = await readFile(absPath, 'utf-8')
  const rows = splitCsvRows(stripBom(buf))
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const speakerIdx = findCol(header, ['speaker', 'говорящий', 'спикер'])
  const textIdx = findCol(header, ['text', 'текст'])
  if (speakerIdx < 0 || textIdx < 0) return []

  const SAMPLE_LIMIT = 20  // больше образцов на случай если первых нескольких не хватит
  const stats = new Map<string, { count: number; samples: string[] }>()
  for (let i = 1; i < rows.length; i++) {
    const raw = (rows[i][speakerIdx] ?? '').trim()
    if (!raw) continue
    const text = (rows[i][textIdx] ?? '').trim()
    if (!text) continue
    const cur = stats.get(raw) ?? { count: 0, samples: [] }
    cur.count += 1
    if (cur.samples.length < SAMPLE_LIMIT && text.length > 5) {
      cur.samples.push(text.length > 200 ? text.slice(0, 200) + '…' : text)
    }
    stats.set(raw, cur)
  }
  return [...stats.entries()]
    .map(([raw, v]) => ({ raw, ...v }))
    .sort((a, b) => b.count - a.count)
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/**
 * Простейший CSV-парсер с поддержкой кавычек. Ожидает колонки:
 * Speaker / Говорящий, Start / Время, Text / Текст.
 *
 * При наличии speakerMap имя спикера заменяется на mapped label+org:
 *   "Speaker 1" → "Антипов А.Ю. (ТЗ-ЮГ)"
 */
function parseCsv(text: string, speakerMap?: SpeakerMap): string {
  const rows = splitCsvRows(text)
  if (rows.length === 0) return text

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const speakerIdx = findCol(header, ['speaker', 'говорящий', 'спикер'])
  const startIdx   = findCol(header, ['start', 'время', 'time'])
  const textIdx    = findCol(header, ['text', 'текст'])

  if (speakerIdx < 0 || textIdx < 0) {
    return text  // не наш формат — отдаём как есть
  }

  const out: string[] = []
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]
    const rawSpeaker = (cells[speakerIdx] ?? '').trim() || '?'
    const start = startIdx >= 0 ? (cells[startIdx] ?? '').trim() : ''
    const txt   = (cells[textIdx] ?? '').trim()
    if (!txt) continue
    const speaker = formatSpeaker(rawSpeaker, speakerMap)
    out.push(start ? `[${start}] ${speaker}: ${txt}` : `${speaker}: ${txt}`)
  }
  return out.join('\n')
}

function formatSpeaker(raw: string, map?: SpeakerMap): string {
  if (!map) return raw
  const m = map[raw]
  if (!m) return raw
  if (m.label && m.org) return `${m.label} (${m.org})`
  return m.label || m.org || raw
}

function findCol(header: string[], aliases: string[]): number {
  for (let i = 0; i < header.length; i++) {
    if (aliases.some((a) => header[i].includes(a))) return i
  }
  return -1
}

/** Разбивает CSV-текст на строки (учитывая многострочные значения в кавычках). */
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === ',') {
      row.push(cell)
      cell = ''
      continue
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      // \r\n → один раз
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      // Пропускаем пустые строки
      if (row.length > 1 || (row[0] ?? '').trim()) {
        rows.push(row)
      }
      row = []
      continue
    }
    cell += ch
  }
  // Хвост
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
