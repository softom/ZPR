-- ============================================================
-- ZPR — Обновление RPC cadastrals_geojson: добавлены поля КПТ
-- ============================================================
-- Добавлены: source, cadastral_cost, area_inaccuracy,
-- category_code, subtype_code, cad_quarter, in_project
-- ============================================================

CREATE OR REPLACE FUNCTION public.cadastrals_geojson(
    p_ownership text DEFAULT 'all',
    p_seizure text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  WITH cad_own_geom AS (
    SELECT
      cad.id, cad.cadastral_number, cad.address, cad.category,
      cad.vri, cad.ownership, cad.ownership_raw, cad.area_m2,
      cad.is_seizure, cad.seizure_area_m2, cad.vri_changes,
      cad.source, cad.cadastral_cost, cad.area_inaccuracy,
      cad.category_code, cad.subtype_code, cad.cad_quarter, cad.in_project,
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
    SELECT
      cad.id, cad.cadastral_number, cad.address, cad.category,
      cad.vri, cad.ownership, cad.ownership_raw, cad.area_m2,
      cad.is_seizure, cad.seizure_area_m2, cad.vri_changes,
      cad.source, cad.cadastral_cost, cad.area_inaccuracy,
      cad.category_code, cad.subtype_code, cad.cad_quarter, cad.in_project,
      ST_Multi(ST_Union(pp.geom_4326)) AS geom
    FROM cadastrals cad
    JOIN plot_cadastrals pc ON pc.cadastral_id = cad.id
    JOIN plots p ON p.id = pc.plot_id AND p.active = true
    JOIN plot_polygon_assignments ppa ON ppa.plot_id = p.id AND ppa.valid_to IS NULL
    JOIN plot_polygons pp ON pp.id = ppa.polygon_id
    WHERE cad.active = true
      AND cad.geom IS NULL
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
        'vri_changes',       coalesce(vri_changes, '[]'::jsonb),
        'source',            source,
        'cadastral_cost',    cadastral_cost,
        'area_inaccuracy',   area_inaccuracy,
        'category_code',     category_code,
        'subtype_code',      subtype_code,
        'cad_quarter',       cad_quarter,
        'in_project',        in_project
      )
    ) AS feature
    FROM combined
    WHERE geom IS NOT NULL AND ST_IsValid(geom)
  )
  SELECT jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  FROM features;
$$;
