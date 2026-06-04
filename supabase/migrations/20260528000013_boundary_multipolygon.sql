-- ============================================================
-- ZPR — project_boundary: пересборка как MultiPolygon
-- ============================================================
-- Исходная сборка ошибочно трактовала ring2/ring3 как отверстия
-- (interior rings) в ring1. На самом деле это 3 ОТДЕЛЬНЫХ
-- полигона территории проектирования.
-- Координаты pmt_boundary НЕ ИЗМЕНЯЮТСЯ — только пересборка.
-- ============================================================

-- 1. Убираем зависимый view, generated column, меняем типы
DROP VIEW IF EXISTS public.gis_project_boundary;
ALTER TABLE project_boundary DROP COLUMN IF EXISTS area_m2;

ALTER TABLE project_boundary
  ALTER COLUMN geom_sk63 TYPE geometry(MultiPolygon, 970634)
    USING ST_Multi(geom_sk63),
  ALTER COLUMN geom_wgs84 TYPE geometry(MultiPolygon, 4326)
    USING ST_Multi(geom_wgs84),
  ALTER COLUMN geom_utm36n TYPE geometry(MultiPolygon, 32636)
    USING ST_Multi(geom_utm36n);

ALTER TABLE project_boundary
  ADD COLUMN area_m2 double precision;

-- 2. Пересобираем из оригинальных точек pmt_boundary
UPDATE project_boundary
SET
  geom_sk63 = rebuilt.geom,
  geom_wgs84 = ST_Transform(rebuilt.geom, 4326),
  geom_utm36n = ST_Transform(rebuilt.geom, 32636),
  area_m2 = ST_Area(ST_Transform(rebuilt.geom, 4326)::geography)
FROM (
  WITH poly1 AS (
    SELECT ST_MakePolygon(ST_MakeLine(
      array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id)
    )) AS geom
    FROM pmt_boundary b WHERE b.id BETWEEN 1 AND 290
  ),
  poly2 AS (
    SELECT ST_MakePolygon(ST_MakeLine(
      array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id)
      || (array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id))[1:1]
    )) AS geom
    FROM pmt_boundary b WHERE b.id BETWEEN 291 AND 297
  ),
  poly3 AS (
    SELECT ST_MakePolygon(ST_MakeLine(
      array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id)
      || (array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id))[1:1]
    )) AS geom
    FROM pmt_boundary b WHERE b.id BETWEEN 298 AND 307
  )
  SELECT ST_SetSRID(
    ST_Collect(ARRAY[
      (SELECT geom FROM poly1),
      (SELECT geom FROM poly2),
      (SELECT geom FROM poly3)
    ]),
    970634
  )::geometry(MultiPolygon, 970634) AS geom
) AS rebuilt;

-- 3. Пересоздаём gis_project_boundary view
CREATE VIEW public.gis_project_boundary AS
SELECT
  1::integer AS objectid,
  pb.id,
  pb.name,
  pb.area_m2,
  pb.source_table,
  pb.geom_wgs84::geometry(MultiPolygon, 4326) AS geom_wgs84,
  pb.geom_sk63::geometry(MultiPolygon, 970634) AS geom_sk63,
  pb.geom_utm36n::geometry(MultiPolygon, 32636) AS geom_utm36n
FROM project_boundary pb
WHERE pb.geom_wgs84 IS NOT NULL;

GRANT SELECT ON public.gis_project_boundary TO anon, authenticated, arcgis_writer;
