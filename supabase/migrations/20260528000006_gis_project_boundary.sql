-- ============================================================
-- ZPR — ArcGIS view для границы проекта
-- ============================================================
-- ArcGIS Pro требует integer objectid. Таблица project_boundary
-- имеет uuid PK — ArcGIS её не видит. View добавляет objectid.
-- ============================================================

CREATE OR REPLACE VIEW public.gis_project_boundary AS
SELECT
  1::integer AS objectid,
  pb.id,
  pb.name,
  pb.area_m2,
  pb.source_table,
  pb.geom_wgs84::geometry(Polygon, 4326) AS geom_wgs84,
  pb.geom_sk63::geometry(Polygon, 970634) AS geom_sk63
FROM project_boundary pb
WHERE pb.geom_wgs84 IS NOT NULL;

GRANT SELECT ON public.gis_project_boundary TO anon, authenticated, arcgis_writer;
