-- ============================================================
-- ZPR — Чистка грантов arcgis_writer
-- ============================================================
-- ArcGIS Pro показывает ВСЕ таблицы с геометрией, на которые
-- есть SELECT. Сырые таблицы (object_geometries, project_boundary,
-- raster_layers и т.д.) дублируют gis_* views — убираем.
-- Оставляем ТОЛЬКО gis_* views + справочные таблицы без геометрий.
-- ============================================================

-- ── Убираем SELECT с таблиц, имеющих геометрию (дублируют gis_*) ──
REVOKE SELECT ON object_geometries       FROM arcgis_writer;
REVOKE SELECT ON object_geometry_revisions FROM arcgis_writer;
REVOKE SELECT ON project_boundary        FROM arcgis_writer;
REVOKE SELECT ON raster_layers           FROM arcgis_writer;
REVOKE SELECT ON mesh_assets             FROM arcgis_writer;

-- ── Убираем SELECT со справочных таблиц (не нужны в ArcGIS) ──
REVOKE SELECT ON objects                 FROM arcgis_writer;
REVOKE SELECT ON contractors             FROM arcgis_writer;
REVOKE SELECT ON contract_milestones     FROM arcgis_writer;
REVOKE SELECT ON documents               FROM arcgis_writer;
REVOKE SELECT ON letters                 FROM arcgis_writer;
REVOKE SELECT ON folders                 FROM arcgis_writer;
REVOKE SELECT ON utility_loads           FROM arcgis_writer;
REVOKE SELECT ON v_documents_current     FROM arcgis_writer;
REVOKE SELECT ON functional_object_objects FROM arcgis_writer;
REVOKE SELECT ON masterplan_objects      FROM arcgis_writer;
REVOKE SELECT ON masterplan_object_plots FROM arcgis_writer;
REVOKE SELECT ON masterplan_object_objects FROM arcgis_writer;
REVOKE SELECT ON masterplan_object_functional_objects FROM arcgis_writer;
REVOKE SELECT ON masterplan_object_metrics FROM arcgis_writer;
REVOKE SELECT ON masterplan_metric_codes FROM arcgis_writer;

-- ── Убираем INSERT/UPDATE/DELETE с object_geometries ──
-- (редактирование геометрии из ArcGIS — пока не нужно)
REVOKE INSERT, UPDATE, DELETE ON object_geometries FROM arcgis_writer;
REVOKE INSERT ON object_geometry_revisions FROM arcgis_writer;

-- ── Итого arcgis_writer видит только: ──
-- gis_plots, gis_objects, gis_functional_zones, gis_cadastrals,
-- gis_object_polygons, gis_object_lines, gis_object_points,
-- gis_raster_footprints, gis_project_boundary
