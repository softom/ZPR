-- ============================================================
-- ZPR — Починка самопересечения project_boundary
-- ============================================================
-- Отверстие 1 (hole1, точки 291-297) частично выходило за
-- пределы внешнего кольца. ArcGIS отображал это как артефакт.
-- Фикс: обрезаем hole1 по внешнему контуру (buffer -0.01 м
-- в СК-63, чтобы hole1 не касался внешнего кольца).
-- ============================================================

UPDATE project_boundary
SET
  geom_sk63 = fixed.geom_sk63,
  geom_wgs84 = ST_Transform(fixed.geom_sk63, 4326),
  geom_utm36n = ST_Transform(fixed.geom_sk63, 32636)
FROM (
  WITH parts AS (
    SELECT
      ST_ExteriorRing(geom_sk63) AS ext_ring,
      ST_InteriorRingN(geom_sk63, 1) AS hole1_ring,
      ST_InteriorRingN(geom_sk63, 2) AS hole2_ring
    FROM project_boundary
  ),
  clipped AS (
    SELECT
      ext_ring,
      ST_ExteriorRing(
        ST_Buffer(
          ST_Intersection(
            ST_Buffer(ST_MakePolygon(ext_ring), -0.01),
            ST_MakePolygon(hole1_ring)
          ),
          0
        )
      ) AS hole1_fixed,
      hole2_ring
    FROM parts
  )
  SELECT
    ST_SetSRID(
      ST_MakePolygon(ext_ring, ARRAY[hole1_fixed, hole2_ring]),
      970634
    ) AS geom_sk63
  FROM clipped
) AS fixed;
