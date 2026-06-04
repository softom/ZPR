-- ============================================================
-- ZPR — публикация остальных гео-слоёв в ArcGIS-friendly views
-- ============================================================
-- Дополняет 20260521010001_gis_arcgis_views.sql тремя view'ами:
--   1. gis_cadastrals       — кадастровые участки (cadastrals.geom)
--   2. gis_object_features  — здания / дороги / utility (object_geometries
--                             non-plot), типизация по сторонам в трёх под-view
--   3. gis_raster_footprints — bbox ортофото / DEM (raster_layers.bbox*)
--
-- Все view отдают geom_4326 и geom_sk63 — это позволяет zpr_gis-mirror
-- (sync_tables_public.sql) забрать оба варианта для WGS/СК-63 клиентов.
-- ============================================================

-- ── 1. gis_cadastrals — кадастры с геометрией ────────────────────────────────
drop view if exists gis_cadastrals cascade;
create view gis_cadastrals as
select
    row_number() over (order by cadastral_number)::int as objectid,
    id,
    cadastral_number,
    address,
    category,
    category_code,
    vri,
    ownership::text                                       as ownership,
    ownership_raw,
    source::text                                          as source,
    is_seizure,
    seizure_area_m2,
    area_m2                                               as area_declared_m2,
    cadastral_cost,
    status,
    active,
    geom                                                  as geom_4326,
    extensions.ST_Multi(extensions.ST_Transform(geom, 970634)) as geom_sk63
from cadastrals
where active = true and geom is not null;

comment on view gis_cadastrals is
  'ArcGIS-friendly: кадастровые участки с MultiPolygon-геометрией. Источник cadastrals (ПКК / КПТ XML / ПМТ). geom_4326 хранится в БД, geom_sk63 вычисляется ST_Transform.';

-- ── 2. gis_object_features — прочая геометрия объектов (НЕ участки) ──────────
-- object_geometries.kind ∈ (building, road, utility_line, utility_node, zone,
--                           point, other, plot)
-- Участки (kind='plot') исключаем — они уже в gis_plots.
-- ArcGIS Pro требует один тип геометрии на view → разносим в три:
--   *_polygons (building, zone, other-полигоны)
--   *_lines    (road, utility_line)
--   *_points   (utility_node, point)
--
-- ВАЖНО: object_geometries.geom — generic geometry(Geometry, 970634), поэтому
-- фильтр и через kind, и через GeometryType() для надёжности.

drop view if exists gis_object_polygons cascade;
create view gis_object_polygons as
select
    row_number() over (order by og.created_at, og.id)::int as objectid,
    og.id,
    og.object_id,
    o.code                                                  as object_code,
    o.current_name                                          as object_name,
    og.kind::text                                           as kind,
    og.name,
    og.source                                               as source,
    og.properties,
    og.valid_from,
    extensions.ST_Multi(og.geom_4326)::extensions.geometry(MultiPolygon, 4326)   as geom_4326,
    extensions.ST_Multi(og.geom)::extensions.geometry(MultiPolygon, 970634)      as geom_sk63
from object_geometries og
left join objects o on o.id = og.object_id
where og.kind in ('building', 'zone', 'other')
  and og.valid_to is null
  and extensions.GeometryType(og.geom) in ('POLYGON', 'MULTIPOLYGON');

comment on view gis_object_polygons is
  'ArcGIS-friendly: полигональные фичи объектов (здания, зоны, прочие полигоны). Не путать с gis_plots (участки) и gis_functional_zones (зоны ППТ).';

drop view if exists gis_object_lines cascade;
create view gis_object_lines as
select
    row_number() over (order by og.created_at, og.id)::int as objectid,
    og.id,
    og.object_id,
    o.code                                                  as object_code,
    o.current_name                                          as object_name,
    og.kind::text                                           as kind,
    og.name,
    og.source                                               as source,
    og.properties,
    og.valid_from,
    extensions.ST_Multi(og.geom_4326)::extensions.geometry(MultiLineString, 4326)   as geom_4326,
    extensions.ST_Multi(og.geom)::extensions.geometry(MultiLineString, 970634)      as geom_sk63
from object_geometries og
left join objects o on o.id = og.object_id
where og.kind in ('road', 'utility_line')
  and og.valid_to is null
  and extensions.GeometryType(og.geom) in ('LINESTRING', 'MULTILINESTRING');

comment on view gis_object_lines is
  'ArcGIS-friendly: линейные фичи объектов (дороги, линии инженерных сетей).';

drop view if exists gis_object_points cascade;
create view gis_object_points as
select
    row_number() over (order by og.created_at, og.id)::int as objectid,
    og.id,
    og.object_id,
    o.code                                                  as object_code,
    o.current_name                                          as object_name,
    og.kind::text                                           as kind,
    og.name,
    og.source                                               as source,
    og.properties,
    og.valid_from,
    extensions.ST_Multi(og.geom_4326)::extensions.geometry(MultiPoint, 4326)   as geom_4326,
    extensions.ST_Multi(og.geom)::extensions.geometry(MultiPoint, 970634)      as geom_sk63
from object_geometries og
left join objects o on o.id = og.object_id
where og.kind in ('utility_node', 'point')
  and og.valid_to is null
  and extensions.GeometryType(og.geom) in ('POINT', 'MULTIPOINT');

comment on view gis_object_points is
  'ArcGIS-friendly: точечные фичи объектов (узлы инженерных сетей, прочие точки).';

-- ── 3. gis_raster_footprints — bbox растров (ортофото / DEM) ─────────────────
drop view if exists gis_raster_footprints cascade;
create view gis_raster_footprints as
select
    row_number() over (order by rl.captured_at nulls last, rl.created_at)::int as objectid,
    rl.id,
    rl.object_id,
    o.code                       as object_code,
    rl.title,
    rl.kind,
    rl.storage_url,
    rl.resolution_m,
    rl.captured_at,
    rl.z_min,
    rl.z_max,
    rl.z_unit,
    rl.colormap,
    extensions.ST_Multi(rl.bbox_wgs84)::extensions.geometry(MultiPolygon, 4326)   as geom_4326,
    extensions.ST_Multi(rl.bbox)::extensions.geometry(MultiPolygon, 970634)       as geom_sk63
from raster_layers rl
left join objects o on o.id = rl.object_id
where rl.bbox is not null;

comment on view gis_raster_footprints is
  'ArcGIS-friendly: bbox-футпринты растров (ортофото, DEM, батиметрия). Сами файлы хранятся вне БД по storage_url.';

-- ── 4. Гранты для arcgis_writer ──────────────────────────────────────────────
grant select on
  gis_cadastrals,
  gis_object_polygons, gis_object_lines, gis_object_points,
  gis_raster_footprints
  to arcgis_writer;
