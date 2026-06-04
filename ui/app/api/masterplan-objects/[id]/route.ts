import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// GET — полный паспорт + актуальные метрики (через v_masterplan_objects_full)
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { data, error } = await supabaseAdmin
    .from('v_masterplan_objects_full')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json({ masterplan_object: data })
}

// PATCH — правка name_ppt / name_contract / queue / note + намерения по связям:
//   { add_object_id: uuid }      — связать с бизнес-объектом
//   { remove_object_id: uuid }   — отвязать
//   { add_plot_id: uuid }        — добавить участок
//   { remove_plot_id: uuid }     — убрать участок
//   { add_functional_object_id: uuid }
//   { remove_functional_object_id: uuid }
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: Record<string, unknown> = {}
  try {
    const raw = await req.text()
    if (raw.trim().length > 0) body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 })
  }

  // Проверим что объект существует
  const { data: mo, error: moErr } = await supabaseAdmin
    .from('masterplan_objects').select('id').eq('id', id).single()
  if (moErr || !mo) return NextResponse.json({ error: 'Объект мастерплана не найден' }, { status: 404 })

  // Поля паспорта
  const fields: Record<string, string | null> = {}
  for (const k of ['name_ppt', 'name_contract', 'queue', 'note'] as const) {
    if (k in body) {
      const v = body[k]
      fields[k] = v === null ? null : typeof v === 'string' ? v : String(v)
    }
  }
  if (Object.keys(fields).length > 0) {
    fields.updated_at = new Date().toISOString()
    const { error } = await supabaseAdmin.from('masterplan_objects').update(fields).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Связи — namespace pattern: add_X / remove_X
  const linkActions: Array<[string, string, 'add' | 'remove', string]> = [
    ['add_object_id',              'masterplan_object_objects',              'add',    'object_id'],
    ['remove_object_id',           'masterplan_object_objects',              'remove', 'object_id'],
    ['add_plot_id',                'masterplan_object_plots',                'add',    'plot_id'],
    ['remove_plot_id',             'masterplan_object_plots',                'remove', 'plot_id'],
    ['add_functional_object_id',   'masterplan_object_functional_objects',   'add',    'functional_object_id'],
    ['remove_functional_object_id','masterplan_object_functional_objects',   'remove', 'functional_object_id'],
  ]
  for (const [key, table, op, col] of linkActions) {
    if (!(key in body)) continue
    const v = body[key]
    if (typeof v !== 'string' || v.length === 0) {
      return NextResponse.json({ error: `${key} должен быть uuid` }, { status: 400 })
    }
    if (op === 'add') {
      const { error } = await supabaseAdmin
        .from(table)
        .upsert({ masterplan_object_id: id, [col]: v }, { onConflict: `masterplan_object_id,${col}` })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await supabaseAdmin
        .from(table).delete().eq('masterplan_object_id', id).eq(col, v)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  // Вернём свежее состояние
  const { data } = await supabaseAdmin
    .from('v_masterplan_objects_full').select('*').eq('id', id).single()
  return NextResponse.json({ masterplan_object: data, changed: true })
}