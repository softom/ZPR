-- RPC `functional_objects_geojson(p_kind)` — границы функциональных зон ППТ.
--
-- Геометрия зоны = ST_Union всех plot_polygons, чьи plots имеют functional_object_id
-- равный этой зоне. Один Feature = одна зона.
--
-- Атрибуты обогащаются параметрами застройки (pmt_zone_params) и списком ОКС (pmt_oks).
--
-- Используется в UI /plots/map (режим «Функциональные зоны»).

create or replace function public.functional_objects_geojson(p_kind text default 'all')
returns jsonb
language sql
stable
as $$
  with zone_params as (
    select
      zone_code,
      jsonb_build_object(
        'area_m2',     area_m2,
        'k_otn',       k_otn,
        'k_isp',       k_isp,
        'k_oz_pct',    k_oz_pct,
        'k_det_pct',   k_det_pct,
        'k_vzr_pct',   k_vzr_pct,
        'k_mm',        k_mm,
        'etazh_max',   etazh_max
      ) as params
    from pmt_zone_params
  ),
  oks_per_zone as (
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
  zone_geom as (
    select
      fo.id                                   as functional_object_id,
      fo.zone_code,
      fo.queue,
      fo.kind,
      fo.name                                 as zone_name,
      fo.object_id,
      o.code                                  as object_code,
      o.current_name                          as object_name,
      o.color                                 as object_color,
      o.icon                                  as object_icon,
      ST_Multi(ST_Union(pp.geom_4326))        as geom,
      sum(pp.area_calc_m2)                    as area_calc_m2,
      count(distinct p.id)                    as plots_count,
      array_agg(distinct p.code order by p.code) as plot_codes
    from functional_objects fo
    join plots p                              on p.functional_object_id = fo.id and p.active = true
    join plot_polygon_assignments ppa         on ppa.plot_id = p.id and ppa.valid_to is null
    join plot_polygons pp                     on pp.id = ppa.polygon_id
    left join objects o                       on o.id = fo.object_id
    where fo.active = true
      and (p_kind = 'all' or fo.kind::text = p_kind)
    group by fo.id, o.code, o.current_name, o.color, o.icon
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature',
      'id', zg.zone_code,
      'geometry', ST_AsGeoJSON(zg.geom)::jsonb,
      'properties', jsonb_build_object(
        'functional_object_id', zg.functional_object_id,
        'zone_code',            zg.zone_code,
        'zone_name',            zg.zone_name,
        'queue',                zg.queue,
        'kind',                 zg.kind,
        'object_code',          zg.object_code,
        'object_name',          zg.object_name,
        'object_color',         zg.object_color,
        'object_icon',          zg.object_icon,
        'plots_count',          zg.plots_count,
        'plot_codes',           to_jsonb(zg.plot_codes),
        'area_calc_m2',         zg.area_calc_m2,
        'zone_params',          zp.params,
        'oks',                  coalesce(oks.oks_list, '[]'::jsonb)
      )
    ) as feature
    from zone_geom zg
    left join zone_params zp  on zp.zone_code = zg.zone_code
    left join oks_per_zone oks on oks.zone_code = zg.zone_code
    where zg.geom is not null and ST_IsValid(zg.geom)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb)
  )
  from features;
$$;

comment on function public.functional_objects_geojson(text)
  is 'GeoJSON FeatureCollection функциональных зон ППТ. Геометрия зоны = ST_Union участков из plot_polygons по functional_object_id. Атрибуты: pmt_zone_params + pmt_oks + objects. EPSG:4326. См. WIKI 29_Сущность_Участок.md';

grant execute on function public.functional_objects_geojson(text) to anon, authenticated, service_role;
