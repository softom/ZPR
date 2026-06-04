-- ============================================================
-- ZPR — Граница территории проектирования (project_boundary)
-- ============================================================
-- Сборка полигона из точек pmt_boundary (307 точек, 3 кольца):
--   Кольцо 1 (id 1–290): внешний контур, 289 вершин + замыкание
--   Кольцо 2 (id 291–297): внутренний вырез (7 вершин)
--   Кольцо 3 (id 298–307): внутренний вырез (10 вершин)
--
-- Координаты в СК-63 z4 (SRID 970634):
--   pmt_boundary.x = northing, pmt_boundary.y = easting
--   PostGIS ST_Point(easting, northing) = ST_Point(y, x)
-- ============================================================

-- ── 1. Таблица ────────────────────────────────────────────────────────────────
CREATE TABLE public.project_boundary (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL DEFAULT 'Территория проектирования ЗПР',
    geom        geometry(Polygon, 4326),          -- WGS84 для карты
    geom_local  geometry(Polygon, 970634),         -- оригинал СК-63 z4
    area_m2     numeric GENERATED ALWAYS AS (
                    CASE WHEN geom_local IS NOT NULL
                         THEN ST_Area(geom_local)
                    END
                ) STORED,
    source_table text NOT NULL DEFAULT 'pmt_boundary',
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.project_boundary
    IS 'Граница территории проектирования ЗПР. Одна строка — один полигон (с вырезами).';

GRANT SELECT ON public.project_boundary TO anon, authenticated;

-- ── 2. Сборка полигона из точек ───────────────────────────────────────────────
-- Шаг 2a: внешнее кольцо (id 1–290, точка 290 совпадает с 1 — замыкание)
-- Шаг 2b: внутренние кольца 2 и 3 — замыкаем добавлением первой точки
WITH ring1_line AS (
    SELECT ST_MakeLine(
        array_agg(
            ST_SetSRID(ST_MakePoint(b.y, b.x), 970634)
            ORDER BY b.id
        )
    ) AS line
    FROM pmt_boundary b
    WHERE b.id BETWEEN 1 AND 290
),
ring2_pts AS (
    SELECT array_agg(
        ST_SetSRID(ST_MakePoint(b.y, b.x), 970634)
        ORDER BY b.id
    ) AS pts
    FROM pmt_boundary b
    WHERE b.id BETWEEN 291 AND 297
),
ring2_line AS (
    -- Замыкаем: добавляем первую точку в конец
    SELECT ST_MakeLine(pts || pts[1:1]) AS line
    FROM ring2_pts
),
ring3_pts AS (
    SELECT array_agg(
        ST_SetSRID(ST_MakePoint(b.y, b.x), 970634)
        ORDER BY b.id
    ) AS pts
    FROM pmt_boundary b
    WHERE b.id BETWEEN 298 AND 307
),
ring3_line AS (
    SELECT ST_MakeLine(pts || pts[1:1]) AS line
    FROM ring3_pts
),
polygon_local AS (
    SELECT ST_MakePolygon(
        (SELECT line FROM ring1_line),
        ARRAY[
            (SELECT line FROM ring2_line),
            (SELECT line FROM ring3_line)
        ]
    ) AS geom
)
INSERT INTO project_boundary (name, geom_local, geom)
SELECT
    'Территория проектирования ЗПР',
    geom,
    ST_Transform(geom, 4326)
FROM polygon_local;

-- ── 3. GeoJSON RPC ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.project_boundary_geojson()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
    WITH features AS (
        SELECT jsonb_build_object(
            'type', 'Feature',
            'id', 'project_boundary',
            'geometry', ST_AsGeoJSON(geom)::jsonb,
            'properties', jsonb_build_object(
                'name',    name,
                'area_m2', area_m2
            )
        ) AS feature
        FROM project_boundary
        WHERE geom IS NOT NULL
        LIMIT 1
    )
    SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
    )
    FROM features;
$$;

COMMENT ON FUNCTION public.project_boundary_geojson()
    IS 'GeoJSON границы территории проектирования ЗПР. Один полигон с вырезами. EPSG:4326.';
