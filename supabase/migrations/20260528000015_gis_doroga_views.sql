-- ============================================================
-- GIS views for pmt_doroga_* tables (ArcGIS consumption)
-- ============================================================
-- Three layers:
--   1. gis_doroga_coords   — ALL 7555 coord points (for visual inspection)
--   2. gis_doroga_boundary — 2 road corridor boundary LineStrings (Том 1.2)
--   3. gis_doroga_zu       — 70 clean single-page ZU polygons (Том 3.2)
-- ============================================================
-- COORDINATE IMMUTABILITY: coordinates from public ПМТ documents
-- are reproduced AS-IS with NO rounding, buffering, or simplification.
-- ============================================================

-- 1. All coordinates as points --------------------------------

CREATE OR REPLACE VIEW gis_doroga_coords AS
SELECT
  ROW_NUMBER() OVER (ORDER BY c.id)::integer AS objectid,
  c.id,
  c.label,
  c.point_num,
  ST_SetSRID(ST_MakePoint(c.y, c.x), 970634) AS geom_sk63
FROM pmt_doroga_coords c;

COMMENT ON VIEW gis_doroga_coords IS 'Все координатные точки ПМТ ДОРОГА (СК-63 зона 4)';


-- 2. Road corridor boundaries (LineStrings) -------------------
-- Том 1.2: pages 22-30 = boundary 1, pages 32-37 = boundary 2
-- Points ordered by point_num, deduplicated per boundary group.

CREATE OR REPLACE VIEW gis_doroga_boundary AS
WITH boundary_points AS (
  SELECT
    CASE
      WHEN page BETWEEN 22 AND 30 THEN 1
      WHEN page BETWEEN 32 AND 37 THEN 2
    END AS boundary_id,
    point_num, x, y
  FROM pmt_doroga_coords
  WHERE label LIKE 'road_boundary%'
),
deduped AS (
  SELECT DISTINCT ON (boundary_id, point_num)
    boundary_id, point_num, x, y
  FROM boundary_points
  WHERE boundary_id IS NOT NULL
  ORDER BY boundary_id, point_num
),
lines AS (
  SELECT
    boundary_id,
    ST_SetSRID(
      ST_MakeLine(array_agg(ST_MakePoint(y, x) ORDER BY point_num)),
      970634
    ) AS geom
  FROM deduped
  GROUP BY boundary_id
)
SELECT
  boundary_id::integer AS objectid,
  boundary_id          AS id,
  CASE boundary_id
    WHEN 1 THEN 'Граница дороги (Том 1.2 прил.1)'
    WHEN 2 THEN 'Граница дороги (Том 1.2 прил.2)'
  END AS name,
  ST_Length(geom)      AS length_m,
  geom                 AS geom_sk63
FROM lines;

COMMENT ON VIEW gis_doroga_boundary IS 'Границы автодороги ПМТ ДОРОГА — 2 линии (левая/правая сторона коридора)';


-- 3. ZU polygons (clean single-page labels only) -------------
-- "Clean" = point_num starts at 1, max_pn close to count, >= 3 points.
-- Rings are NOT closed in source data — we append first point to close.

CREATE OR REPLACE VIEW gis_doroga_zu AS
WITH clean_labels AS (
  SELECT label
  FROM pmt_doroga_coords
  WHERE label NOT LIKE 'road_boundary%'
  GROUP BY label
  HAVING MIN(point_num) = 1
     AND MAX(point_num) <= COUNT(*) + 10
     AND COUNT(*) >= 3
),
ordered_pts AS (
  SELECT
    c.label,
    c.point_num,
    ST_MakePoint(c.y, c.x) AS pt,
    FIRST_VALUE(ST_MakePoint(c.y, c.x))
      OVER (PARTITION BY c.label ORDER BY c.point_num
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS first_pt
  FROM pmt_doroga_coords c
  WHERE c.label IN (SELECT label FROM clean_labels)
),
rings AS (
  SELECT
    label,
    ST_SetSRID(
      ST_MakePolygon(
        ST_MakeLine(
          array_agg(pt ORDER BY point_num) || ARRAY[first_pt]
        )
      ),
      970634
    ) AS geom,
    first_pt
  FROM ordered_pts
  GROUP BY label, first_pt
)
SELECT
  ROW_NUMBER() OVER (ORDER BY r.label)::integer AS objectid,
  r.label                                       AS id,
  regexp_replace(r.label, 'unknown_p', 'стр.')  AS plot_name,
  ST_Area(r.geom)                               AS area_m2,
  ST_NPoints(r.geom)                            AS num_points,
  r.geom                                        AS geom_sk63
FROM rings r
WHERE ST_NPoints(r.geom) >= 4;

COMMENT ON VIEW gis_doroga_zu IS 'Земельные участки ПМТ ДОРОГА — полигоны из координат (СК-63 зона 4)';


-- Grants (same pattern as other gis_* views)
GRANT SELECT ON gis_doroga_coords   TO anon, authenticated, service_role;
GRANT SELECT ON gis_doroga_boundary TO anon, authenticated, service_role;
GRANT SELECT ON gis_doroga_zu       TO anon, authenticated, service_role;
