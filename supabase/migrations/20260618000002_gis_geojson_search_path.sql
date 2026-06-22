-- Фикс 500 на GIS-эндпоинтах (/api/reports/map/geojson, /plots/map и др.).
--
-- Причина: GIS-RPC, отдающие GeoJSON, зовут PostGIS-функции (ST_AsGeoJSON,
-- ST_Union, ST_Multi, …) БЕЗ квалификации схемой. После переноса стека на
-- сервер PostGIS живёт в схеме `extensions`, а PostgREST (роли service_role /
-- authenticator) выполняет запросы с search_path БЕЗ `extensions`:
--   ERROR: function st_asgeojson(extensions.geometry) does not exist
-- Под `postgres` они работали (его search_path включает extensions), поэтому
-- проблема видна только через API.
--
-- Решение: закрепить search_path на уровне самих функций (public, extensions),
-- не переписывая их тела. Идемпотентно (повторный ALTER просто переустановит).
ALTER FUNCTION public.project_boundary_geojson()        SET search_path = public, extensions;
ALTER FUNCTION public.functional_objects_geojson(text)  SET search_path = public, extensions;
ALTER FUNCTION public.cadastrals_geojson(text, text)    SET search_path = public, extensions;
ALTER FUNCTION public.plots_geojson(text)               SET search_path = public, extensions;
ALTER FUNCTION public.pmt_zu_geojson(text)              SET search_path = public, extensions;
ALTER FUNCTION public.get_object_geometries(uuid)       SET search_path = public, extensions;
