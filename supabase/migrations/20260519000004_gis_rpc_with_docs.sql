-- ============================================================
-- ZPR — Обновление RPC/view для GIS: добавлен source_document
-- ============================================================
-- Расширяем get_object_geometries и v_object_geometries_4326 —
-- теперь отдают связанный документ-основание (title + version).
-- insert_geometry_from_wkt принимает p_source_document_id.
-- ============================================================

drop view     if exists v_object_geometries_4326   cascade;
drop function if exists public.get_object_geometries(uuid) cascade;
drop function if exists public.insert_geometry_from_wkt(uuid, text, text, text, int, jsonb, text, text) cascade;
drop function if exists public.insert_geometry_from_wkt(uuid, text, text, text, int, jsonb, text, text, uuid) cascade;

-- ============================================================
-- View с документом-основанием
-- ============================================================
create view v_object_geometries_4326 as
select
    og.id,
    og.object_id,
    og.kind,
    og.name,
    og.geom_4326,
    og.properties,
    og.source,
    og.valid_from,
    og.source_document_id,
    d.title    as source_document_title,
    d.version  as source_document_version,
    d.type     as source_document_type
from object_geometries og
left join documents d on d.id = og.source_document_id
where og.valid_to is null;

comment on view v_object_geometries_4326 is
  'Текущая геометрия объектов в WGS84 + документ-основание (title/version). Для ArcGIS и веб-карты.';

-- ============================================================
-- RPC get_object_geometries — расширена документом
-- ============================================================
create or replace function public.get_object_geometries(p_object_id uuid)
returns table (
    id                       uuid,
    kind                     text,
    name                     text,
    geom_geojson             jsonb,
    properties               jsonb,
    source                   text,
    valid_from               timestamptz,
    source_document_id       uuid,
    source_document_title    text,
    source_document_version  text
)
language sql stable as $$
  select
      og.id,
      og.kind::text,
      og.name,
      ST_AsGeoJSON(og.geom_4326)::jsonb,
      og.properties,
      og.source,
      og.valid_from,
      og.source_document_id,
      d.title,
      d.version
  from object_geometries og
  left join documents d on d.id = og.source_document_id
  where og.object_id = p_object_id
    and og.valid_to is null
  order by og.kind, og.name;
$$;

comment on function public.get_object_geometries(uuid) is
  'Геометрия объекта в WGS84 GeoJSON + документ-основание для MapLibre.';

-- ============================================================
-- RPC insert_geometry_from_wkt — принимает source_document_id
-- ============================================================
create or replace function public.insert_geometry_from_wkt(
    p_object_id           uuid,
    p_kind                text,
    p_name                text,
    p_wkt                 text,
    p_srid                int      default 970634,
    p_properties          jsonb    default '{}'::jsonb,
    p_source              text     default 'tabular_import',
    p_created_by          text     default null,
    p_source_document_id  uuid     default null
) returns uuid
language plpgsql security definer as $$
declare
    v_id uuid;
begin
    insert into object_geometries
      (object_id, kind, name, geom, properties, source, created_by, source_document_id)
    values (
      p_object_id,
      p_kind::geometry_kind,
      p_name,
      ST_GeomFromText(p_wkt, p_srid),
      coalesce(p_properties, '{}'::jsonb),
      p_source,
      p_created_by,
      p_source_document_id
    )
    returning id into v_id;
    return v_id;
end$$;

comment on function public.insert_geometry_from_wkt is
  'Импорт одной строки геометрии. Опционально привязывает к документу-основанию.';

-- ============================================================
-- Гранты
-- ============================================================
grant select on v_object_geometries_4326 to arcgis_writer, anon, authenticated;
grant execute on function public.get_object_geometries(uuid) to anon, authenticated;
grant execute on function public.insert_geometry_from_wkt(uuid, text, text, text, int, jsonb, text, text, uuid)
      to anon, authenticated, service_role;
