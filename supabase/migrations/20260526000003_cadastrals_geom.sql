-- ============================================================
-- ZPR — Добавление геометрии в cadastrals
-- ============================================================
-- Колонка geom хранит контур из Публичной кадастровой карты
-- (PKK / НСПД). Заполняется скриптом fetch_cadastral_geometry.py.
-- ============================================================

ALTER TABLE public.cadastrals
  ADD COLUMN IF NOT EXISTS geom geometry(MultiPolygon, 4326);

CREATE INDEX IF NOT EXISTS idx_cadastrals_geom
  ON cadastrals USING gist (geom)
  WHERE geom IS NOT NULL;

-- ── Обновлённый GeoJSON RPC ────────────────────────────────────────────────────
-- Теперь использует собственную геометрию cadastrals.geom (из ПКК),
-- а если её нет — fallback на union полигонов связанных plots.
CREATE OR REPLACE FUNCTION public.cadastrals_geojson(
  p_ownership text DEFAULT 'all',
  p_seizure   text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH cad_own_geom AS (
    -- Вариант A: собственная геометрия из ПКК
    SELECT
      cad.id, cad.cadastral_number, cad.address, cad.category,
      cad.vri, cad.ownership, cad.ownership_raw, cad.area_m2,
      cad.is_seizure, cad.seizure_area_m2, cad.vri_changes,
      cad.geom AS geom
    FROM cadastrals cad
    WHERE cad.active = true
      AND cad.geom IS NOT NULL
      AND (p_ownership = 'all' OR cad.ownership::text = p_ownership)
      AND (p_seizure = 'all'
           OR (p_seizure = 'seizure' AND cad.is_seizure = true)
           OR (p_seizure = 'kept' AND cad.is_seizure = false))
  ),
  cad_plot_geom AS (
    -- Вариант B: fallback — union полигонов связанных plots
    SELECT
      cad.id, cad.cadastral_number, cad.address, cad.category,
      cad.vri, cad.ownership, cad.ownership_raw, cad.area_m2,
      cad.is_seizure, cad.seizure_area_m2, cad.vri_changes,
      ST_Multi(ST_Union(pp.geom_4326)) AS geom
    FROM cadastrals cad
    JOIN plot_cadastrals pc ON pc.cadastral_id = cad.id
    JOIN plots p ON p.id = pc.plot_id AND p.active = true
    JOIN plot_polygon_assignments ppa ON ppa.plot_id = p.id AND ppa.valid_to IS NULL
    JOIN plot_polygons pp ON pp.id = ppa.polygon_id
    WHERE cad.active = true
      AND cad.geom IS NULL  -- только если нет собственной геометрии
      AND (p_ownership = 'all' OR cad.ownership::text = p_ownership)
      AND (p_seizure = 'all'
           OR (p_seizure = 'seizure' AND cad.is_seizure = true)
           OR (p_seizure = 'kept' AND cad.is_seizure = false))
    GROUP BY cad.id
  ),
  combined AS (
    SELECT * FROM cad_own_geom
    UNION ALL
    SELECT * FROM cad_plot_geom
  ),
  features AS (
    SELECT jsonb_build_object(
      'type', 'Feature',
      'id', cadastral_number,
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'cadastral_id',      id,
        'cadastral_number',  cadastral_number,
        'address',           address,
        'category',          category,
        'vri',               vri,
        'ownership',         ownership,
        'ownership_raw',     ownership_raw,
        'area_m2',           area_m2,
        'is_seizure',        is_seizure,
        'seizure_area_m2',   seizure_area_m2,
        'vri_changes',       coalesce(vri_changes, '[]'::jsonb)
      )
    ) AS feature
    FROM combined
    WHERE geom IS NOT NULL AND ST_IsValid(geom)
  )
  SELECT jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  FROM features;
$$;

COMMENT ON FUNCTION public.cadastrals_geojson(text, text)
  IS 'GeoJSON кадастров. Приоритет: собственная geom (ПКК), fallback — union plot polygons. EPSG:4326.';

-- ── Обновлённый view — добавляем has_geom ─────────────────────────────────────
DROP VIEW IF EXISTS public.v_cadastrals_full CASCADE;
CREATE VIEW public.v_cadastrals_full AS
SELECT cad.id,
    cad.cadastral_number,
    cad.address,
    cad.category,
    cad.vri,
    cad.ownership_raw,
    cad.ownership,
    cad.area_m2,
    cad.status,
    cad.is_seizure,
    cad.seizure_area_m2,
    cad.seizure_dpt_no,
    cad.seizure_note,
    cad.seizure_building_kn,
    cad.seizure_building_area,
    cad.vri_changes,
    cad.source_page,
    cad.source_id,
    cad.active,
    cad.created_at,
    cad.updated_at,
    (cad.geom IS NOT NULL) AS has_geom,
    COALESCE(pc.plot_count, 0::bigint) AS linked_plots_count,
    COALESCE(pc.plot_codes, '{}'::text[]) AS linked_plot_codes
   FROM cadastrals cad
     LEFT JOIN LATERAL ( SELECT count(*) AS plot_count,
            array_agg(p.code ORDER BY p.code) AS plot_codes
           FROM plot_cadastrals pcl
             JOIN plots p ON p.id = pcl.plot_id
          WHERE pcl.cadastral_id = cad.id) pc ON true;
