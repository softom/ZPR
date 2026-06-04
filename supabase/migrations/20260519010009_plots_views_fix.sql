-- ============================================================
-- ZPR — фикс views для plots (Ф1 миграция 6b)
-- ============================================================
-- Предыдущая миграция 20260519010008 не довела views до применения из-за
-- ошибки: ST_Multi(...) FILTER невалидно — ST_Multi не агрегат. Перемещаем
-- FILTER внутрь ST_Collect (агрегат) и оборачиваем ST_Multi снаружи.
-- ============================================================

drop view if exists v_object_current_plots    cascade;
drop view if exists v_functional_objects_full cascade;
drop view if exists v_plots_history           cascade;
drop view if exists v_plots_current           cascade;

-- ============================================================
-- v_plots_current
-- ============================================================
create view v_plots_current as
with current_assignment as (
    select distinct on (plot_id)
        plot_id,
        boundary_type      as current_boundary_type,
        version_in_type    as current_version,
        valid_from         as current_valid_from,
        source_document_id as current_source_document_id
      from plot_polygon_assignments
     where valid_to is null
     order by plot_id, valid_from desc, boundary_type desc
)
select
    p.id                          as plot_id,
    p.object_id,
    p.functional_object_id,
    p.code,
    p.name,
    p.role,
    p.parent_plot_id,
    p.permitted_use,
    p.category,
    p.area_declared_m2,
    p.cadastral_number,
    p.source_pmt_zu,
    fo.zone_code                  as functional_zone_code,
    fo.queue                      as functional_queue,
    fo.kind                       as functional_kind,
    fo.name                       as functional_name,
    coalesce(p.object_id, fo.object_id) as effective_object_id,
    ca.current_boundary_type,
    ca.current_version,
    ca.current_valid_from,
    ca.current_source_document_id,
    -- ST_Multi(ST_Collect(... filter ...)) — filter ВНУТРИ агрегата
    extensions.ST_Multi(
        extensions.ST_Collect(pp.geom_4326 order by ppa.sequence_no)
            filter (where ppa.valid_to is null)
    ) as geom_4326_multi,
    extensions.ST_Multi(
        extensions.ST_Collect(pp.geom order by ppa.sequence_no)
            filter (where ppa.valid_to is null)
    ) as geom_sk63_multi,
    sum(pp.area_calc_m2) filter (where ppa.valid_to is null)           as area_calc_m2,
    count(pp.id) filter (where ppa.valid_to is null)                   as polygon_count
from plots p
left join functional_objects fo on fo.id = p.functional_object_id
left join current_assignment ca on ca.plot_id = p.id
left join plot_polygon_assignments ppa on ppa.plot_id = p.id
left join plot_polygons pp on pp.id = ppa.polygon_id
where p.active = true
group by p.id, fo.zone_code, fo.queue, fo.kind, fo.name, fo.object_id,
         ca.current_boundary_type, ca.current_version, ca.current_valid_from, ca.current_source_document_id;

comment on view v_plots_current is
  'Актуальные участки с multi-part геометрией и функциональным контекстом. Используется UI ЗПР, ArcGIS, RPC.';

-- ============================================================
-- v_plots_history
-- ============================================================
create view v_plots_history as
select
    p.id as plot_id, p.code, p.name,
    ppa.boundary_type, ppa.version_in_type,
    ppa.source_document_id, d.title as document_title, d.version as document_version,
    ppa.valid_from, ppa.valid_to,
    ppa.ring_role, ppa.sequence_no,
    pp.id as polygon_id,
    pp.area_calc_m2, pp.point_count,
    ppa.note
from plots p
join plot_polygon_assignments ppa on ppa.plot_id = p.id
join plot_polygons pp on pp.id = ppa.polygon_id
left join documents d on d.id = ppa.source_document_id
order by p.code, ppa.boundary_type, ppa.valid_from desc;

comment on view v_plots_history is
  'Таймлайн всех версий границ участков. Для UI «История границ ЗУ».';

-- ============================================================
-- v_functional_objects_full
-- ============================================================
create view v_functional_objects_full as
select
    fo.id                       as functional_object_id,
    fo.zone_code,
    fo.queue,
    fo.kind,
    fo.name                     as functional_name,
    fo.object_id,
    o.code                      as object_code,
    o.current_name              as object_name,
    fo.source_pmt_object_name,
    count(p.id)                 as plot_count,
    array_agg(p.code order by p.code) filter (where p.id is not null) as plot_codes,
    sum(p.area_declared_m2)     as total_area_declared_m2,
    fo.source_document_id,
    fo.active
from functional_objects fo
left join objects o on o.id = fo.object_id
left join plots p on p.functional_object_id = fo.id and p.active = true
where fo.active = true
group by fo.id, o.code, o.current_name;

comment on view v_functional_objects_full is
  'Функциональные объекты ППТ + сводка по plots + бизнес-объект ЗПР (если маппинг есть).';

-- ============================================================
-- v_object_current_plots
-- ============================================================
create view v_object_current_plots as
select
    o.id as object_id, o.code as object_code, o.current_name as object_name,
    vpc.plot_id, vpc.code as plot_code, vpc.name as plot_name,
    vpc.functional_zone_code, vpc.functional_kind, vpc.functional_name,
    vpc.current_boundary_type, vpc.current_version, vpc.current_valid_from,
    vpc.area_declared_m2, vpc.area_calc_m2, vpc.polygon_count,
    vpc.geom_4326_multi
from objects o
left join v_plots_current vpc on vpc.effective_object_id = o.id
where o.active = true;

comment on view v_object_current_plots is
  'Все участки одного бизнес-объекта ЗПР (как через прямой plots.object_id, так и через functional_objects.object_id).';
