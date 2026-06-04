-- ============================================================
-- ZPR — обогащение gis_* views расчётными нагрузками по сетям
-- ============================================================
-- Map 3D (AutoCAD) и ArcGIS Pro лучше работают с одним слоем, чем с Join'ами.
-- Добавляем в gis_plots / gis_functional_zones отдельные числовые колонки на
-- каждую инженерную сеть (water/sewer/storm/heat/gas/power) — для thematic
-- mapping (раскраска по нагрузке).
--
-- Нагрузка зоны ППТ присваивается каждому участку зоны (если zu_list не
-- разбит). Семантика: «суммарная расчётная нагрузка зоны» — деление по
-- участкам не делается, это бизнес-вопрос.
-- ============================================================

-- ── gis_plots: переопределяем с колонками load_* ─────────────────────────────
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
),
-- Нагрузки по зоне ППТ — pivot из v_engineering_loads_by_functional
loads_pivot as (
    select functional_object_id,
        max(total_load) filter (where network::text = 'water')   as load_water,
        max(total_load) filter (where network::text = 'sewer')   as load_sewer,
        max(total_load) filter (where network::text = 'storm')   as load_storm,
        max(total_load) filter (where network::text = 'heat')    as load_heat,
        max(total_load) filter (where network::text = 'gas')     as load_gas,
        max(total_load) filter (where network::text = 'power')   as load_power,
        max(total_load) filter (where network::text = 'telecom') as load_telecom,
        string_agg(network::text || ':' || total_load::text || coalesce(' '||units, ''),
                   ' / ' order by network::text) as loads_summary
    from v_engineering_loads_by_functional
    group by functional_object_id
),
-- Также прямые нагрузки на сам участок (engineering_loads.plot_id) — если есть
loads_pivot_plot as (
    select plot_id,
        sum(load_value) filter (where network::text = 'water')   as load_water_plot,
        sum(load_value) filter (where network::text = 'sewer')   as load_sewer_plot,
        sum(load_value) filter (where network::text = 'storm')   as load_storm_plot,
        sum(load_value) filter (where network::text = 'heat')    as load_heat_plot,
        sum(load_value) filter (where network::text = 'gas')     as load_gas_plot,
        sum(load_value) filter (where network::text = 'power')   as load_power_plot
    from engineering_loads
    where plot_id is not null
    group by plot_id
)
select
    row_number() over (order by p.code)::int as objectid,
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
    -- Нагрузки зоны (через functional_object_id)
    lp.load_water,
    lp.load_sewer,
    lp.load_storm,
    lp.load_heat,
    lp.load_gas,
    lp.load_power,
    lp.load_telecom,
    coalesce(lp.loads_summary, '') as loads_summary,
    -- Прямые нагрузки на участок (engineering_loads.plot_id)
    lpp.load_water_plot,
    lpp.load_sewer_plot,
    lpp.load_storm_plot,
    lpp.load_heat_plot,
    lpp.load_gas_plot,
    lpp.load_power_plot,
    pg.geom_4326,
    pg.geom_sk63
from plots p
left join functional_objects fo on fo.id = p.functional_object_id
left join current_assignment ca on ca.plot_id = p.id
join plot_geom pg on pg.plot_id = p.id
left join plot_objs po on po.plot_id = p.id
left join loads_pivot lp on lp.functional_object_id = p.functional_object_id
left join loads_pivot_plot lpp on lpp.plot_id = p.id
where p.active = true;

comment on view gis_plots is
  'ArcGIS/Map3D-friendly: атомарные участки + multi-part геометрия + CSV объектов + нагрузки зоны (load_water/...) + прямые нагрузки на участок (load_*_plot). loads_summary одной строкой для labelling.';

-- ── gis_functional_zones: добавляем те же load_* колонки ─────────────────────
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
    select functional_object_id,
        max(total_load) filter (where network::text = 'water')   as load_water,
        max(total_load) filter (where network::text = 'sewer')   as load_sewer,
        max(total_load) filter (where network::text = 'storm')   as load_storm,
        max(total_load) filter (where network::text = 'heat')    as load_heat,
        max(total_load) filter (where network::text = 'gas')     as load_gas,
        max(total_load) filter (where network::text = 'power')   as load_power,
        max(total_load) filter (where network::text = 'telecom') as load_telecom,
        string_agg(network::text || ':' || total_load::text || coalesce(' '||units, ''),
                   ' / ' order by network::text) as loads_summary
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
    zl.load_water,
    zl.load_sewer,
    zl.load_storm,
    zl.load_heat,
    zl.load_gas,
    zl.load_power,
    zl.load_telecom,
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
  'ArcGIS/Map3D-friendly: функциональные зоны ППТ + агрегированная геометрия + CSV объектов (M:N) + расчётные нагрузки по 7 сетям как отдельные числовые колонки для thematic mapping.';

grant select on gis_plots, gis_functional_zones to arcgis_writer;
