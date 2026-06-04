-- ============================================================
-- ZPR — Явные SRID-касты для gis_* views
-- ============================================================
-- PostGIS не выводит SRID из CTE-агрегаций (st_multi, st_union,
-- st_collect). ArcGIS Pro пропускает geometry с SRID=0.
-- Исправление: явный каст ::geometry(Type, SRID) в финальном SELECT.
-- ============================================================

-- ── gis_plots ────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.gis_plots CASCADE;
CREATE VIEW public.gis_plots AS
WITH current_assignment AS (
  SELECT DISTINCT ON (ppa.plot_id)
    ppa.plot_id, ppa.boundary_type, ppa.version_in_type, ppa.valid_from
  FROM plot_polygon_assignments ppa
  WHERE ppa.valid_to IS NULL
  ORDER BY ppa.plot_id, ppa.valid_from DESC, ppa.boundary_type DESC
), plot_geom AS (
  SELECT p_1.id AS plot_id,
    st_multi(st_collect(pp.geom_4326 ORDER BY pa.sequence_no)) AS geom_4326,
    st_multi(st_collect(pp.geom ORDER BY pa.sequence_no)) AS geom_sk63,
    sum(pp.area_calc_m2) AS area_m2,
    count(pp.id) AS polygon_count
  FROM plots p_1
    JOIN plot_polygon_assignments pa ON pa.plot_id = p_1.id AND pa.valid_to IS NULL
    JOIN plot_polygons pp ON pp.id = pa.polygon_id
  WHERE p_1.active = true
  GROUP BY p_1.id
), plot_objs AS (
  SELECT p_1.id AS plot_id,
    string_agg(DISTINCT o.code, ', ' ORDER BY o.code) AS objects_csv,
    count(DISTINCT o.id) AS objects_count
  FROM plots p_1
    LEFT JOIN objects o ON o.id = p_1.object_id
      OR (p_1.object_id IS NULL AND o.id IN (
        SELECT foo.object_id FROM functional_object_objects foo
        WHERE foo.functional_object_id = p_1.functional_object_id))
  GROUP BY p_1.id
), loads_pivot AS (
  SELECT vel.functional_object_id,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'water') AS load_water,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'sewer') AS load_sewer,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'storm') AS load_storm,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'heat') AS load_heat,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'gas') AS load_gas,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'power') AS load_power,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'telecom') AS load_telecom,
    string_agg(((vel.network::text || ':') || vel.total_load::text) || COALESCE(' ' || vel.units, ''), ' / ' ORDER BY vel.network::text) AS loads_summary
  FROM v_engineering_loads_by_functional vel
  GROUP BY vel.functional_object_id
), loads_pivot_plot AS (
  SELECT el.plot_id,
    sum(el.load_value) FILTER (WHERE el.network::text = 'water') AS load_water_plot,
    sum(el.load_value) FILTER (WHERE el.network::text = 'sewer') AS load_sewer_plot,
    sum(el.load_value) FILTER (WHERE el.network::text = 'storm') AS load_storm_plot,
    sum(el.load_value) FILTER (WHERE el.network::text = 'heat') AS load_heat_plot,
    sum(el.load_value) FILTER (WHERE el.network::text = 'gas') AS load_gas_plot,
    sum(el.load_value) FILTER (WHERE el.network::text = 'power') AS load_power_plot
  FROM engineering_loads el
  WHERE el.plot_id IS NOT NULL
  GROUP BY el.plot_id
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
  pg.geom_4326::geometry(MultiPolygon, 4326) AS geom_wgs84,
  pg.geom_sk63::geometry(MultiPolygon, 970634) AS geom_sk63,
  st_transform(pg.geom_4326, 32636)::geometry(MultiPolygon, 32636) AS geom_utm36n
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
  SELECT op.object_id,
    st_multi(st_union(op.geom_4326)) AS geom_4326,
    st_multi(st_union(op.geom_sk63)) AS geom_sk63,
    sum(op.area_calc_m2) AS area_m2,
    count(DISTINCT op.plot_id)::integer AS plots_count
  FROM obj_plots op
  GROUP BY op.object_id
)
SELECT row_number() OVER (ORDER BY o.code)::integer AS objectid,
  o.id, o.code, o.current_name AS name, o.contractor, o.color,
  COALESCE(og.plots_count, 0) AS plots_count,
  COALESCE(og.area_m2, 0::numeric) AS area_m2,
  og.geom_4326::geometry(MultiPolygon, 4326) AS geom_wgs84,
  og.geom_sk63::geometry(MultiPolygon, 970634) AS geom_sk63,
  st_transform(og.geom_4326, 32636)::geometry(MultiPolygon, 32636) AS geom_utm36n
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
  SELECT vel.functional_object_id,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'water') AS load_water,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'sewer') AS load_sewer,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'storm') AS load_storm,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'heat') AS load_heat,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'gas') AS load_gas,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'power') AS load_power,
    max(vel.total_load) FILTER (WHERE vel.network::text = 'telecom') AS load_telecom,
    string_agg(((vel.network::text || ':') || vel.total_load::text) || COALESCE(' ' || vel.units, ''), ' / ' ORDER BY vel.network::text) AS loads_summary
  FROM v_engineering_loads_by_functional vel
  GROUP BY vel.functional_object_id
)
SELECT row_number() OVER (ORDER BY fo.zone_code)::integer AS objectid,
  fo.id, fo.zone_code, fo.name AS zone_name, fo.kind::text AS kind, fo.queue,
  COALESCE(zo.objects_csv, '') AS objects_csv,
  COALESCE(zo.objects_count, 0) AS objects_count,
  zl.load_water, zl.load_sewer, zl.load_storm, zl.load_heat, zl.load_gas, zl.load_power, zl.load_telecom,
  COALESCE(zl.loads_summary, '') AS loads_summary,
  zg.area_m2, zg.plots_count,
  zg.geom_4326::geometry(MultiPolygon, 4326) AS geom_wgs84,
  zg.geom_sk63::geometry(MultiPolygon, 970634) AS geom_sk63,
  st_transform(zg.geom_4326, 32636)::geometry(MultiPolygon, 32636) AS geom_utm36n
FROM functional_objects fo
  LEFT JOIN zone_objs zo ON zo.functional_object_id = fo.id
  LEFT JOIN zone_loads zl ON zl.functional_object_id = fo.id
  JOIN zone_geom zg ON zg.functional_object_id = fo.id
WHERE fo.active = true;

GRANT SELECT ON public.gis_functional_zones TO anon, authenticated, arcgis_writer;

-- ── gis_cadastrals (fix geom_sk63 SRID=0) ───────────────────────────────────
DROP VIEW IF EXISTS public.gis_cadastrals CASCADE;
CREATE VIEW public.gis_cadastrals AS
SELECT row_number() OVER (ORDER BY cadastral_number)::integer AS objectid,
  id, cadastral_number, address, category, category_code, vri,
  ownership::text AS ownership, ownership_raw, source::text AS source,
  is_seizure, seizure_area_m2, area_m2 AS area_declared_m2,
  cadastral_cost, status, active,
  geom_wgs84::geometry(MultiPolygon, 4326) AS geom_wgs84,
  st_multi(st_transform(geom_wgs84, 970634))::geometry(MultiPolygon, 970634) AS geom_sk63,
  geom_utm36n::geometry(MultiPolygon, 32636) AS geom_utm36n
FROM cadastrals
WHERE active = true AND geom_wgs84 IS NOT NULL;

GRANT SELECT ON public.gis_cadastrals TO anon, authenticated, arcgis_writer;
