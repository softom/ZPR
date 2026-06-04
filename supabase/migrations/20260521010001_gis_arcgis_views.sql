-- ============================================================
-- ZPR — ArcGIS-friendly views на актуальную M:N модель
-- ============================================================
-- ArcGIS Pro не понимает uuid[]/text[] из v_plots_current.effective_object_ids.
-- Эти views отдают «развёрнутые» простые типы: geometry + skalar columns +
-- string_agg для списка объектов (CSV).
--
-- Подключение из ArcGIS:
--   Database Connection → PostgreSQL, host=127.0.0.1, port=54322,
--   user=arcgis_writer, db=postgres → схема public → gis_*
-- См. MD WIKI/CLAUDE/30_GIS.md
-- ============================================================

-- ── 1. gis_plots — атомарные участки с геометрией и CSV-объектов ─────────────
drop view if exists gis_plots cascade;
create view gis_plots as
with current_assignment as (
    select distinct on (plot_id)
           plot_id, boundary_type, version_in_type, valid_from
      from plot_polygon_assignments
     where valid_to is null
     order by plot_id, valid_from desc, boundary_type desc
),
plot_geom as (
    select p.id as plot_id,
           extensions.ST_Multi(
               extensions.ST_Collect(pp.geom_4326 order by ppa.sequence_no)
           ) as geom_4326,
           extensions.ST_Multi(
               extensions.ST_Collect(pp.geom order by ppa.sequence_no)
           ) as geom_sk63,
           sum(pp.area_calc_m2) as area_m2,
           count(pp.id) as polygon_count
      from plots p
      join plot_polygon_assignments ppa on ppa.plot_id = p.id and ppa.valid_to is null
      join plot_polygons pp on pp.id = ppa.polygon_id
     where p.active = true
     group by p.id
),
plot_objs as (
    -- Эффективные объекты участка: либо plots.object_id (override), либо все
    -- объекты зоны через junction.
    select p.id as plot_id,
           string_agg(distinct o.code, ', ' order by o.code) as objects_csv,
           count(distinct o.id) as objects_count
      from plots p
      left join objects o
        on o.id = p.object_id
        or (p.object_id is null
            and o.id in (
              select foo.object_id from functional_object_objects foo
              where foo.functional_object_id = p.functional_object_id
            ))
     group by p.id
)
select
    row_number() over (order by p.code)::int as objectid,  -- для ArcGIS
    p.id,
    p.code,
    p.name,
    p.role::text                 as role,
    p.cadastral_number,
    p.permitted_use,
    fo.zone_code                 as functional_zone_code,
    fo.name                      as functional_name,
    fo.kind::text                as functional_kind,
    coalesce(po.objects_csv, '') as objects_csv,
    coalesce(po.objects_count, 0)::int as objects_count,
    ca.boundary_type::text       as current_boundary_type,
    ca.version_in_type           as current_version,
    pg.area_m2,
    pg.polygon_count::int        as polygon_count,
    pg.geom_4326,
    pg.geom_sk63
from plots p
left join functional_objects fo on fo.id = p.functional_object_id
left join current_assignment ca on ca.plot_id = p.id
join plot_geom pg on pg.plot_id = p.id
left join plot_objs po on po.plot_id = p.id
where p.active = true;

comment on view gis_plots is
  'ArcGIS-friendly: атомарные участки с multi-part геометрией (970634 + 4326) и CSV эффективных объектов ЗПР.';

-- ── 2. gis_functional_zones — зоны ППТ с агрегированной геометрией ───────────
drop view if exists gis_functional_zones cascade;
create view gis_functional_zones as
with zone_objs as (
    select foo.functional_object_id,
           string_agg(o.code, ', ' order by o.code) as objects_csv,
           count(o.id)::int as objects_count
      from functional_object_objects foo
      join objects o on o.id = foo.object_id
     group by foo.functional_object_id
),
zone_geom as (
    select fo.id as functional_object_id,
           extensions.ST_Multi(extensions.ST_Union(pp.geom_4326)) as geom_4326,
           extensions.ST_Multi(extensions.ST_Union(pp.geom))      as geom_sk63,
           sum(pp.area_calc_m2)                                    as area_m2,
           count(distinct p.id)::int                               as plots_count
      from functional_objects fo
      join plots p                      on p.functional_object_id = fo.id and p.active = true
      join plot_polygon_assignments ppa on ppa.plot_id = p.id and ppa.valid_to is null
      join plot_polygons pp             on pp.id = ppa.polygon_id
     where fo.active = true
     group by fo.id
),
zone_loads as (
    -- Сводка нагрузок по зоне для подписей на ArcGIS
    select functional_object_id,
           string_agg(
              network::text || ':' || total_load::text || coalesce(' '||units, ''),
              ' / ' order by network::text
           ) as loads_summary
    from v_engineering_loads_by_functional
    group by functional_object_id
)
select
    row_number() over (order by fo.zone_code)::int as objectid,
    fo.id,
    fo.zone_code,
    fo.name             as zone_name,
    fo.kind::text       as kind,
    fo.queue,
    coalesce(zo.objects_csv, '')   as objects_csv,
    coalesce(zo.objects_count, 0)::int as objects_count,
    coalesce(zl.loads_summary, '') as loads_summary,
    zg.area_m2,
    zg.plots_count,
    zg.geom_4326,
    zg.geom_sk63
from functional_objects fo
left join zone_objs zo on zo.functional_object_id = fo.id
left join zone_loads zl on zl.functional_object_id = fo.id
join zone_geom zg on zg.functional_object_id = fo.id
where fo.active = true;

comment on view gis_functional_zones is
  'ArcGIS-friendly: функциональные зоны ППТ с агрегированной геометрией (ST_Union участков). objects_csv — список бизнес-объектов в зоне (M:N), loads_summary — нагрузки в одной строке.';

-- ── 3. gis_objects — бизнес-объекты ЗПР через эффективную геометрию ──────────
-- Геометрия объекта = ST_Union геометрий всех участков с этим объектом в effective_object_ids.
-- (С учётом M:N: один и тот же участок может попасть в несколько объектов одной зоны.)
drop view if exists gis_objects cascade;
create view gis_objects as
with obj_plots as (
    select obj_id::uuid as object_id,
           v.plot_id,
           v.geom_4326_multi as geom_4326,
           v.geom_sk63_multi as geom_sk63,
           v.area_calc_m2
    from v_plots_current v,
         unnest(v.effective_object_ids) as obj_id
    where v.geom_4326_multi is not null
),
obj_geom as (
    select object_id,
           extensions.ST_Multi(extensions.ST_Union(geom_4326)) as geom_4326,
           extensions.ST_Multi(extensions.ST_Union(geom_sk63)) as geom_sk63,
           sum(area_calc_m2)::numeric as area_m2,
           count(distinct plot_id)::int as plots_count
    from obj_plots
    group by object_id
)
select
    row_number() over (order by o.code)::int as objectid,
    o.id,
    o.code,
    o.current_name      as name,
    o.contractor,
    o.color,
    coalesce(og.plots_count, 0)::int as plots_count,
    coalesce(og.area_m2, 0)::numeric as area_m2,
    og.geom_4326,
    og.geom_sk63
from objects o
left join obj_geom og on og.object_id = o.id
where o.active = true and og.geom_4326 is not null;

comment on view gis_objects is
  'ArcGIS-friendly: бизнес-объекты ЗПР с агрегированной геометрией (ST_Union эффективных участков через M:N с зонами).';

-- ── 4. Grant'ы для arcgis_writer ─────────────────────────────────────────────
grant select on gis_plots, gis_functional_zones, gis_objects to arcgis_writer;
