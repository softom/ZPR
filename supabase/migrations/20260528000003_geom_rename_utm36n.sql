-- ============================================================
-- ZPR — Единообразные имена геометрии + UTM 36N (EPSG:32636)
-- ============================================================
-- Конвенция: geom_wgs84 (4326), geom_sk63 (970634), geom_utm36n (32636)
--
-- 1. project_boundary: geom → geom_wgs84, geom_local → geom_sk63, +geom_utm36n
-- 2. cadastrals: geom → geom_wgs84, +geom_utm36n
-- 3. Пересоздание RPC: project_boundary_geojson, cadastrals_geojson, upsert_cadastral_from_kpt
-- 4. Пересоздание views: v_cadastrals_full, все gis_* (8 шт.)
-- ============================================================

-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ 1. project_boundary                                          ║
-- ╚═══════════════════════════════════════════════════════════════╝

ALTER TABLE public.project_boundary RENAME COLUMN geom TO geom_wgs84;
ALTER TABLE public.project_boundary RENAME COLUMN geom_local TO geom_sk63;

ALTER TABLE public.project_boundary
  ADD COLUMN geom_utm36n geometry(Polygon, 32636);

UPDATE public.project_boundary
SET geom_utm36n = ST_Transform(geom_sk63, 32636)
WHERE geom_sk63 IS NOT NULL;

-- RPC
CREATE OR REPLACE FUNCTION public.project_boundary_geojson()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH features AS (
    SELECT jsonb_build_object(
      'type', 'Feature',
      'id', 'project_boundary',
      'geometry', ST_AsGeoJSON(geom_wgs84)::jsonb,
      'properties', jsonb_build_object('name', name, 'area_m2', area_m2)
    ) AS feature
    FROM project_boundary WHERE geom_wgs84 IS NOT NULL LIMIT 1
  )
  SELECT jsonb_build_object('type', 'FeatureCollection',
    'features', COALESCE(jsonb_agg(feature), '[]'::jsonb))
  FROM features;
$$;

-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ 2. cadastrals                                                ║
-- ╚═══════════════════════════════════════════════════════════════╝

ALTER TABLE public.cadastrals RENAME COLUMN geom TO geom_wgs84;

ALTER TABLE public.cadastrals
  ADD COLUMN geom_utm36n geometry(MultiPolygon, 32636);

UPDATE public.cadastrals
SET geom_utm36n = ST_Transform(geom_wgs84, 32636)
WHERE geom_wgs84 IS NOT NULL;

-- Триггер для авто-заполнения geom_utm36n при INSERT/UPDATE
CREATE OR REPLACE FUNCTION public.cadastrals_sync_utm36n()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.geom_wgs84 IS DISTINCT FROM OLD.geom_wgs84 THEN
    NEW.geom_utm36n := CASE WHEN NEW.geom_wgs84 IS NOT NULL
                            THEN ST_Transform(NEW.geom_wgs84, 32636)
                       END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cadastrals_utm36n
  BEFORE INSERT OR UPDATE OF geom_wgs84 ON cadastrals
  FOR EACH ROW EXECUTE FUNCTION public.cadastrals_sync_utm36n();

-- RPC cadastrals_geojson (ссылки geom → geom_wgs84)
CREATE OR REPLACE FUNCTION public.cadastrals_geojson(
    p_ownership text DEFAULT 'all',
    p_seizure text DEFAULT 'all'
)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH cad_own_geom AS (
    SELECT cad.id, cad.cadastral_number, cad.address, cad.category,
      cad.vri, cad.ownership, cad.ownership_raw, cad.area_m2,
      cad.is_seizure, cad.seizure_area_m2, cad.vri_changes,
      cad.source, cad.cadastral_cost, cad.area_inaccuracy,
      cad.category_code, cad.subtype_code, cad.cad_quarter, cad.in_project,
      cad.geom_wgs84 AS geom
    FROM cadastrals cad
    WHERE cad.active = true AND cad.geom_wgs84 IS NOT NULL
      AND (p_ownership = 'all' OR cad.ownership::text = p_ownership)
      AND (p_seizure = 'all'
           OR (p_seizure = 'seizure' AND cad.is_seizure = true)
           OR (p_seizure = 'kept' AND cad.is_seizure = false))
  ),
  cad_plot_geom AS (
    SELECT cad.id, cad.cadastral_number, cad.address, cad.category,
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
    WHERE cad.active = true AND cad.geom_wgs84 IS NULL
      AND (p_ownership = 'all' OR cad.ownership::text = p_ownership)
      AND (p_seizure = 'all'
           OR (p_seizure = 'seizure' AND cad.is_seizure = true)
           OR (p_seizure = 'kept' AND cad.is_seizure = false))
    GROUP BY cad.id
  ),
  combined AS (
    SELECT * FROM cad_own_geom UNION ALL SELECT * FROM cad_plot_geom
  ),
  features AS (
    SELECT jsonb_build_object(
      'type', 'Feature', 'id', cadastral_number,
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'cadastral_id', id, 'cadastral_number', cadastral_number,
        'address', address, 'category', category, 'vri', vri,
        'ownership', ownership, 'ownership_raw', ownership_raw,
        'area_m2', area_m2, 'is_seizure', is_seizure,
        'seizure_area_m2', seizure_area_m2,
        'vri_changes', coalesce(vri_changes, '[]'::jsonb),
        'source', source, 'cadastral_cost', cadastral_cost,
        'area_inaccuracy', area_inaccuracy, 'category_code', category_code,
        'subtype_code', subtype_code, 'cad_quarter', cad_quarter,
        'in_project', in_project
      )
    ) AS feature
    FROM combined WHERE geom IS NOT NULL AND ST_IsValid(geom)
  )
  SELECT jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  FROM features;
$$;

-- RPC upsert_cadastral_from_kpt (ссылки geom → geom_wgs84)
CREATE OR REPLACE FUNCTION public.upsert_cadastral_from_kpt(
    p_cadastral_number text,
    p_address text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_vri text DEFAULT NULL,
    p_area_m2 numeric DEFAULT NULL,
    p_cadastral_cost numeric DEFAULT NULL,
    p_area_inaccuracy numeric DEFAULT NULL,
    p_category_code text DEFAULT NULL,
    p_subtype_code text DEFAULT NULL,
    p_cad_quarter text DEFAULT NULL,
    p_wkt text DEFAULT NULL,
    p_srid integer DEFAULT 970634
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid;
    v_action text;
    v_geom geometry(MultiPolygon, 4326);
BEGIN
    IF p_wkt IS NOT NULL AND p_wkt <> '' THEN
        v_geom := ST_Multi(ST_Transform(ST_GeomFromText(p_wkt, p_srid), 4326));
    END IF;

    SELECT id INTO v_id FROM cadastrals WHERE cadastral_number = p_cadastral_number;

    IF v_id IS NOT NULL THEN
        UPDATE cadastrals SET
            address         = COALESCE(address, p_address),
            category        = COALESCE(category, p_category),
            vri             = COALESCE(vri, p_vri),
            area_m2         = COALESCE(area_m2, p_area_m2),
            cadastral_cost  = COALESCE(p_cadastral_cost, cadastral_cost),
            area_inaccuracy = COALESCE(p_area_inaccuracy, area_inaccuracy),
            category_code   = COALESCE(p_category_code, category_code),
            subtype_code    = COALESCE(p_subtype_code, subtype_code),
            cad_quarter     = COALESCE(p_cad_quarter, cad_quarter),
            geom_wgs84      = COALESCE(v_geom, geom_wgs84),
            updated_at      = now()
        WHERE id = v_id;
        v_action := 'updated';
    ELSE
        INSERT INTO cadastrals (
            cadastral_number, address, category, vri, area_m2,
            cadastral_cost, area_inaccuracy, category_code,
            subtype_code, cad_quarter,
            source, in_project, active, geom_wgs84
        ) VALUES (
            p_cadastral_number, p_address, p_category, p_vri, p_area_m2,
            p_cadastral_cost, p_area_inaccuracy, p_category_code,
            p_subtype_code, p_cad_quarter,
            'kpt_xml', false, true, v_geom
        )
        RETURNING id INTO v_id;
        v_action := 'created';
    END IF;

    RETURN jsonb_build_object('id', v_id, 'action', v_action, 'has_geom', (v_geom IS NOT NULL));
END;
$$;

-- View v_cadastrals_full
DROP VIEW IF EXISTS public.v_cadastrals_full CASCADE;
CREATE VIEW public.v_cadastrals_full AS
SELECT cad.id, cad.cadastral_number, cad.address, cad.category, cad.vri,
    cad.ownership_raw, cad.ownership, cad.area_m2, cad.status,
    cad.is_seizure, cad.seizure_area_m2, cad.seizure_dpt_no, cad.seizure_note,
    cad.seizure_building_kn, cad.seizure_building_area, cad.vri_changes,
    cad.source, cad.source_page, cad.source_id,
    cad.cadastral_cost, cad.area_inaccuracy, cad.category_code,
    cad.subtype_code, cad.cad_quarter, cad.in_project,
    cad.active, cad.created_at, cad.updated_at,
    (cad.geom_wgs84 IS NOT NULL) AS has_geom,
    COALESCE(pc.plot_count, 0::bigint) AS linked_plots_count,
    COALESCE(pc.plot_codes, '{}'::text[]) AS linked_plot_codes
  FROM cadastrals cad
  LEFT JOIN LATERAL (
    SELECT count(*) AS plot_count,
      array_agg(p.code ORDER BY p.code) AS plot_codes
    FROM plot_cadastrals pcl JOIN plots p ON p.id = pcl.plot_id
    WHERE pcl.cadastral_id = cad.id
  ) pc ON true;

GRANT SELECT ON public.v_cadastrals_full TO anon, authenticated;

-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ 3. gis_* views — добавить geom_utm36n                       ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- ── gis_plots ────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_plots CASCADE;
CREATE VIEW public.gis_plots AS
WITH current_assignment AS (
  SELECT DISTINCT ON (plot_polygon_assignments.plot_id)
    plot_polygon_assignments.plot_id,
    plot_polygon_assignments.boundary_type,
    plot_polygon_assignments.version_in_type,
    plot_polygon_assignments.valid_from
  FROM plot_polygon_assignments
  WHERE plot_polygon_assignments.valid_to IS NULL
  ORDER BY plot_polygon_assignments.plot_id,
    plot_polygon_assignments.valid_from DESC,
    plot_polygon_assignments.boundary_type DESC
), plot_geom AS (
  SELECT p_1.id AS plot_id,
    st_multi(st_collect(pp.geom_4326 ORDER BY ppa.sequence_no)) AS geom_4326,
    st_multi(st_collect(pp.geom ORDER BY ppa.sequence_no)) AS geom_sk63,
    sum(pp.area_calc_m2) AS area_m2,
    count(pp.id) AS polygon_count
  FROM plots p_1
    JOIN plot_polygon_assignments ppa ON ppa.plot_id = p_1.id AND ppa.valid_to IS NULL
    JOIN plot_polygons pp ON pp.id = ppa.polygon_id
  WHERE p_1.active = true
  GROUP BY p_1.id
), plot_objs AS (
  SELECT p_1.id AS plot_id,
    string_agg(DISTINCT o.code, ', '::text ORDER BY o.code) AS objects_csv,
    count(DISTINCT o.id) AS objects_count
  FROM plots p_1
    LEFT JOIN objects o ON o.id = p_1.object_id
      OR p_1.object_id IS NULL AND (o.id IN (
        SELECT foo.object_id FROM functional_object_objects foo
        WHERE foo.functional_object_id = p_1.functional_object_id))
  GROUP BY p_1.id
), loads_pivot AS (
  SELECT v_engineering_loads_by_functional.functional_object_id,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'water') AS load_water,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'sewer') AS load_sewer,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'storm') AS load_storm,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'heat') AS load_heat,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'gas') AS load_gas,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'power') AS load_power,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'telecom') AS load_telecom,
    string_agg(((v_engineering_loads_by_functional.network::text || ':') || v_engineering_loads_by_functional.total_load::text) || COALESCE(' ' || v_engineering_loads_by_functional.units, ''), ' / ' ORDER BY v_engineering_loads_by_functional.network::text) AS loads_summary
  FROM v_engineering_loads_by_functional
  GROUP BY v_engineering_loads_by_functional.functional_object_id
), loads_pivot_plot AS (
  SELECT engineering_loads.plot_id,
    sum(engineering_loads.load_value) FILTER (WHERE engineering_loads.network::text = 'water') AS load_water_plot,
    sum(engineering_loads.load_value) FILTER (WHERE engineering_loads.network::text = 'sewer') AS load_sewer_plot,
    sum(engineering_loads.load_value) FILTER (WHERE engineering_loads.network::text = 'storm') AS load_storm_plot,
    sum(engineering_loads.load_value) FILTER (WHERE engineering_loads.network::text = 'heat') AS load_heat_plot,
    sum(engineering_loads.load_value) FILTER (WHERE engineering_loads.network::text = 'gas') AS load_gas_plot,
    sum(engineering_loads.load_value) FILTER (WHERE engineering_loads.network::text = 'power') AS load_power_plot
  FROM engineering_loads
  WHERE engineering_loads.plot_id IS NOT NULL
  GROUP BY engineering_loads.plot_id
)
SELECT row_number() OVER (ORDER BY p.code)::integer AS objectid,
  p.id, p.code, p.name, p.role::text AS role, p.cadastral_number, p.permitted_use,
  fo.zone_code AS functional_zone_code, fo.name AS functional_name, fo.kind::text AS functional_kind,
  COALESCE(po.objects_csv, '') AS objects_csv,
  COALESCE(po.objects_count, 0)::integer AS objects_count,
  ca.boundary_type AS current_boundary_type, ca.version_in_type AS current_version,
  pg.area_m2, pg.polygon_count::integer AS polygon_count,
  lp.load_water, lp.load_sewer, lp.load_storm, lp.load_heat, lp.load_gas, lp.load_power, lp.load_telecom,
  COALESCE(lp.loads_summary, '') AS loads_summary,
  lpp.load_water_plot, lpp.load_sewer_plot, lpp.load_storm_plot,
  lpp.load_heat_plot, lpp.load_gas_plot, lpp.load_power_plot,
  pg.geom_4326 AS geom_wgs84,
  pg.geom_sk63,
  ST_Transform(pg.geom_4326, 32636) AS geom_utm36n
FROM plots p
  LEFT JOIN functional_objects fo ON fo.id = p.functional_object_id
  LEFT JOIN current_assignment ca ON ca.plot_id = p.id
  JOIN plot_geom pg ON pg.plot_id = p.id
  LEFT JOIN plot_objs po ON po.plot_id = p.id
  LEFT JOIN loads_pivot lp ON lp.functional_object_id = p.functional_object_id
  LEFT JOIN loads_pivot_plot lpp ON lpp.plot_id = p.id
WHERE p.active = true;

GRANT SELECT ON public.gis_plots TO anon, authenticated, arcgis_writer;

-- ── gis_objects ──────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_objects CASCADE;
CREATE VIEW public.gis_objects AS
WITH obj_plots AS (
  SELECT obj_id.obj_id AS object_id,
    v.plot_id,
    v.geom_4326_multi AS geom_4326,
    v.geom_sk63_multi AS geom_sk63,
    v.area_calc_m2
  FROM v_plots_current v,
    LATERAL unnest(v.effective_object_ids) obj_id(obj_id)
  WHERE v.geom_4326_multi IS NOT NULL
), obj_geom AS (
  SELECT obj_plots.object_id,
    st_multi(st_union(obj_plots.geom_4326)) AS geom_4326,
    st_multi(st_union(obj_plots.geom_sk63)) AS geom_sk63,
    sum(obj_plots.area_calc_m2) AS area_m2,
    count(DISTINCT obj_plots.plot_id)::integer AS plots_count
  FROM obj_plots
  GROUP BY obj_plots.object_id
)
SELECT row_number() OVER (ORDER BY o.code)::integer AS objectid,
  o.id, o.code, o.current_name AS name, o.contractor, o.color,
  COALESCE(og.plots_count, 0) AS plots_count,
  COALESCE(og.area_m2, 0::numeric) AS area_m2,
  og.geom_4326 AS geom_wgs84,
  og.geom_sk63,
  ST_Transform(og.geom_4326, 32636) AS geom_utm36n
FROM objects o
  LEFT JOIN obj_geom og ON og.object_id = o.id
WHERE o.active = true AND og.geom_4326 IS NOT NULL;

GRANT SELECT ON public.gis_objects TO anon, authenticated, arcgis_writer;

-- ── gis_functional_zones ─────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_functional_zones CASCADE;
CREATE VIEW public.gis_functional_zones AS
WITH zone_objs AS (
  SELECT foo.functional_object_id,
    string_agg(o.code, ', ' ORDER BY o.code) AS objects_csv,
    count(o.id)::integer AS objects_count
  FROM functional_object_objects foo JOIN objects o ON o.id = foo.object_id
  GROUP BY foo.functional_object_id
), zone_geom AS (
  SELECT fo_1.id AS functional_object_id,
    st_multi(st_union(pp.geom_4326)) AS geom_4326,
    st_multi(st_union(pp.geom)) AS geom_sk63,
    sum(pp.area_calc_m2) AS area_m2,
    count(DISTINCT p.id)::integer AS plots_count
  FROM functional_objects fo_1
    JOIN plots p ON p.functional_object_id = fo_1.id AND p.active = true
    JOIN plot_polygon_assignments ppa ON ppa.plot_id = p.id AND ppa.valid_to IS NULL
    JOIN plot_polygons pp ON pp.id = ppa.polygon_id
  WHERE fo_1.active = true
  GROUP BY fo_1.id
), zone_loads AS (
  SELECT v_engineering_loads_by_functional.functional_object_id,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'water') AS load_water,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'sewer') AS load_sewer,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'storm') AS load_storm,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'heat') AS load_heat,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'gas') AS load_gas,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'power') AS load_power,
    max(v_engineering_loads_by_functional.total_load) FILTER (WHERE v_engineering_loads_by_functional.network::text = 'telecom') AS load_telecom,
    string_agg(((v_engineering_loads_by_functional.network::text || ':') || v_engineering_loads_by_functional.total_load::text) || COALESCE(' ' || v_engineering_loads_by_functional.units, ''), ' / ' ORDER BY v_engineering_loads_by_functional.network::text) AS loads_summary
  FROM v_engineering_loads_by_functional
  GROUP BY v_engineering_loads_by_functional.functional_object_id
)
SELECT row_number() OVER (ORDER BY fo.zone_code)::integer AS objectid,
  fo.id, fo.zone_code, fo.name AS zone_name, fo.kind::text AS kind, fo.queue,
  COALESCE(zo.objects_csv, '') AS objects_csv,
  COALESCE(zo.objects_count, 0) AS objects_count,
  zl.load_water, zl.load_sewer, zl.load_storm, zl.load_heat, zl.load_gas, zl.load_power, zl.load_telecom,
  COALESCE(zl.loads_summary, '') AS loads_summary,
  zg.area_m2, zg.plots_count,
  zg.geom_4326 AS geom_wgs84,
  zg.geom_sk63,
  ST_Transform(zg.geom_4326, 32636) AS geom_utm36n
FROM functional_objects fo
  LEFT JOIN zone_objs zo ON zo.functional_object_id = fo.id
  LEFT JOIN zone_loads zl ON zl.functional_object_id = fo.id
  JOIN zone_geom zg ON zg.functional_object_id = fo.id
WHERE fo.active = true;

GRANT SELECT ON public.gis_functional_zones TO anon, authenticated, arcgis_writer;

-- ── gis_object_polygons ──────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_object_polygons CASCADE;
CREATE VIEW public.gis_object_polygons AS
SELECT row_number() OVER (ORDER BY og.created_at, og.id)::integer AS objectid,
  og.id, og.object_id, o.code AS object_code, o.current_name AS object_name,
  og.kind::text AS kind, og.name, og.source, og.properties, og.valid_from,
  st_multi(og.geom_4326)::geometry(MultiPolygon,4326) AS geom_wgs84,
  st_multi(og.geom)::geometry(MultiPolygon,970634) AS geom_sk63,
  st_multi(st_transform(og.geom_4326, 32636))::geometry(MultiPolygon,32636) AS geom_utm36n
FROM object_geometries og
  LEFT JOIN objects o ON o.id = og.object_id
WHERE (og.kind = ANY (ARRAY['building'::geometry_kind, 'zone'::geometry_kind, 'other'::geometry_kind]))
  AND og.valid_to IS NULL
  AND (geometrytype(og.geom) = ANY (ARRAY['POLYGON', 'MULTIPOLYGON']));

GRANT SELECT ON public.gis_object_polygons TO anon, authenticated, arcgis_writer;

-- ── gis_object_lines ─────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_object_lines CASCADE;
CREATE VIEW public.gis_object_lines AS
SELECT row_number() OVER (ORDER BY og.created_at, og.id)::integer AS objectid,
  og.id, og.object_id, o.code AS object_code, o.current_name AS object_name,
  og.kind::text AS kind, og.name, og.source, og.properties, og.valid_from,
  st_multi(og.geom_4326)::geometry(MultiLineString,4326) AS geom_wgs84,
  st_multi(og.geom)::geometry(MultiLineString,970634) AS geom_sk63,
  st_multi(st_transform(og.geom_4326, 32636))::geometry(MultiLineString,32636) AS geom_utm36n
FROM object_geometries og
  LEFT JOIN objects o ON o.id = og.object_id
WHERE (og.kind = ANY (ARRAY['road'::geometry_kind, 'utility_line'::geometry_kind]))
  AND og.valid_to IS NULL
  AND (geometrytype(og.geom) = ANY (ARRAY['LINESTRING', 'MULTILINESTRING']));

GRANT SELECT ON public.gis_object_lines TO anon, authenticated, arcgis_writer;

-- ── gis_object_points ────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_object_points CASCADE;
CREATE VIEW public.gis_object_points AS
SELECT row_number() OVER (ORDER BY og.created_at, og.id)::integer AS objectid,
  og.id, og.object_id, o.code AS object_code, o.current_name AS object_name,
  og.kind::text AS kind, og.name, og.source, og.properties, og.valid_from,
  st_multi(og.geom_4326)::geometry(MultiPoint,4326) AS geom_wgs84,
  st_multi(og.geom)::geometry(MultiPoint,970634) AS geom_sk63,
  st_multi(st_transform(og.geom_4326, 32636))::geometry(MultiPoint,32636) AS geom_utm36n
FROM object_geometries og
  LEFT JOIN objects o ON o.id = og.object_id
WHERE (og.kind = ANY (ARRAY['utility_node'::geometry_kind, 'point'::geometry_kind]))
  AND og.valid_to IS NULL
  AND (geometrytype(og.geom) = ANY (ARRAY['POINT', 'MULTIPOINT']));

GRANT SELECT ON public.gis_object_points TO anon, authenticated, arcgis_writer;

-- ── gis_raster_footprints ────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_raster_footprints CASCADE;
CREATE VIEW public.gis_raster_footprints AS
SELECT row_number() OVER (ORDER BY rl.captured_at, rl.created_at)::integer AS objectid,
  rl.id, rl.object_id, o.code AS object_code,
  rl.title, rl.kind, rl.storage_url, rl.resolution_m, rl.captured_at,
  rl.z_min, rl.z_max, rl.z_unit, rl.colormap,
  st_multi(rl.bbox_wgs84)::geometry(MultiPolygon,4326) AS geom_wgs84,
  st_multi(rl.bbox)::geometry(MultiPolygon,970634) AS geom_sk63,
  st_multi(st_transform(rl.bbox_wgs84, 32636))::geometry(MultiPolygon,32636) AS geom_utm36n
FROM raster_layers rl
  LEFT JOIN objects o ON o.id = rl.object_id
WHERE rl.bbox IS NOT NULL;

GRANT SELECT ON public.gis_raster_footprints TO anon, authenticated, arcgis_writer;

-- ── gis_cadastrals ───────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_cadastrals CASCADE;
CREATE VIEW public.gis_cadastrals AS
SELECT row_number() OVER (ORDER BY cadastral_number)::integer AS objectid,
  id, cadastral_number, address, category, category_code, vri,
  ownership::text AS ownership, ownership_raw, source::text AS source,
  is_seizure, seizure_area_m2, area_m2 AS area_declared_m2,
  cadastral_cost, status, active,
  geom_wgs84,
  st_multi(st_transform(geom_wgs84, 970634)) AS geom_sk63,
  geom_utm36n
FROM cadastrals
WHERE active = true AND geom_wgs84 IS NOT NULL;

GRANT SELECT ON public.gis_cadastrals TO anon, authenticated, arcgis_writer;
