-- ============================================================
-- ZPR — ОТКАТ: восстановление оригинальных координат boundary
-- ============================================================
-- Миграции 000010 и 000011 изменили координаты hole1 (buffer).
-- Координаты pmt_boundary — НЕПРИКОСНОВЕННЫ (публичный документ).
-- Восстанавливаем полигон из оригинальных точек pmt_boundary.
-- Самопересечение hole1/exterior — артефакт исходных данных,
-- допустимый; визуальный фикс — на стороне клиента (ArcGIS/UI).
-- ============================================================

UPDATE project_boundary
SET
  geom_sk63 = rebuilt.geom_sk63,
  geom_wgs84 = ST_Transform(rebuilt.geom_sk63, 4326),
  geom_utm36n = ST_Transform(rebuilt.geom_sk63, 32636)
FROM (
  WITH ring1 AS (
    SELECT ST_MakeLine(
      array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id)
    ) AS line
    FROM pmt_boundary b WHERE b.id BETWEEN 1 AND 290
  ),
  ring2_pts AS (
    SELECT array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id) AS pts
    FROM pmt_boundary b WHERE b.id BETWEEN 291 AND 297
  ),
  ring2 AS (
    SELECT ST_MakeLine(
      pts || pts[1:1]  -- замыкаем кольцо
    ) AS line FROM ring2_pts
  ),
  ring3_pts AS (
    SELECT array_agg(ST_SetSRID(ST_MakePoint(b.y, b.x), 970634) ORDER BY b.id) AS pts
    FROM pmt_boundary b WHERE b.id BETWEEN 298 AND 307
  ),
  ring3 AS (
    SELECT ST_MakeLine(
      pts || pts[1:1]  -- замыкаем кольцо
    ) AS line FROM ring3_pts
  )
  SELECT ST_SetSRID(
    ST_MakePolygon(
      (SELECT line FROM ring1),
      ARRAY[
        (SELECT line FROM ring2),
        (SELECT line FROM ring3)
      ]
    ),
    970634
  ) AS geom_sk63
) AS rebuilt;
