import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

// PATCH /api/plots/[id]
//
// Body — два режима:
//
// 1) Прямые поля (низкоуровневый режим):
//      { object_id: uuid | null }              — override бизнес-объекта на уровне участка
//      { functional_object_id: uuid | null }   — перепривязать к другой функ.зоне
//
// 2) Высокоуровневые намерения (для UI):
//      { unbind_from_object: uuid }            — отвязать участок от данного бизнес-объекта
//      { bind_to_object:    uuid }             — привязать участок к данному бизнес-объекту
//
// Эффективная привязка участка к бизнес-объектам — это массив:
//   * если задан `plots.object_id` → [plots.object_id] (override на уровне участка)
//   * иначе все объекты зоны через junction `functional_object_objects` (M:N)
// (см. v_plots_current.effective_object_ids, миграция 20260519010030)
//
// `unbind_from_object` смотрит на актуальное состояние и решает что снимать:
//   - если `plots.object_id` уже указывает на этот объект (прямая привязка / override)
//     → сбрасываем `object_id = NULL`. Участок вернётся к наследованию через зону.
//   - иначе, если есть `functional_object_id` и зона связана с этим объектом через
//     junction → удаляем связь (functional_object_id, target) из junction.
//     Зона остаётся привязанной к остальным объектам (если они были).
//   - если ни то, ни другое — 200 OK без изменений (`changed: false`).
//
// `bind_to_object` устанавливает `plots.object_id = <objectId>` (override). При
// наличии `functional_object_id` он сохраняется, но участок «перебивает» зональную
// привязку.
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

  const update: Record<string, string | null> = {}

  // ── Прямые поля ───────────────────────────────────────────────────────────
  if ('object_id' in body) {
    const v = body.object_id
    if (v === null) {
      update.object_id = null
    } else if (typeof v === 'string' && v.length > 0) {
      const { data: obj, error: objErr } = await supabaseAdmin
        .from('objects')
        .select('id, active')
        .eq('id', v)
        .single()
      if (objErr || !obj) {
        return NextResponse.json({ error: 'Объект с таким id не найден' }, { status: 404 })
      }
      if (!obj.active) {
        return NextResponse.json({ error: 'Объект деактивирован — привязка запрещена' }, { status: 409 })
      }
      update.object_id = v
    } else {
      return NextResponse.json({ error: 'object_id должен быть uuid или null' }, { status: 400 })
    }
  }

  if ('functional_object_id' in body) {
    const v = body.functional_object_id
    if (v === null) {
      update.functional_object_id = null
    } else if (typeof v === 'string' && v.length > 0) {
      const { data: fo, error: foErr } = await supabaseAdmin
        .from('functional_objects')
        .select('id, active')
        .eq('id', v)
        .single()
      if (foErr || !fo) {
        return NextResponse.json({ error: 'Функциональная зона не найдена' }, { status: 404 })
      }
      if (!fo.active) {
        return NextResponse.json({ error: 'Функциональная зона деактивирована' }, { status: 409 })
      }
      update.functional_object_id = v
    } else {
      return NextResponse.json({ error: 'functional_object_id должен быть uuid или null' }, { status: 400 })
    }
  }

  // ── Высокоуровневые намерения ─────────────────────────────────────────────
  if ('unbind_from_object' in body) {
    const target = body.unbind_from_object
    if (typeof target !== 'string' || target.length === 0) {
      return NextResponse.json({ error: 'unbind_from_object должен быть uuid' }, { status: 400 })
    }

    // Читаем текущее состояние участка
    const { data: plot, error: plotErr } = await supabaseAdmin
      .from('plots')
      .select('id, object_id, functional_object_id')
      .eq('id', id)
      .single<{
        id: string
        object_id: string | null
        functional_object_id: string | null
      }>()
    if (plotErr || !plot) {
      return NextResponse.json({ error: 'Участок не найден' }, { status: 404 })
    }

    if (plot.object_id === target) {
      // прямая привязка — снимаем override (вернётся к наследованию через зону)
      update.object_id = null
    } else if (plot.functional_object_id) {
      // Проверяем, есть ли связь (functional_object_id, target) в junction
      const { data: link } = await supabaseAdmin
        .from('functional_object_objects')
        .select('functional_object_id')
        .eq('functional_object_id', plot.functional_object_id)
        .eq('object_id', target)
        .maybeSingle()
      if (link) {
        // удаляем именно эту связь — зона остаётся для остальных объектов
        const { error: delErr } = await supabaseAdmin
          .from('functional_object_objects')
          .delete()
          .eq('functional_object_id', plot.functional_object_id)
          .eq('object_id', target)
        if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
        return NextResponse.json(
          {
            plot: {
              id: plot.id,
              object_id: plot.object_id,
              functional_object_id: plot.functional_object_id,
            },
            unlinked_zone_from_object: { functional_object_id: plot.functional_object_id, object_id: target },
            changed: true,
          },
          { status: 200 },
        )
      }
      // нет связи через зону — нечего отвязывать
      return NextResponse.json(
        {
          plot: { id: plot.id, object_id: plot.object_id, functional_object_id: plot.functional_object_id },
          changed: false,
        },
        { status: 200 },
      )
    } else {
      return NextResponse.json(
        {
          plot: { id: plot.id, object_id: plot.object_id, functional_object_id: plot.functional_object_id },
          changed: false,
        },
        { status: 200 },
      )
    }
  }

  if ('bind_to_object' in body) {
    const target = body.bind_to_object
    if (typeof target !== 'string' || target.length === 0) {
      return NextResponse.json({ error: 'bind_to_object должен быть uuid' }, { status: 400 })
    }
    // Проверяем что объект существует и активен
    const { data: obj, error: objErr } = await supabaseAdmin
      .from('objects')
      .select('id, active')
      .eq('id', target)
      .single()
    if (objErr || !obj) {
      return NextResponse.json({ error: 'Объект с таким id не найден' }, { status: 404 })
    }
    if (!obj.active) {
      return NextResponse.json({ error: 'Объект деактивирован — привязка запрещена' }, { status: 409 })
    }
    update.object_id = target
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      {
        error:
          'Нечего обновлять. Ожидается object_id / functional_object_id или unbind_from_object / bind_to_object',
      },
      { status: 400 },
    )
  }

  update.updated_at = new Date().toISOString()

  const { data, error } = await supabaseAdmin
    .from('plots')
    .update(update)
    .eq('id', id)
    .select('id, code, name, role, object_id, functional_object_id')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Участок не найден' }, { status: 404 })
  }

  return NextResponse.json({ plot: data, changed: true })
}
