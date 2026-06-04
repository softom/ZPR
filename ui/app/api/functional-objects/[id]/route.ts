import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// PATCH /api/functional-objects/[id]
//
// Body — три режима (модель M:N через таблицу `functional_object_objects`):
//
// 1) { add_object_id: uuid }     — добавить связь зоны с этим объектом
// 2) { remove_object_id: uuid }  — удалить связь
// 3) { set_object_ids: uuid[] }  — полностью перезаписать список объектов зоны
//    (передача [] эквивалентна полной отвязке)
//
// Backward-compat:
//   { object_id: uuid }   = set_object_ids: [uuid]   (одна связь — но не очищает остальные)
//                          → точнее: add_object_id (миграция к M:N)
//   { object_id: null }   = set_object_ids: []       (полная отвязка)
//
// Все участки зоны (plots.functional_object_id = <this>) унаследуют привязку
// через v_plots_current.effective_object_ids — uuid[] (M:N).
// См. WIKI 29_Сущность_Участок.md и миграцию 20260519010030.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  let body: Record<string, unknown> = {}
  try {
    const raw = await request.text()
    if (raw.trim().length > 0) body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  // Проверим что зона существует
  const { data: zone, error: zoneErr } = await supabaseAdmin
    .from('functional_objects')
    .select('id, zone_code, name, kind, queue, active')
    .eq('id', id)
    .single()
  if (zoneErr || !zone) {
    return NextResponse.json({ error: 'Функциональная зона не найдена' }, { status: 404 })
  }

  // ── Хелпер: проверить что объект существует и активен ──────────────────────
  async function ensureObjectActive(objectId: string): Promise<string | null> {
    const { data: obj, error: objErr } = await supabaseAdmin
      .from('objects')
      .select('id, active')
      .eq('id', objectId)
      .single()
    if (objErr || !obj) return 'Объект с таким id не найден'
    if (!obj.active)   return 'Объект деактивирован — привязка запрещена'
    return null
  }

  // ── Режим 1: add_object_id ────────────────────────────────────────────────
  if ('add_object_id' in body) {
    const v = body.add_object_id
    if (typeof v !== 'string' || v.length === 0) {
      return NextResponse.json({ error: 'add_object_id должен быть uuid' }, { status: 400 })
    }
    const err = await ensureObjectActive(v)
    if (err) return NextResponse.json({ error: err }, { status: err.includes('деактивирован') ? 409 : 404 })
    const { error: insErr } = await supabaseAdmin
      .from('functional_object_objects')
      .upsert({ functional_object_id: id, object_id: v }, { onConflict: 'functional_object_id,object_id' })
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    return NextResponse.json({ functional_object: await fetchWithObjects(id), changed: true })
  }

  // ── Режим 2: remove_object_id ─────────────────────────────────────────────
  if ('remove_object_id' in body) {
    const v = body.remove_object_id
    if (typeof v !== 'string' || v.length === 0) {
      return NextResponse.json({ error: 'remove_object_id должен быть uuid' }, { status: 400 })
    }
    const { error: delErr } = await supabaseAdmin
      .from('functional_object_objects')
      .delete()
      .eq('functional_object_id', id)
      .eq('object_id', v)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
    return NextResponse.json({ functional_object: await fetchWithObjects(id), changed: true })
  }

  // ── Режим 3: set_object_ids ───────────────────────────────────────────────
  if ('set_object_ids' in body) {
    const arr = body.set_object_ids
    if (!Array.isArray(arr) || arr.some(x => typeof x !== 'string')) {
      return NextResponse.json({ error: 'set_object_ids должен быть массивом uuid' }, { status: 400 })
    }
    // Все ids проверим
    for (const oid of arr as string[]) {
      const err = await ensureObjectActive(oid)
      if (err) return NextResponse.json({ error: err }, { status: err.includes('деактивирован') ? 409 : 404 })
    }
    // Транзакционно: удалить все текущие, вставить новые
    const { error: delErr } = await supabaseAdmin
      .from('functional_object_objects')
      .delete()
      .eq('functional_object_id', id)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
    if (arr.length > 0) {
      const rows = (arr as string[]).map(oid => ({ functional_object_id: id, object_id: oid }))
      const { error: insErr } = await supabaseAdmin.from('functional_object_objects').insert(rows)
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
    return NextResponse.json({ functional_object: await fetchWithObjects(id), changed: true })
  }

  // ── Backward-compat: object_id (одно значение или null) ───────────────────
  if ('object_id' in body) {
    const raw = body.object_id
    if (raw === null) {
      // Полная отвязка (как раньше)
      const { error: delErr } = await supabaseAdmin
        .from('functional_object_objects')
        .delete()
        .eq('functional_object_id', id)
      if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
      return NextResponse.json({ functional_object: await fetchWithObjects(id), changed: true })
    }
    if (typeof raw === 'string' && raw.length > 0) {
      // ВНИМАНИЕ: чтобы не сломать существующий UI, который посылает object_id для
      // «привязать» — это поведение мигрировано в add_object_id (дополнительно к
      // существующим связям, а не перезаписывая их).
      const err = await ensureObjectActive(raw)
      if (err) return NextResponse.json({ error: err }, { status: err.includes('деактивирован') ? 409 : 404 })
      const { error: insErr } = await supabaseAdmin
        .from('functional_object_objects')
        .upsert({ functional_object_id: id, object_id: raw }, { onConflict: 'functional_object_id,object_id' })
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
      return NextResponse.json({ functional_object: await fetchWithObjects(id), changed: true })
    }
    return NextResponse.json({ error: 'object_id должен быть uuid или null' }, { status: 400 })
  }

  return NextResponse.json(
    {
      error: 'Ожидается одно из полей: add_object_id, remove_object_id, set_object_ids, object_id',
    },
    { status: 400 },
  )
}

// Возвращает зону с массивом её связанных объектов (после изменения).
async function fetchWithObjects(zoneId: string) {
  const { data } = await supabaseAdmin
    .from('functional_objects')
    .select('id, zone_code, name, kind, queue')
    .eq('id', zoneId)
    .single()
  const { data: links } = await supabaseAdmin
    .from('functional_object_objects')
    .select('object_id')
    .eq('functional_object_id', zoneId)
  return { ...(data ?? {}), object_ids: (links ?? []).map(l => l.object_id) }
}
