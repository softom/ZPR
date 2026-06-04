/**
 * Парсер файлов транскрипций собрания. Серверный модуль (использует fs).
 *
 * Поддерживает:
 * - .docx → mammoth → plain text (+ распознавание подписи спикеров если есть)
 * - .csv  → Speaker, Start, Text → форматированный диалог `[time] Speaker: text`
 * - .txt  → распознаём подпись спикеров вида «Спикер A: текст» / «Speaker 1: текст»
 *           (формат, который выдают сторонние системы диаризации). Если подпись
 *           не распознана — возвращаем как есть.
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
      const raw = result.value || ''
      const tagged = parseTaggedTranscript(raw)
      return tagged ? formatTagged(tagged, opts.speakerMap) : raw
    }
    case '.csv': {
      const buf = await readFile(absPath, 'utf-8')
      return parseCsv(stripBom(buf), opts.speakerMap)
    }
    case '.txt': {
      const buf = await readFile(absPath, 'utf-8')
      const raw = stripBom(buf)
      const tagged = parseTaggedTranscript(raw)
      return tagged ? formatTagged(tagged, opts.speakerMap) : raw
    }
    default:
      throw new Error(`Неподдерживаемый формат транскрипции: ${ext}`)
  }
}

/**
 * Возвращает уникальных спикеров транскрипции с подсчётом реплик
 * и образцами цитат (для UI секции маппинга).
 *
 * Поддерживает:
 * - .csv (колонки Speaker / Text)
 * - .txt и .docx с tagged-разметкой «Спикер A: текст» / «Speaker 1: текст»
 */
export async function extractSpeakers(
  absPath: string,
): Promise<Array<{ raw: string; count: number; samples: string[] }>> {
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.csv') {
    return extractFromCsv(absPath)
  }
  if (ext === '.txt' || ext === '.docx') {
    let content: string
    if (ext === '.txt') {
      const buf = await readFile(absPath, 'utf-8')
      content = stripBom(buf)
    } else {
      const result = await mammoth.extractRawText({ path: absPath })
      content = result.value || ''
    }
    const tagged = parseTaggedTranscript(content)
    if (!tagged) return []
    return aggregateSpeakers(tagged)
  }
  return []
}

async function extractFromCsv(
  absPath: string,
): Promise<Array<{ raw: string; count: number; samples: string[] }>> {
  const buf = await readFile(absPath, 'utf-8')
  const rows = splitCsvRows(stripBom(buf))
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const speakerIdx = findCol(header, ['speaker', 'говорящий', 'спикер'])
  const textIdx = findCol(header, ['text', 'текст'])
  if (speakerIdx < 0 || textIdx < 0) return []

  const items: Array<{ raw: string; text: string }> = []
  for (let i = 1; i < rows.length; i++) {
    const raw = (rows[i][speakerIdx] ?? '').trim()
    if (!raw) continue
    const text = (rows[i][textIdx] ?? '').trim()
    if (!text) continue
    items.push({ raw, text })
  }
  return aggregateSpeakers(items)
}

function aggregateSpeakers(
  items: Array<{ raw: string; text: string }>,
): Array<{ raw: string; count: number; samples: string[] }> {
  const SAMPLE_LIMIT = 20
  const stats = new Map<string, { count: number; samples: string[] }>()
  for (const it of items) {
    const cur = stats.get(it.raw) ?? { count: 0, samples: [] }
    cur.count += 1
    if (cur.samples.length < SAMPLE_LIMIT && it.text.length > 5) {
      cur.samples.push(it.text.length > 200 ? it.text.slice(0, 200) + '…' : it.text)
    }
    stats.set(it.raw, cur)
  }
  return [...stats.entries()]
    .map(([raw, v]) => ({ raw, ...v }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Парсит plain-text-транскрипцию с tagged-разметкой спикеров.
 * Поддерживаемые форматы:
 *
 * 1. Inline (label + текст на одной строке через двоеточие):
 *      "Спикер A: текст"
 *      "Спикер A: <p>текст</p><p>ещё</p>"
 *      "Speaker 1: текст"
 *      "[Speaker 1]: текст"
 *
 * 2. Block (label на отдельной строке, реплика — на следующих, до новой подписи):
 *      Спикер 9
 *      Путь 55. Ну, да.
 *      Спикер 11
 *      Математика, шахматы. Это про молодость.
 *      Спикер 9
 *      Как в анекдоте.
 *    Этот формат отдают некоторые внешние системы диаризации (одна строка = label,
 *    следующая(ие) = реплика). Парсер собирает реплику до встречи следующей подписи.
 *
 * Возвращает null если разметка не распознана (нужно >= 2 спикеров и >= 3 реплик).
 */
export function parseTaggedTranscript(
  content: string,
): Array<{ raw: string; text: string }> | null {
  // Регэксп ловит обе формы:
  //   • inline:  «Спикер A: текст»  →  group(3) = «текст»
  //   • block:   «Спикер A»          →  group(3) = undefined (текст придёт в след. строках)
  // ID допускается алфанум + опц. дефис/подчёркивание (`Speaker A`, `Спикер 11`, `Speaker AB-2`).
  // После ID допускаются: опц. `]`, опц. точка, опц. `:` с текстом.
  const re = /^\[?\s*(Спикер|Speaker|Говорящий)\s+([A-ZА-ЯЁ0-9]+(?:[_\-][A-ZА-ЯЁ0-9]+)?)\s*\]?\s*(?::\s*(.+))?\s*\.?\s*$/i

  const lines = content.split(/\r?\n/)
  const items: Array<{ raw: string; text: string }> = []
  const speakers = new Set<string>()
  let lastIdx = -1

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(re)
    if (m) {
      // Новая реплика. Может прийти с inline-текстом (group 3) или без —
      // тогда текст соберётся из следующих строк-продолжений.
      const raw = `${capitalize(m[1])} ${m[2]}`
      const inlineText = m[3] ? stripParaTags(m[3]).trim() : ''
      items.push({ raw, text: inlineText })
      lastIdx = items.length - 1
      speakers.add(raw)
    } else if (lastIdx >= 0) {
      // Продолжение текущей реплики — либо block-формат (текст реплики),
      // либо перенос строки внутри одного inline-turn'а.
      const text = stripParaTags(trimmed).trim()
      if (text) {
        items[lastIdx].text = items[lastIdx].text
          ? items[lastIdx].text + ' ' + text
          : text
      }
    } else {
      // Строка до первой подписи спикера — формат не распознан
      return null
    }
  }

  // Отфильтровываем «пустые» реплики (label без текста — например, последняя
  // подпись в block-формате без следующих строк).
  const filtered = items.filter((it) => it.text.length > 0)
  const realSpeakers = new Set(filtered.map((it) => it.raw))

  // Минимальный порог уверенности: >= 2 разных спикеров и >= 3 непустых turn-а
  if (realSpeakers.size < 2 || filtered.length < 3) return null
  return filtered
}

function stripParaTags(s: string): string {
  return s
    .replace(/<\/?p[^>]*>/gi, ' ')
    .replace(/<\/?br[^>]*>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function formatTagged(
  items: Array<{ raw: string; text: string }>,
  map?: SpeakerMap,
): string {
  return items.map((it) => `${formatSpeaker(it.raw, map)}: ${it.text}`).join('\n')
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
