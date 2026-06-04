-- RPC `plots_geojson(p_role)` — собирает GeoJSON FeatureCollection из ЦЕЛЕВОЙ модели
-- (v_plots_current) с обогащением: бизнес-объект ЗПР, функциональный объект ППТ, ОКС-атрибуты.
--
-- Отличие от pmt_zu_geojson: тот читает СТЕЙДЖИНГ напрямую, этот — собранные multi-part
-- геометрии после импорта Фазы 1, плюс эффективная привязка к objects.code и pmt_oks.
--
-- Используется в UI /plots/map (режим «Из целевой модели») для отображения ЗУ
-- сгруппированных по бизнес-объектам ЗПР, с подсветкой ОКС-атрибутов в popup.

create or replace function public.plots_geojson(p_role text default 'all')
returns jsonb
language sql
stable
as $$
  with oks_per_zone as (
    -- ОКС-атрибуты по zone_code: список объектов с этажностью / очередью / статусом
    select
      zone_code,
      jsonb_agg(
        jsonb_build_object(
          'name',       object_name,
          'etazh_max',  etazh_max,
          'queue',      queue,
          'status',     status_code,
          'value',      value_code
        )
        order by id
      ) as oks_list
    from pmt_oks
    where zone_code is not null
    group by zone_code
  ),
  enriched as (
    select
      v.plot_id,
      v.code               as plot_code,
      v.name               as plot_name,
      v.role,
      v.permitted_use,
      v.category,
      v.area_declared_m2,
      v.area_calc_m2,
      v.polygon_count,
      v.functional_zone_code,
      v.functional_queue,
      v.functional_kind,
      v.functional_name,
      -- эффективная привязка к бизнес-объекту: direct → indirect
      coalesce(p.object_id, fo.object_id) as effective_object_id,
      o.code               as object_code,
      o.current_name       as object_name,
      o.color              as object_color,
      o.icon               as object_icon,
      oks.oks_list,
      -- multi-part геометрия в WGS84
      v.geom_4326_multi    as geom
    from v_plots_current v
    join plots p          on p.id  = v.plot_id
    left join functional_objects fo on fo.id = p.functional_object_id
    left join objects o   on o.id  = coalesce(p.object_id, fo.object_id)
    left join oks_per_zone oks on oks.zone_code = v.functional_zone_code
    where v.geom_4326_multi is not null
      and (p_role = 'all' or v.role::text = p_role)
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature',
      'id', plot_code,
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'plot_id',                plot_id,
        'plot_code',              plot_code,
        'plot_name',              plot_name,
        'role',                   role,
        'permitted_use',          permitted_use,
        'category',               category,
        'area_declared_m2',       area_declared_m2,
        'area_calc_m2',           area_calc_m2,
        'polygon_count',          polygon_count,
        'functional_zone_code',   functional_zone_code,
        'functional_queue',       functional_queue,
        'functional_kind',        functional_kind,
        'functional_name',        functional_name,
        'effective_object_id',    effective_object_id,
        'object_code',            object_code,
        'object_name',            object_name,
        'object_color',           object_color,
        'object_icon',            object_icon,
        'oks',                    coalesce(oks_list, '[]'::jsonb)
      )
    ) as feature
    from enriched
    where ST_IsValid(geom)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb)
  )
  from features;
$$;

comment on function public.plots_geojson(text)
  is 'GeoJSON FeatureCollection земельных участков из целевой модели v_plots_current с обогащением через functional_objects/objects/pmt_oks. EPSG:4326. p_role: plot | servitude | all. См. WIKI 29_Сущность_Участок.md';

grant execute on function public.plots_geojson(text) to anon, authenticated, service_role;
