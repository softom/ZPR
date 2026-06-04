-- RPC `pmt_zu_geojson(p_kind text)` — собирает GeoJSON FeatureCollection
-- из стейджинг-таблиц pmt_zu + pmt_zu_points.
--
-- Шаги внутри:
--   1) Точки группируются по `zu`, сортируются по `point_n::int`.
--   2) WKT polygon собирается в Y X порядке (OGC easting first), с замыканием
--      (первая точка повторяется в конце).
--   3) ST_GeomFromText(..., 970634) → ST_Transform → EPSG:4326.
--   4) ST_AsGeoJSON → отдельные Feature; всё это в FeatureCollection.
--
-- Используется в UI /plots/staging для отображения карты на OSM-подложке.
-- См. WIKI: 31_Данные_ПМТ_по_участкам.md, 30_GIS.md.

create or replace function public.pmt_zu_geojson(p_kind text default 'all')
returns jsonb
language sql
stable
as $$
  with poly as (
    select
      p.zu,
      z.kind,
      z.parent_zu,
      z.address,
      z.area_m2_coords,
      z.permitted_use,
      z.category,
      z.points_count,
      'POLYGON((' || string_agg(
        p.y::text || ' ' || p.x::text,
        ', '
        order by case when p.point_n ~ '^[0-9]+$' then p.point_n::int else 9999 end
      ) || ', ' ||
      (array_agg(p.y::text || ' ' || p.x::text
                 order by case when p.point_n ~ '^[0-9]+$' then p.point_n::int else 9999 end))[1]
      || '))' as wkt
    from pmt_zu_points p
    join pmt_zu z on z.zu = p.zu
    where p_kind = 'all' or z.kind = p_kind
    group by p.zu, z.kind, z.parent_zu, z.address, z.area_m2_coords,
             z.permitted_use, z.category, z.points_count
    having count(*) >= 3
  ),
  features as (
    select
      jsonb_build_object(
        'type', 'Feature',
        'id', p.zu,
        'geometry', ST_AsGeoJSON(
          ST_Transform(ST_GeomFromText(p.wkt, 970634), 4326)
        )::jsonb,
        'properties', jsonb_build_object(
          'zu',             p.zu,
          'kind',           p.kind,
          'parent_zu',      p.parent_zu,
          'address',        p.address,
          'area_m2',        p.area_m2_coords,
          'permitted_use',  p.permitted_use,
          'category',       p.category,
          'points_count',   p.points_count
        )
      ) as feature
    from poly p
    where ST_IsValid(ST_GeomFromText(p.wkt, 970634))
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb)
  )
  from features;
$$;

comment on function public.pmt_zu_geojson(text)
  is 'GeoJSON FeatureCollection земельных участков из стейджинга ПМТ. EPSG:4326. Параметр p_kind: участок | контур | сервитут | all. См. WIKI 31_Данные_ПМТ_по_участкам.md';

grant execute on function public.pmt_zu_geojson(text) to anon, authenticated, service_role;
