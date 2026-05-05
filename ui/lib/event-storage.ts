/**
 * Хелпер для путей к файлам событий в STORAGE_DIR.
 *
 * Структура: STORAGE_DIR/СОБЫТИЯ/{YYYY}/{MM}/{event_id}/{file_name}
 * Файл в БД (event_attachments.file_path) хранится в UNIX-стиле относительно STORAGE_DIR.
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'

export const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

/**
 * Путь к директории события: STORAGE_DIR/СОБЫТИЯ/{YYYY}/{MM}/{event_id}/
 *
 * @param eventId UUID события
 * @param refDate ISO-дата (YYYY-MM-DD) — для группировки по году/месяцу.
 *                Используем events.fact_date или events.date_end.
 */
export function eventStorageDir(eventId: string, refDate: string): string {
  const yyyy = refDate.slice(0, 4)
  const mm = refDate.slice(5, 7)
  return path.join(STORAGE_DIR, 'СОБЫТИЯ', yyyy, mm, eventId)
}

/**
 * Относительный путь от STORAGE_DIR (для записи в БД).
 * Возвращает в UNIX-стиле (слэши `/`), независимо от ОС.
 */
export function eventRelPath(eventId: string, refDate: string, fileName: string): string {
  const yyyy = refDate.slice(0, 4)
  const mm = refDate.slice(5, 7)
  return ['СОБЫТИЯ', yyyy, mm, eventId, fileName].join('/')
}

/** Абсолютный путь файла из относительного. */
export function eventAbsPath(relPath: string): string {
  return path.join(STORAGE_DIR, relPath.replace(/\//g, path.sep))
}

/** Создаёт директорию рекурсивно, если не существует. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/** Безопасное имя файла: убираем path-traversal и спецсимволы. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '_')
    .trim()
    .slice(0, 200)
    || 'unnamed'
}

/** Определение kind по mime / расширению. */
export function detectKind(mime: string | null, fileName: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (mime?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (mime?.startsWith('video/') || ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return 'video'
  if (mime?.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
  if (['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'rtf', 'md'].includes(ext)) return 'document'
  return 'other'
}
