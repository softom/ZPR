-- ============================================================
-- ZPR — фикс датума в srtext SRID 970634
-- ============================================================
-- Прошлая миграция 20260526000011 записала srtext из пользовательского .prj
-- SK63_zone_4, где GEOGCS/DATUM = кастомные "Pulkovo" (Authority Custom, WKID 0).
-- ArcGIS не знает трансформаций такого датума на WGS84 → слой "улетает" на
-- мировой подложке (Средиземное море).
--
-- Возвращаем правильную географическую основу — Pulkovo 1942 (EPSG:4284),
-- датум D_Pulkovo_1942 — для него ArcGIS/proj знают трансформации на WGS84.
-- Имя PROJCS оставляем "SK63_zone_4" (узнаваемое для пользователя),
-- параметры проекции не меняем (32.5 / 4 300 000 / -9 214.69 / Krasovsky 1940).
--
-- proj4text НЕ трогаем (towgs84 уже корректный). Координаты не меняются —
-- правится только текст описания СК.
--
-- Зеркальный UPDATE для zpr_gis — см. конец файла (выполнить вручную).
-- ============================================================

update spatial_ref_sys
   set srtext = 'PROJCS["SK63_zone_4",GEOGCS["GCS_Pulkovo_1942",DATUM["D_Pulkovo_1942",SPHEROID["Krasovsky_1940",6378245.0,298.3]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",4300000.0],PARAMETER["False_Northing",-9214.69],PARAMETER["Central_Meridian",32.5],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
 where srid = 970634;

-- Зеркало для zpr_gis (выполнить вручную):
--   docker exec -i supabase_db_zpr_code psql -U supabase_admin -h localhost -d zpr_gis \
--     -c "update extensions.spatial_ref_sys set srtext = '...тот же WKT...' where srid = 970634;"
