-- ============================================================
-- ZPR — v_masterplan_objects_full: добавляем pmt_oks_candidates
-- ============================================================
-- При импорте PDF ТЭП через pdfplumber русский текст name_ppt не парсится
-- (custom font encoding) — заглушка = code. Но в pmt_oks (стейджинг ПМТ Тома 3.2)
-- кириллица нормальная. Подмешиваем сюда подсказки для дозаполнения вручную:
-- по каждой связанной с masterplan_object зоне берём pmt_oks.object_name.
--
-- Подсказки видны в UI карточки на вкладке «Основное» с кнопкой «Использовать»,
-- которая копирует значение в name_ppt / name_contract.
-- ============================================================

drop view if exists v_masterplan_objects_full;
create view v_masterplan_objects_full as
with current_metrics as (
    select
        masterplan_object_id,
        jsonb_object_agg(metric_code, jsonb_build_object(
          'value_num', value_num,
          'value_text', value_text,
          'unit', unit,
          'source', source,
          'valid_from', valid_from
        )) as metrics
    from masterplan_object_metrics
    where valid_to is null
    group by masterplan_object_id
),
linked_objects as (
    select moo.masterplan_object_id, array_agg(o.code order by o.code) as object_codes
    from masterplan_object_objects moo
    join objects o on o.id = moo.object_id
    group by moo.masterplan_object_id
),
linked_plots as (
    select mp.masterplan_object_id, array_agg(p.code order by p.code) as plot_codes
    from masterplan_object_plots mp
    join plots p on p.id = mp.plot_id
    group by mp.masterplan_object_id
),
linked_zones as (
    select mfo.masterplan_object_id, array_agg(fo.zone_code order by fo.zone_code) as zone_codes
    from masterplan_object_functional_objects mfo
    join functional_objects fo on fo.id = mfo.functional_object_id
    group by mfo.masterplan_object_id
),
pmt_hints as (
    -- Для каждого мастерплан-объекта берём все pmt_oks записи из его привязанных зон.
    -- Может быть N кандидатов (если в зоне несколько ОКС: отель+ресторан+СПА).
    select mfo.masterplan_object_id,
           jsonb_agg(jsonb_build_object(
             'zone_code',    po.zone_code,
             'object_name',  po.object_name,
             'queue',        po.queue,
             'etazh_max',    po.etazh_max,
             'status_code',  po.status_code,
             'value_code',   po.value_code
           ) order by po.zone_code, po.object_name) as candidates
    from masterplan_object_functional_objects mfo
    join functional_objects fo on fo.id = mfo.functional_object_id
    join pmt_oks po on po.zone_code = fo.zone_code
    group by mfo.masterplan_object_id
)
select
    m.id, m.code, m.name_ppt, m.name_contract, m.queue,
    coalesce(lo.object_codes, array[]::text[]) as object_codes,
    coalesce(lp.plot_codes, array[]::text[]) as plot_codes,
    coalesce(lz.zone_codes, array[]::text[]) as zone_codes,
    coalesce(cm.metrics, '{}'::jsonb) as metrics,
    coalesce(ph.candidates, '[]'::jsonb) as pmt_oks_candidates,
    m.active, m.source_document_id, m.created_at, m.updated_at
from masterplan_objects m
left join current_metrics cm on cm.masterplan_object_id = m.id
left join linked_objects lo on lo.masterplan_object_id = m.id
left join linked_plots lp on lp.masterplan_object_id = m.id
left join linked_zones lz on lz.masterplan_object_id = m.id
left join pmt_hints ph on ph.masterplan_object_id = m.id
where m.active = true;

comment on view v_masterplan_objects_full is
  'Паспорт мастерплан-объекта: связи + актуальные метрики (jsonb) + pmt_oks_candidates (подсказки кириллических наименований из ПМТ Тома 3.2 для дозаполнения name_ppt/name_contract).';
