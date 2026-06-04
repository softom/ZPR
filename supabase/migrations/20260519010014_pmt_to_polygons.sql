-- Фаза 1 импорта ПМТ — INSERT plot_polygons + plot_polygon_assignments из pmt_zu_points.
--
-- См. [[29_Сущность_Участок]] раздел «Импорт из ПМТ — Этап 3» и [[32_План_импорта_ПМТ]] Фаза 1.
--
-- Принципы:
--   * Один pmt_zu = один polygon (как Polygon, не MultiPolygon).
--   * Многоконтурные собираются в один plot через несколько assignments с разными sequence_no.
--   * WKT в OGC-порядке Y X (easting first); ST_GeomFromText(..., 970634).
--   * Невалидные геометрии (ST_IsValid=false) пропускаются — отдельно логируются в RAISE NOTICE.
--   * Точка-замыкание добавляется автоматически (первая повторяется в конце).
--
-- Привязка к plot:
--   * kind='участок' / 'сервитут' → plot.code = pmt_zu.zu
--   * kind='контур'              → plot.code = pmt_zu.parent_zu
--
-- Идемпотентность: проверка через NOT EXISTS на (plot_id, polygon_id) — при перезапуске
-- не создаются дубли. PK plot_polygons.id = uuid (auto), prev запуск распознать сложно,
-- поэтому используем дополнительную проверку через plot_polygon_assignments.

DO $$
DECLARE
    rec       RECORD;
    v_doc_id  uuid := 'a0000001-0000-0000-0000-000000000001'::uuid;  -- ПМТ Том 3.2
    v_valid   date := '2026-03-24'::date;                            -- doc_date Тома 3.2
    v_polygon uuid;
    v_plot    uuid;
    v_seq     smallint;
    v_imported int := 0;
    v_skipped_no_plot int := 0;
    v_skipped_invalid int := 0;
    v_skipped_dup int := 0;
BEGIN
    FOR rec IN
        SELECT
            pz.zu,
            pz.kind,
            pz.parent_zu,
            -- Собираем WKT POLYGON((y x, y x, ..., y x))
            -- с замыканием — первая точка повторяется в конце.
            'POLYGON((' || (
                SELECT string_agg(
                    p.y::text || ' ' || p.x::text,
                    ', '
                    ORDER BY CASE WHEN p.point_n ~ '^[0-9]+$' THEN p.point_n::int ELSE 9999 END
                )
                FROM pmt_zu_points p
                WHERE p.zu = pz.zu
            ) || ', ' || (
                SELECT p.y::text || ' ' || p.x::text
                FROM pmt_zu_points p
                WHERE p.zu = pz.zu
                ORDER BY CASE WHEN p.point_n ~ '^[0-9]+$' THEN p.point_n::int ELSE 9999 END
                LIMIT 1
            ) || '))' AS wkt
        FROM pmt_zu pz
        WHERE pz.points_count >= 3
        ORDER BY pz.zu
    LOOP
        -- Определяем целевой plot
        IF rec.kind IN ('участок', 'сервитут') THEN
            SELECT id INTO v_plot FROM plots WHERE code = rec.zu;
        ELSIF rec.kind = 'контур' THEN
            IF rec.parent_zu IS NULL THEN
                -- Контур без parent_zu (кадастр) — пока пропускаем (см. TODO в plots-миграции).
                v_skipped_no_plot := v_skipped_no_plot + 1;
                CONTINUE;
            END IF;
            SELECT id INTO v_plot FROM plots WHERE code = rec.parent_zu;
        ELSE
            v_skipped_no_plot := v_skipped_no_plot + 1;
            CONTINUE;
        END IF;

        IF v_plot IS NULL THEN
            RAISE NOTICE 'No plot found for %, kind=%, parent=%', rec.zu, rec.kind, rec.parent_zu;
            v_skipped_no_plot := v_skipped_no_plot + 1;
            CONTINUE;
        END IF;

        -- Проверяем валидность геометрии
        IF NOT ST_IsValid(ST_GeomFromText(rec.wkt, 970634)) THEN
            RAISE NOTICE 'Invalid geometry for %: %', rec.zu, ST_IsValidReason(ST_GeomFromText(rec.wkt, 970634));
            v_skipped_invalid := v_skipped_invalid + 1;
            CONTINUE;
        END IF;

        -- Проверка идемпотентности: если уже есть active assignment у этого plot
        -- с такой же sequence_no и тем же source_document_id — пропускаем.
        IF rec.kind = 'контур' THEN
            -- sequence_no для контура — извлекаем номер из '(N)'
            v_seq := COALESCE(
                substring(rec.zu FROM '\((\d+)\)')::smallint,
                1::smallint
            );
        ELSE
            v_seq := 1::smallint;
        END IF;

        IF EXISTS (
            SELECT 1 FROM plot_polygon_assignments
             WHERE plot_id = v_plot
               AND boundary_type = 'survey'
               AND sequence_no = v_seq
               AND source_document_id = v_doc_id
               AND valid_to IS NULL
        ) THEN
            v_skipped_dup := v_skipped_dup + 1;
            CONTINUE;
        END IF;

        -- INSERT polygon
        INSERT INTO plot_polygons (geom, note)
        VALUES (
            ST_GeomFromText(rec.wkt, 970634),
            'Импорт из pmt_zu_points для ' || rec.zu
        )
        RETURNING id INTO v_polygon;

        -- INSERT assignment
        INSERT INTO plot_polygon_assignments
            (plot_id, polygon_id, boundary_type, ring_role, sequence_no,
             version_in_type, source_document_id, valid_from, note)
        VALUES (
            v_plot, v_polygon, 'survey', 'outer', v_seq,
            1, v_doc_id, v_valid,
            CASE WHEN rec.kind = 'контур' THEN 'Контур ' || rec.zu ELSE NULL END
        );

        v_imported := v_imported + 1;
    END LOOP;

    RAISE NOTICE '======== pmt_to_polygons summary ========';
    RAISE NOTICE 'Imported polygons + assignments: %', v_imported;
    RAISE NOTICE 'Skipped (no plot):               %', v_skipped_no_plot;
    RAISE NOTICE 'Skipped (invalid geometry):      %', v_skipped_invalid;
    RAISE NOTICE 'Skipped (already exists):        %', v_skipped_dup;
END $$;
