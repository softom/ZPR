-- ============================================================
-- ZPR — Расширение plots_geojson и functional_objects_geojson:
-- добавляем массив masterplan_objects[] в properties.
-- ============================================================
-- Нужно для UI: общий компонент PlotsTab принимает owner_type='object' или
-- 'masterplan_object' и фильтрует/раскрашивает по нужному массиву.
--
-- Структура нового поля в properties:
--   masterplan_objects: [{ id, code, queue, name_contract }]
-- ============================================================

create or replace function public.plots_geojson(p_role text default 'all')
returns jsonb
language sql
stable
as $$
  with oks_per_zone as (
    select zone_code,
      jsonb_agg(jsonb_build_object(
        'name', object_name, 'etazh_max', etazh_max, 'queue', queue,
        'status', status_code, 'value', value_code
      ) order by id) as oks_list
    from pmt_oks where zone_code is not null group by zone_code
  ),
  enriched as (
    select
      v.plot_id, v.code as plot_code, v.name as plot_name, v.role,
      v.permitted_use, v.category, v.area_declared_m2, v.area_calc_m2, v.polygon_count,
      v.functional_zone_code, v.functional_queue, v.functional_kind, v.functional_name,
      v.effective_object_ids,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', o.id, 'code', o.code, 'name', o.current_name,
          'color', o.color, 'icon', o.icon
        ) order by o.code), '[]'::jsonb)
        from unnest(v.effective_object_ids) as oid
        join objects o on o.id = oid
      ) as objects,
      -- Новое: список мастерплан-объектов, связанных с этим plot напрямую через junction
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', mo.id, 'code', mo.code, 'queue', mo.queue,
          'name_ppt', mo.name_ppt, 'name_contract', mo.name_contract
        ) order by mo.code), '[]'::jsonb)
        from masterplan_object_plots mop
        join masterplan_objects mo on mo.id = mop.masterplan_object_id
        where mop.plot_id = v.plot_id and mo.active = true
      ) as masterplan_objects,
      oks.oks_list,
      v.geom_4326_multi as geom
    from v_plots_current v
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
        'effective_object_ids',   to_jsonb(effective_object_ids),
        'objects',                coalesce(objects, '[]'::jsonb),
        'masterplan_objects',     coalesce(masterplan_objects, '[]'::jsonb),
        'oks',                    coalesce(oks_list, '[]'::jsonb)
      )
    ) as feature
    from enriched
    where ST_IsValid(geom)
  )
  select jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  from features;
$$;

comment on function public.plots_geojson(text)
  is 'GeoJSON FeatureCollection участков. properties: objects[] (бизнес-объекты ЗПР через M:N) + masterplan_objects[] (мастерплан-объекты через masterplan_object_plots). EPSG:4326.';

-- ── functional_objects_geojson — масttext добавляем masterplan_objects[] ──────
create or replace function public.functional_objects_geojson(p_kind text default 'all')
returns jsonb
language sql
stable
as $$
  with zone_params as (
    select zone_code, jsonb_build_object(
      'area_m2', area_m2, 'k_otn', k_otn, 'k_isp', k_isp,
      'k_oz_pct', k_oz_pct, 'k_det_pct', k_det_pct, 'k_vzr_pct', k_vzr_pct,
      'k_mm', k_mm, 'etazh_max', etazh_max) as params
    from pmt_zone_params
  ),
  oks_per_zone as (
    select zone_code, jsonb_agg(jsonb_build_object(
      'name', object_name, 'etazh_max', etazh_max, 'queue', queue,
      'status', status_code, 'value', value_code) order by id) as oks_list
    from pmt_oks where zone_code is not null group by zone_code
  ),
  zone_objects as (
    select foo.functional_object_id,
      jsonb_agg(jsonb_build_object(
        'id', o.id, 'code', o.code, 'name', o.current_name,
        'color', o.color, 'icon', o.icon) order by o.code) as objects
    from functional_object_objects foo
    join objects o on o.id = foo.object_id
    group by foo.functional_object_id
  ),
  zone_masterplan as (
    -- Мастерплан-объекты, связанные с зоной через junction
    select mfo.functional_object_id,
      jsonb_agg(jsonb_build_object(
        'id', mo.id, 'code', mo.code, 'queue', mo.queue,
        'name_ppt', mo.name_ppt, 'name_contract', mo.name_contract
      ) order by mo.code) as masterplan_objects
    from masterplan_object_functional_objects mfo
    join masterplan_objects mo on mo.id = mfo.masterplan_object_id and mo.active = true
    group by mfo.functional_object_id
  ),
  zone_geom as (
    select fo.id as functional_object_id, fo.zone_code, fo.queue, fo.kind,
      fo.name as zone_name,
      ST_Multi(ST_Union(pp.geom_4326)) as geom,
      sum(pp.area_calc_m2) as area_calc_m2,
      count(distinct p.id) as plots_count,
      array_agg(distinct p.code order by p.code) as plot_codes
    from functional_objects fo
    join plots p on p.functional_object_id = fo.id and p.active = true
    join plot_polygon_assignments ppa on ppa.plot_id = p.id and ppa.valid_to is null
    join plot_polygons pp on pp.id = ppa.polygon_id
    where fo.active = true and (p_kind = 'all' or fo.kind::text = p_kind)
    group by fo.id
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature', 'id', zg.zone_code,
      'geometry', ST_AsGeoJSON(zg.geom)::jsonb,
      'properties', jsonb_build_object(
        'functional_object_id', zg.functional_object_id,
        'zone_code',            zg.zone_code,
        'zone_name',            zg.zone_name,
        'queue',                zg.queue,
        'kind',                 zg.kind,
        'objects',              coalesce(zo.objects, '[]'::jsonb),
        'masterplan_objects',   coalesce(zm.masterplan_objects, '[]'::jsonb),
        'plots_count',          zg.plots_count,
        'plot_codes',           to_jsonb(zg.plot_codes),
        'area_calc_m2',         zg.area_calc_m2,
        'zone_params',          zp.params,
        'oks',                  coalesce(oks.oks_list, '[]'::jsonb)
      )
    ) as feature
    from zone_geom zg
    left join zone_objects zo    on zo.functional_object_id = zg.functional_object_id
    left join zone_masterplan zm on zm.functional_object_id = zg.functional_object_id
    left join zone_params zp     on zp.zone_code = zg.zone_code
    left join oks_per_zone oks   on oks.zone_code = zg.zone_code
    where zg.geom is not null and ST_IsValid(zg.geom)
  )
  select jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  from features;
$$;

comment on function public.functional_objects_geojson(text)
  is 'GeoJSON FeatureCollection функциональных зон ППТ. properties: objects[] + masterplan_objects[]. EPSG:4326.';
