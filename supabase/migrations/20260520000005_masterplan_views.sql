-- ============================================================
-- ZPR — VIEWs для masterplan_objects
-- ============================================================
-- 1. v_masterplan_objects_full — паспорт + jsonb актуальных метрик
-- 2. v_masterplan_loads_by_queue — агрегаты «ИТОГО по очереди»
-- ============================================================

-- ── v_masterplan_objects_full ────────────────────────────────────────────────
create view v_masterplan_objects_full as
with current_metrics as (
    -- Все актуальные метрики, сгруппированные по объекту, в jsonb:
    --   { "water_demand": [{"source":"ppt", value_num:207.7, ...},
    --                       {"source":"calc", value_num:317.0, ...}], ... }
    select
        masterplan_object_id,
        jsonb_object_agg(metric_code, sources_arr) as metrics
    from (
        select
            masterplan_object_id,
            metric_code,
            jsonb_agg(
                jsonb_build_object(
                    'value_num',  value_num,
                    'value_text', value_text,
                    'unit',       unit,
                    'source',     source,
                    'valid_from', valid_from,
                    'source_document_id', source_document_id
                ) order by source
            ) as sources_arr
        from masterplan_object_metrics
        where valid_to is null
        group by masterplan_object_id, metric_code
    ) g
    group by masterplan_object_id
),
linked_objects as (
    select
        moo.masterplan_object_id,
        array_agg(o.id   order by o.code) as object_ids,
        array_agg(o.code order by o.code) as object_codes,
        array_agg(o.current_name order by o.code) as object_names
    from masterplan_object_objects moo
    join objects o on o.id = moo.object_id
    group by moo.masterplan_object_id
),
linked_plots as (
    select
        mp.masterplan_object_id,
        array_agg(p.id   order by p.code) as plot_ids,
        array_agg(p.code order by p.code) as plot_codes
    from masterplan_object_plots mp
    join plots p on p.id = mp.plot_id
    group by mp.masterplan_object_id
),
linked_zones as (
    select
        mfo.masterplan_object_id,
        array_agg(fo.id        order by fo.zone_code) as functional_object_ids,
        array_agg(fo.zone_code order by fo.zone_code) as zone_codes
    from masterplan_object_functional_objects mfo
    join functional_objects fo on fo.id = mfo.functional_object_id
    group by mfo.masterplan_object_id
)
select
    m.id,
    m.code,
    m.name_ppt,
    m.name_contract,
    m.queue,
    coalesce(lo.object_ids,            array[]::uuid[]) as object_ids,
    coalesce(lo.object_codes,          array[]::text[]) as object_codes,
    coalesce(lo.object_names,          array[]::text[]) as object_names,
    coalesce(lp.plot_ids,              array[]::uuid[]) as plot_ids,
    coalesce(lp.plot_codes,            array[]::text[]) as plot_codes,
    coalesce(lz.functional_object_ids, array[]::uuid[]) as functional_object_ids,
    coalesce(lz.zone_codes,            array[]::text[]) as zone_codes,
    coalesce(cm.metrics,               '{}'::jsonb)     as metrics,
    m.active,
    m.source_document_id,
    m.source_pmt_oks_id,
    m.note,
    m.created_at,
    m.updated_at
from masterplan_objects m
left join current_metrics  cm on cm.masterplan_object_id = m.id
left join linked_objects   lo on lo.masterplan_object_id = m.id
left join linked_plots     lp on lp.masterplan_object_id = m.id
left join linked_zones     lz on lz.masterplan_object_id = m.id
where m.active = true;

comment on view v_masterplan_objects_full is
  'Паспорт masterplan_object + актуальные метрики (jsonb по metric_code) + массивы связанных objects/plots/zones. Один запрос для UI карточки.';

-- ── v_masterplan_loads_by_queue — итоги по очередям ─────────────────────────
create view v_masterplan_loads_by_queue as
select
    m.queue,
    mom.metric_code,
    mc.label                          as metric_label,
    mc.category                       as metric_category,
    mom.source,
    coalesce(mom.unit, mc.default_unit) as unit,
    sum(mom.value_num)                as total_value,
    count(distinct m.id)              as object_count
from masterplan_objects m
join masterplan_object_metrics mom on mom.masterplan_object_id = m.id
join masterplan_metric_codes mc on mc.code = mom.metric_code
where m.active = true
  and mom.valid_to is null
  and mom.value_num is not null
group by m.queue, mom.metric_code, mc.label, mc.category, mom.source, coalesce(mom.unit, mc.default_unit);

comment on view v_masterplan_loads_by_queue is
  'Агрегаты ИТОГО по очереди × метрика × источник. Используется в UI для строк «ИТОГО ПЕРВАЯ ОЧЕРЕДЬ». Денормализация не хранится.';
