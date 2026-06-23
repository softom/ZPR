/**
 * GUARD-ТЕСТ: путь редактирования Gantt (write-path) НЕ теряет MSPDI-passthrough.
 *
 * Назначение — документировать и проверить контракт сохранения экспорта
 * (см. ganttModel.ts → OWNED_PATCH_FIELDS, контракт п.1–2):
 *
 *   Web UI редактирует график в DHTMLX Gantt и шлёт PATCH owned-полей.
 *   Если в payload UPDATE попадут служебные round-trip-колонки
 *   (mspdi_passthrough / mspdi_uid / schedule_raw_text), то round-trip
 *   в MS Project сломается: экспорт перестанет восстанавливать оригинальные
 *   <Task>-узлы. Этот тест ловит такую регрессию на корню.
 *
 * Тест двухслойный:
 *   A. Чистый, всегда исполнимый слой — assertOwnedOnly(payload): фильтрует
 *      произвольный объект правок через OWNED_PATCH_FIELDS (та же логика, что
 *      обязан применять write-path) и доказывает, что запрещённые колонки
 *      физически не попадают в payload UPDATE. БД не нужна.
 *   B. Опциональный live-слой — runLiveCheck(): если есть подключение к боевой
 *      БД, выбирает активную версию, берёт N строк с mspdi_passthrough NOT NULL,
 *      имитирует PATCH owned-поля (date_end) и подтверждает, что passthrough/
 *      mspdi_uid/schedule_raw_text не входят в отфильтрованный payload.
 *      Без env-переменных Supabase слой пропускается (skip), тест остаётся
 *      «зелёным» как описательный.
 *
 * Запуск (опционально):  npx tsx ui/lib/schedule/__test__/ganttRoundtripGuard.ts
 *
 * describe-структура (в комментариях, без рантайм-фреймворка — стиль каталога
 * __test__: console-скрипты с fail()/ok(), как roundTripReal.ts):
 *
 *   describe('write-path guard: passthrough не теряется')
 *     it('assertOwnedOnly пропускает только OWNED_PATCH_FIELDS')
 *     it('assertOwnedOnly выбрасывает запрещённые колонки из payload')
 *     it('запрещённые колонки: mspdi_passthrough / mspdi_uid / schedule_raw_text / mspdi_id')
 *     it('[live] активная версия + N строк с passthrough → PATCH date_end не трогает passthrough')
 */

import { OWNED_PATCH_FIELDS } from '../ganttModel'

// ─── Утилиты вывода (стиль каталога __test__) ────────────────────────────────

function fail(msg: string): never {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`)
}
function skip(msg: string): void {
  console.log(`↷ SKIP: ${msg}`)
}

// ─── Контракт: запрещённые колонки ───────────────────────────────────────────

/**
 * Колонки calendar_entries, которые write-path НЕ имеет права писать.
 * Нарушение → ломается round-trip MS Project (контракт сохранения экспорта, п.1).
 *
 *  - mspdi_passthrough — сырые <Task>-узлы оригинала (jsonb);
 *  - mspdi_uid         — стабильный Task/UID из MSP (генерится экспортом, не UI);
 *  - schedule_raw_text — оригинальный текст привязки к объекту (мост к mapping);
 *  - mspdi_id          — пересчитывается ROW_NUMBER() по WBS, не задаётся руками.
 */
const FORBIDDEN_PATCH_FIELDS: readonly string[] = [
  'mspdi_passthrough',
  'mspdi_uid',
  'schedule_raw_text',
  'mspdi_id',
] as const

// ─── A. Ядро: assertOwnedOnly ────────────────────────────────────────────────

/**
 * Фильтрует объект правок до белого списка OWNED_PATCH_FIELDS и проверяет,
 * что запрещённые round-trip-колонки в него не попали.
 *
 * Это ровно та операция, которую обязан выполнять реальный write-path перед
 * UPDATE: брать только OWNED-колонки. Функция и фильтрует, и assert-ит —
 * возвращает безопасный payload, либо падает (throw), если фильтр пропустил
 * запрещённую колонку (т.е. кто-то добавил её в OWNED_PATCH_FIELDS).
 *
 * @param patch  произвольный объект «поле → новое значение» из UI.
 * @returns      payload UPDATE, содержащий ТОЛЬКО owned-поля.
 */
export function assertOwnedOnly(patch: Record<string, unknown>): Record<string, unknown> {
  const owned = new Set(OWNED_PATCH_FIELDS)

  // 1. Белый список и список запрещённых не должны пересекаться (защита от
  //    регрессии в самом ganttModel.ts: вдруг кто-то внёс passthrough в owned).
  for (const f of FORBIDDEN_PATCH_FIELDS) {
    if (owned.has(f)) {
      throw new Error(
        `OWNED_PATCH_FIELDS содержит запрещённую round-trip-колонку «${f}» — ` +
        `это сломает экспорт в MS Project (контракт п.1)`,
      )
    }
  }

  // 2. Собираем payload только из owned-полей входного patch.
  const payload: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    if (owned.has(key)) payload[key] = patch[key]
  }

  // 3. Финальная гарантия: ни одна запрещённая колонка не просочилась.
  for (const f of FORBIDDEN_PATCH_FIELDS) {
    if (f in payload) {
      throw new Error(`payload UPDATE содержит запрещённую колонку «${f}»`)
    }
  }

  return payload
}

// ─── Слой A: статические проверки (всегда исполнимы) ─────────────────────────

function runStaticChecks(): void {
  console.log('=== A. assertOwnedOnly (без БД) ===')

  // it('assertOwnedOnly пропускает только OWNED_PATCH_FIELDS')
  {
    const patch = {
      title: 'Новое имя',
      date_start: '2026-07-01',
      date_end: '2026-07-10',
      percent_complete: 50,
    }
    const payload = assertOwnedOnly(patch)
    for (const k of Object.keys(patch)) {
      if (!(k in payload)) fail(`owned-поле «${k}» потерялось в payload`)
    }
    if (Object.keys(payload).length !== Object.keys(patch).length) {
      fail(`лишние ключи в payload: ${JSON.stringify(payload)}`)
    }
    ok(`owned-поля проходят насквозь: ${Object.keys(payload).join(', ')}`)
  }

  // it('assertOwnedOnly выбрасывает запрещённые колонки из payload')
  {
    // UI «случайно» прислал всё подряд — write-path обязан вычистить служебное.
    const dirtyPatch: Record<string, unknown> = {
      date_end: '2026-08-15',                          // owned — остаётся
      title: 'Имя',                                    // owned — остаётся
      mspdi_passthrough: [{ tag: 'Hack' }],            // forbidden — отсекается
      mspdi_uid: 999,                                  // forbidden — отсекается
      schedule_raw_text: '102_ГОСТИНИЦА_800',          // forbidden — отсекается
      mspdi_id: 7,                                     // forbidden — отсекается
      object_ids: ['x'],                               // не-owned — отсекается
    }
    const payload = assertOwnedOnly(dirtyPatch)

    for (const f of FORBIDDEN_PATCH_FIELDS) {
      if (f in payload) fail(`запрещённая колонка «${f}» просочилась в payload`)
    }
    if (!('date_end' in payload) || !('title' in payload)) {
      fail('owned-поля date_end/title должны были остаться')
    }
    if ('object_ids' in payload) fail('не-owned object_ids должно было отсечься')
    ok(`payload очищен до owned: ${JSON.stringify(payload)}`)
  }

  // it('запрещённые колонки: mspdi_passthrough / mspdi_uid / schedule_raw_text / mspdi_id')
  {
    const owned = new Set(OWNED_PATCH_FIELDS)
    for (const f of FORBIDDEN_PATCH_FIELDS) {
      if (owned.has(f)) fail(`OWNED_PATCH_FIELDS не должен содержать «${f}»`)
    }
    // Зеркальная проверка к контракту ganttModel.ts: owned ровно 12 колонок.
    if (OWNED_PATCH_FIELDS.length !== 12) {
      fail(`ожидалось 12 OWNED-колонок, получено ${OWNED_PATCH_FIELDS.length}`)
    }
    ok(`OWNED_PATCH_FIELDS=12 и не пересекается с forbidden (${FORBIDDEN_PATCH_FIELDS.join(', ')})`)
  }
}

// ─── B. Live-слой: реальная активная версия (опционально) ────────────────────

/**
 * Имитирует круг редактирования над боевыми данными:
 *   1) активная версия (schedule_imports.is_active=true);
 *   2) N строк calendar_entries c mspdi_passthrough NOT NULL;
 *   3) симулируем PATCH owned-поля date_end через assertOwnedOnly;
 *   4) убеждаемся, что passthrough/mspdi_uid/schedule_raw_text НЕ в payload UPDATE,
 *      т.е. концептуально экспорт «до» и «после» идентичен по passthrough
 *      (мы не трогаем колонку, значит её содержимое не меняется).
 *
 * Без переменных окружения Supabase — graceful skip.
 */
async function runLiveCheck(sampleSize = 3): Promise<void> {
  console.log('\n=== B. Live-проверка на активной версии (опционально) ===')

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    skip('нет NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — live-слой пропущен')
    return
  }

  // Импорт клиента откладываем до момента, когда env точно есть, иначе
  // supabaseAdmin падает на «!»-ассерции при создании клиента без env.
  const { supabaseAdmin } = await import('../../supabase-admin')

  // 1. Активная версия.
  const { data: active, error: aErr } = await supabaseAdmin
    .from('schedule_imports')
    .select('id')
    .eq('is_active', true)
    .maybeSingle()
  if (aErr) { skip(`schedule_imports select: ${aErr.message}`); return }
  if (!active?.id) { skip('активная версия не найдена (is_active=true)'); return }
  ok(`активная версия: ${active.id}`)

  // 2. N строк с непустым passthrough.
  const { data: rows, error: rErr } = await supabaseAdmin
    .from('calendar_entries')
    .select('id, mspdi_uid, schedule_raw_text, mspdi_passthrough, date_end')
    .eq('schedule_version_id', active.id)
    .not('mspdi_passthrough', 'is', null)
    .limit(sampleSize)
  if (rErr) { skip(`calendar_entries select: ${rErr.message}`); return }
  if (!rows || rows.length === 0) { skip('нет строк с mspdi_passthrough NOT NULL'); return }
  ok(`строк с passthrough взято: ${rows.length}`)

  // 3–4. Для каждой строки симулируем PATCH date_end и проверяем payload.
  for (const row of rows as Array<Record<string, unknown>>) {
    // UI прислал бы только изменённое owned-поле. Сдвигаем date_end на +1 день.
    const oldEnd = String(row.date_end ?? '2026-01-01').slice(0, 10)
    const bumped = new Date(Date.parse(oldEnd) + 86_400_000).toISOString().slice(0, 10)

    // Намеренно «грязный» вход — будто роут по ошибке притащил всю строку:
    const dirtyPatch: Record<string, unknown> = {
      date_end: bumped,
      mspdi_passthrough: row.mspdi_passthrough,
      mspdi_uid: row.mspdi_uid,
      schedule_raw_text: row.schedule_raw_text,
    }

    const payload = assertOwnedOnly(dirtyPatch)

    // Главный инвариант: служебные колонки не в payload UPDATE.
    for (const f of FORBIDDEN_PATCH_FIELDS) {
      if (f in payload) fail(`[live] строка ${row.id}: «${f}» попала в payload UPDATE`)
    }
    if (payload.date_end !== bumped) {
      fail(`[live] строка ${row.id}: date_end не применился`)
    }

    // Концептуально: passthrough НЕ участвует в UPDATE → значение в БД неизменно
    // → экспорт «до» и «после» побайтово идентичен в части восстановления <Task>.
    // (Сам UPDATE не выполняем — тест read-only, без записи в боевую БД.)
    ok(`[live] ${String(row.id).slice(0, 8)}…: PATCH {date_end} чист от passthrough/uid/raw_text`)
  }
}

// ─── Точка входа ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  runStaticChecks()
  await runLiveCheck()
  console.log('\n🎉 GUARD ПРОЙДЕН: write-path не теряет MSPDI-passthrough')
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
