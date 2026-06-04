-- ============================================================
-- ZPR — gis_project_boundary: Polygon → MultiPolygon
-- ============================================================
-- ArcGIS Pro ожидает MultiPolygon (как во всех gis_* views).
-- Исходный тип Polygon не попадает в список Feature Classes.
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
  st_multi(pb.geom_sk63)::geometry(MultiPolygon, 970634) AS geom_sk63
FROM project_boundary pb
WHERE pb.geom_wgs84 IS NOT NULL;

GRANT SELECT ON public.gis_project_boundary TO anon, authenticated, arcgis_writer;
