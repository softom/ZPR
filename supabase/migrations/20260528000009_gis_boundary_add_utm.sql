-- ============================================================
-- ZPR — gis_project_boundary: добавить geom_utm36n
-- ============================================================
-- ArcGIS Pro может не распознавать SRID 970634 (СК-63).
-- Добавляем UTM 36N (EPSG:32636) — стандартный SRID,
-- гарантированно поддерживается ArcGIS.
-- ============================================================

DROP VIEW IF EXISTS public.gis_project_boundary;
CREATE VIEW public.gis_project_boundary AS
SELECT
  1::integer AS objectid,
  pb.id,
  pb.name,
  pb.area_m2,
  pb.source_table,
  st_multi(pb.geom_wgs84)::geometry(MultiPolygon, 4326) AS geom_wgs84,
  st_multi(pb.geom_sk63)::geometry(MultiPolygon, 970634) AS geom_sk63,
  st_multi(st_transform(pb.geom_wgs84, 32636))::geometry(MultiPolygon, 32636) AS geom_utm36n
FROM project_boundary pb
WHERE pb.geom_wgs84 IS NOT NULL;

GRANT SELECT ON public.gis_project_boundary TO anon, authenticated, arcgis_writer;
