/**
 * Серверный модуль: генерация уникального meeting.code и его персистирование.
 *
 * Формат: `ПРОТ-{YYYY-MM-DD}-{contractor-short}[-N]`
 *   - `{contractor-short}` — самый короткий alias подрядчика собрания
 *     (≤ 8 символов) или его short_name; fallback на `{meeting.id[:8]}`.
 *   - `[-N]` — суффикс при коллизии (два собрания в один день у одного
 *     подрядчика). Первый получает базовый код, второй `-2`, третий `-3` и т.д.
 *
 * Контракт:
 *   - Если `meeting.code` уже выставлен и валиден — возвращается как есть,
 *     БД не трогается. Код — стабильный идентификатор, не меняется при
 *     изменении подрядчика/даты после первой фиксации.
 *   - Если `meeting.code = NULL` — вычисляется уникальный код, записывается
 *     в `meetings.code` (UPDATE) и возвращается.
 *
 * Защита от collision при параллельных INSERT — за счёт `UNIQUE meetings_code_key`
 * на стороне БД: если кто-то параллельно успел занять тот же code, UPDATE
 * упадёт, и мы повторяем с инкрементом N.
 *
 * Заменяет старый `deriveSourceProto()` в process/route.ts, который
 * рассчитывал префикс на лету каждый раз — поэтому два собрания в один
 * день у одного подрядчика получали одинаковый префикс.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

const PROTO_PATTERN = /^ПРОТ-\d{4}-\d{2}-\d{2}/

/**
 * Возвращает уникальный `meeting.code`. При первом вызове для собрания —
 * вычисляет и сохраняет в БД.
 */
export async function ensureMeetingCode(meetingId: string): Promise<string> {
  // 1. Читаем текущее состояние
  const { data: meeting, error } = await supabaseAdmin
    .from('meetings')
    .select('id, code, meeting_date')
    .eq('id', meetingId)
    .single()
  if (error || !meeting) {
    throw new Error(`ensureMeetingCode: meeting not found: ${error?.message ?? meetingId}`)
  }

  // 2. Стабильность: если уже задан и валиден — возвращаем как есть
  const existing = (meeting.code as string | null) ?? ''
  if (existing && PROTO_PATTERN.test(existing)) return existing

  // 3. Вычисляем base
  const base = await computeBase(meetingId, meeting.meeting_date as string)

  // 4. Подбираем уникальный suffix
  const code = await findUniqueCode(base, meetingId)

  // 5. Сохраняем в БД. Если UNIQUE упал (race condition) — повторяем подбор.
  const updateRes = await supabaseAdmin
    .from('meetings')
    .update({ code })
    .eq('id', meetingId)
  if (updateRes.error) {
    // Чаще всего — `duplicate key value violates unique constraint "meetings_code_key"`
    if (updateRes.error.code === '23505') {
      // Повторяем подбор (теперь видим только что INSERT'нутый conflict-code)
      const retryCode = await findUniqueCode(base, meetingId)
      const retry = await supabaseAdmin
        .from('meetings').update({ code: retryCode }).eq('id', meetingId)
      if (retry.error) {
        throw new Error(`ensureMeetingCode: повторная попытка не удалась: ${retry.error.message}`)
      }
      return retryCode
    }
    throw new Error(`ensureMeetingCode: ${updateRes.error.message}`)
  }
  return code
}

/**
 * Вычисляет «базовый» код без суффикса:
 *   ПРОТ-{date}-{contractor-short}   — если есть подрядчик
 *   ПРОТ-{date}-{meeting_id[:8]}      — fallback (нет contractor role)
 */
async function computeBase(meetingId: string, dateIso: string): Promise<string> {
  const { data: contractorRow } = await supabaseAdmin
    .from('meeting_legal_entities')
    .select('legal_entity:legal_entities(short_name, aliases, name)')
    .eq('meeting_id', meetingId)
    .eq('role', 'contractor')
    .order('seq', { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  type LERef = { short_name?: string | null; aliases?: unknown; name?: string }
  const le = (contractorRow as { legal_entity?: LERef | null } | null)?.legal_entity
  if (le) {
    const aliases = Array.isArray(le.aliases) ? (le.aliases as string[]) : []
    const shortName = (le.short_name ?? '').trim()
    // Самый короткий alias ≤ 8 символов (обычно бренд: МЛА, ХГ, Б82, СГТ)
    const shortFromAlias = aliases
      .filter((a) => typeof a === 'string' && a.length > 0 && a.length <= 8)
      .sort((a, b) => a.length - b.length)[0]
    const short = shortName || shortFromAlias
    if (short) return `ПРОТ-${dateIso}-${short}`
  }
  // Нет подрядчика — уникализируем через id-prefix
  return `ПРОТ-${dateIso}-${meetingId.slice(0, 8)}`
}

/**
 * Подбирает свободный код:
 *   base                 — если ещё не занят
 *   base-2, base-3, …    — иначе
 *
 * `excludeMeetingId` исключает текущий meeting (на случай если у него уже
 * был старый собственный код, который мы перезатираем).
 */
async function findUniqueCode(base: string, excludeMeetingId: string): Promise<string> {
  // Берём все коды, начинающиеся с base
  const { data: rows } = await supabaseAdmin
    .from('meetings')
    .select('id, code')
    .or(`code.eq.${base},code.like.${base}-%`)
  const occupied = new Set<string>(
    ((rows ?? []) as Array<{ id: string; code: string | null }>)
      .filter((r) => r.id !== excludeMeetingId && r.code)
      .map((r) => r.code as string),
  )

  if (!occupied.has(base)) return base
  // Перебираем суффиксы -2, -3, ... до 99 (с запасом)
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`
    if (!occupied.has(candidate)) return candidate
  }
  throw new Error(`ensureMeetingCode: не нашли свободный код для ${base} в первых 99 попытках`)
}
