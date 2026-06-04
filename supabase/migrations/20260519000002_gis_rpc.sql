-- ============================================================
-- ZPR — GIS RPC + view для веб-карты
-- ============================================================
-- Отдаёт геометрию в WGS84 (GeoJSON) для MapLibre.
-- Использует generated column geom_4326 — без on-the-fly трансформации.
-- ============================================================

drop view     if exists v_object_geometries_4326   cascade;
drop function if exists public.get_object_geometries(uuid) cascade;
drop function if exists public.insert_geometry_from_wkt(uuid, text, text, text, int, jsonb, text, text) cascade;

-- View — для прямых выборок через PostgREST
create view v_object_geometries_4326 as
select
    id,
    object_id,
    kind,
    name,
    geom_4326,
    properties,
    source,
    valid_from
from object_geometries
where valid_to is null;

comment on view v_object_geometries_4326 is
  'Текущая геометрия объектов в WGS84 для веб-карты и ArcGIS-чтения.';

-- RPC для UI карты — отдаёт GeoJSON-features per kind
create or replace function public.get_object_geometries(p_object_id uuid)
returns table (
    id            uuid,
    kind          text,
    name          text,
    geom_geojson  jsonb,
    properties    jsonb,
    source        text,
    valid_from    timestamptz
)
language sql stable as $$
  select
      og.id,
      og.kind::text,
      og.name,
      ST_AsGeoJSON(og.geom_4326)::jsonb,
      og.properties,
      og.source,
      og.valid_from
  from object_geometries og
  where og.object_id = p_object_id
    and og.valid_to is null
  order by og.kind, og.name;
$$;

comment on function public.get_object_geometries(uuid) is
  'Геометрия объекта в WGS84 GeoJSON для MapLibre.';

-- RPC для импорта геометрии из табличных данных (CSV/XLSX).
-- Вызывается из /api/geometry/import построчно — даёт точные построчные ошибки.
create or replace function public.insert_geometry_from_wkt(
    p_object_id   uuid,
    p_kind        text,
    p_name        text,
    p_wkt         text,
    p_srid        int default 970634,
    p_properties  jsonb default '{}'::jsonb,
    p_source      text default 'tabular_import',
    p_created_by  text default null
) returns uuid
language plpgsql security definer as $$
declare
    v_id uuid;
begin
    insert into object_geometries
      (object_id, kind, name, geom, properties, source, created_by)
    values (
      p_object_id,
      p_kind::geometry_kind,
      p_name,
      ST_GeomFromText(p_wkt, p_srid),
      coalesce(p_properties, '{}'::jsonb),
      p_source,
      p_created_by
    )
    returning id into v_id;
    return v_id;
end$$;

comment on function public.insert_geometry_from_wkt is
  'Импорт одной строки геометрии из табличного источника. Используется /api/geometry/import.';

-- Грант на view для ArcGIS — читает данные ЗПР через стандартный PostgREST/PostGIS
grant select on v_object_geometries_4326 to arcgis_writer, anon, authenticated;
grant execute on function public.get_object_geometries(uuid) to anon, authenticated;
grant execute on function public.insert_geometry_from_wkt(uuid, text, text, text, int, jsonb, text, text)
      to anon, authenticated, service_role;
