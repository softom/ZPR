/**
 * PATCH /api/schedule/entries/[id] — write-path (заготовка) правки одной строки
 * графика (calendar_entries) из DHTMLX Gantt.
 *
 * КОНТРАКТ СОХРАНЕНИЯ ЭКСПОРТА (нарушение ⇒ ломается round-trip MS Project):
 *  1. Пишем ТОЛЬКО OWNED-колонки (OWNED_PATCH_FIELDS из ganttModel.ts). Любые
 *     прочие ключи из body молча игнорируются — НИКОГДА не писать/обнулять
 *     mspdi_passthrough, mspdi_uid, schedule_raw_text, mspdi_id.
 *  2. Новым задачам mspdi_uid выдаёт экспорт (>=10_000_000) — в UI не трогаем.
 *  3. mspdi_id не задаётся руками: после структурных правок
 *     (parent_entry_id / outline_number) его пересчитывает отдельная RPC
 *     resequenceMspdiIds (ROW_NUMBER() по WBS) — здесь только вызов-заглушка.
 *
 * supabaseAdmin (service_role) серверно обходит RLS uploader — это ок для роута.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { pickOwnedFields } from '@/lib/schedule/ganttModel'

export const runtime = 'nodejs'

/** Ключи body, которые после UPDATE требуют пересчёта mspdi_id (структурные). */
const STRUCTURAL_FIELDS = ['parent_entry_id', 'outline_number'] as const

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  // Отфильтровываем body по белому списку OWNED-колонок (единый фильтр из
  // ganttModel.ts). Всё прочее (включая mspdi_passthrough / mspdi_uid /
  // schedule_raw_text / mspdi_id) молча отбрасывается.
  const patch = pickOwnedFields(body)

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Нет OWNED-полей для обновления' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('calendar_entries')
    .update(patch)
    .eq('id', id)
    .select('id, schedule_version_id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Не найдено' }, { status: 404 })

  // Структурные правки → mspdi_id надо пересчитать по WBS. Версию берём из строки.
  const structuralChanged = STRUCTURAL_FIELDS.some((k) => k in patch)
  let resequenced = false
  if (structuralChanged && data.schedule_version_id) {
    await resequenceMspdiIds(data.schedule_version_id as string)
    resequenced = true
  }

  return NextResponse.json({
    entry: { id: data.id },
    updated: Object.keys(patch),
    resequenced,
  })
}

/**
 * Заглушка пересчёта mspdi_id для версии графика.
 *
 * TODO: реализовать вызов RPC из соседней задачи. Серверная функция должна
 * пройти все calendar_entries версии и проставить
 *   mspdi_id = ROW_NUMBER() OVER (ORDER BY string_to_array(outline_number,'.')::int[])
 * (нумерация по WBS). Здесь — только сигнатура и no-op, чтобы write-path уже
 * вызывал её после структурных правок (parent_entry_id / outline_number).
 *
 * Пример будущей реализации:
 *   await supabaseAdmin.rpc('resequence_mspdi_ids', { p_version_id: versionId })
 */
export async function resequenceMspdiIds(versionId: string): Promise<void> {
  // TODO(resequence): вызвать RPC resequence_mspdi_ids(p_version_id => versionId).
  // Пока no-op, чтобы не трогать mspdi_id до готовности RPC.
  void versionId
}
