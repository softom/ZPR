-- ============================================================
-- ZPR — Триггер «один документ» + views для сравнения двух версий ТЭП
-- ============================================================
-- Поправка триггера: закрываем старую версию только в рамках одного и
-- того же source_document_id. Это нужно чтобы метрика от ДВУХ разных
-- документов (ПМТ Том 3.2 и PDF ТЭП) сосуществовала как две активные
-- версии — для сравнения значений.
--
-- Views:
--   v_masterplan_metrics_compare    — long-формат для side-by-side
--   v_pmt_oks_unmatched             — недостающие объекты ПМТ
--   v_masterplan_objects_coverage   — какие источники есть у объекта
--
-- См. WIKI 33_Сущность_Объект_Мастерплана.md
-- ============================================================

create or replace function masterplan_object_metrics_close_old() returns trigger
language plpgsql as $$
begin
    if new.valid_to is null then
        update masterplan_object_metrics
           set valid_to = new.valid_from,
               updated_at = now()
         where masterplan_object_id = new.masterplan_object_id
           and metric_code = new.metric_code
           and source = new.source
           and source_document_id is not distinct from new.source_document_id
           and id <> new.id
           and valid_to is null
           and valid_from < new.valid_from;
    end if;
    return new;
end$$;

drop view if exists v_masterplan_metrics_compare;
create view v_masterplan_metrics_compare as
select mo.id as masterplan_object_id, mo.code as object_code,
       mo.name_ppt as object_name_ppt, mo.queue,
       mom.metric_code, mc.label as metric_label, mc.category as metric_category,
       mom.source, mom.source_document_id,
       d.title as document_title, d.version as document_version,
       mom.value_num, mom.value_text,
       coalesce(mom.unit, mc.default_unit) as unit, mom.valid_from
from masterplan_objects mo
join masterplan_object_metrics mom on mom.masterplan_object_id = mo.id and mom.valid_to is null
join masterplan_metric_codes mc on mc.code = mom.metric_code
left join documents d on d.id = mom.source_document_id
where mo.active = true;

drop view if exists v_pmt_oks_unmatched;
create view v_pmt_oks_unmatched as
select po.id as pmt_oks_id, po.zone_code, po.object_name, po.queue,
       po.etazh_max, po.status_code, po.value_code, po.page,
       po.source_id as pmt_source_id
from pmt_oks po
where not exists (select 1 from masterplan_objects mo where mo.source_pmt_oks_id = po.id)
order by po.zone_code, po.object_name;

drop view if exists v_masterplan_objects_coverage;
create view v_masterplan_objects_coverage as
select mo.id as masterplan_object_id, mo.code as object_code, mo.queue,
       count(distinct mom.source_document_id) as documents_count,
       array_agg(distinct d.title order by d.title) filter (where d.title is not null) as document_titles,
       array_agg(distinct mom.source order by mom.source) as sources,
       count(distinct mom.metric_code) as metrics_count,
       bool_or(d.title ilike '%ТЭП%') as has_tep_pdf,
       bool_or(d.title ilike '%ПМТ%' or d.title ilike '%ППТ%') as has_pmt_doc
from masterplan_objects mo
left join masterplan_object_metrics mom on mom.masterplan_object_id = mo.id and mom.valid_to is null
left join documents d on d.id = mom.source_document_id
where mo.active = true
group by mo.id, mo.code, mo.queue;