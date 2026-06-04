-- ============================================================
-- ZPR — переименование srtext SRID 970634 → SK63_zone_4
-- ============================================================
-- ArcGIS Pro сопоставляет систему координат по тексту WKT (spatial_ref_sys.srtext).
-- У пользователя рабочая СК называется "SK63_zone_4" (под ней сделаны DWG/проекты),
-- а в БД srtext был записан как "Pulkovo_1942_CS63_zone_X4_RUS".
--
-- Параметры проекции ИДЕНТИЧНЫ (TMerc, lon0=32.5, x0=4300000, y0=-9214.69,
-- Krassowsky 1940) — отличались только подписи PROJCS/GEOGCS/DATUM/SPHEROID.
-- Поэтому переписываем только srtext: координаты не меняются, SRID остаётся 970634.
--
-- proj4text НЕ трогаем — он содержит towgs84 и используется ST_Transform()
-- для generated-колонок geom_4326 (веб-карта). Менять его нельзя.
--
-- Зеркальный UPDATE для БД zpr_gis (у неё собственный spatial_ref_sys)
-- выполняется отдельно — см. комментарий в конце файла.
-- ============================================================

update spatial_ref_sys
   set srtext = 'PROJCS["SK63_zone_4",GEOGCS["Pulkovo",DATUM["Pulkovo",SPHEROID["Krasovsky_1940",6378245.0,298.3]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",4300000.0],PARAMETER["False_Northing",-9214.69],PARAMETER["Central_Meridian",32.5],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
 where srid = 970634;

-- Зеркало для zpr_gis (выполнить вручную, т.к. эта БД вне db-migrate):
--   docker exec -i supabase_db_zpr_code psql -U supabase_admin -h localhost -d zpr_gis \
--     -c "update extensions.spatial_ref_sys set srtext = '...тот же WKT...' where srid = 970634;"
