-- ============================================================
-- ZPR — RPC для upsert кадастрового участка из КПТ XML
-- ============================================================
-- Вызывается из API при загрузке КПТ XML файлов.
-- Принимает метаданные + WKT-геометрию в исходной СК,
-- конвертирует через ST_Transform в 4326.
-- ============================================================

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
    p_wkt text DEFAULT NULL,          -- WKT POLYGON в исходной СК
    p_srid integer DEFAULT 970634     -- SRID исходной СК (по умолчанию СК-63 зона 4)
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_id uuid;
    v_action text;
    v_geom geometry(MultiPolygon, 4326);
BEGIN
    -- Конвертируем геометрию если передана
    IF p_wkt IS NOT NULL AND p_wkt <> '' THEN
        v_geom := ST_Multi(ST_Transform(ST_GeomFromText(p_wkt, p_srid), 4326));
    END IF;

    -- Ищем существующую запись
    SELECT id INTO v_id
    FROM cadastrals
    WHERE cadastral_number = p_cadastral_number;

    IF v_id IS NOT NULL THEN
        -- ОБНОВЛЕНИЕ: метаданные из ПМТ не затираем (COALESCE)
        UPDATE cadastrals SET
            address         = COALESCE(address, p_address),
            category        = COALESCE(category, p_category),
            vri             = COALESCE(vri, p_vri),
            area_m2         = COALESCE(area_m2, p_area_m2),
            -- Новые поля из XML всегда перезаписываем
            cadastral_cost  = COALESCE(p_cadastral_cost, cadastral_cost),
            area_inaccuracy = COALESCE(p_area_inaccuracy, area_inaccuracy),
            category_code   = COALESCE(p_category_code, category_code),
            subtype_code    = COALESCE(p_subtype_code, subtype_code),
            cad_quarter     = COALESCE(p_cad_quarter, cad_quarter),
            geom            = COALESCE(v_geom, geom),
            updated_at      = now()
        WHERE id = v_id;
        v_action := 'updated';
    ELSE
        -- СОЗДАНИЕ новой записи
        INSERT INTO cadastrals (
            cadastral_number, address, category, vri, area_m2,
            cadastral_cost, area_inaccuracy, category_code,
            subtype_code, cad_quarter,
            source, in_project, active, geom
        ) VALUES (
            p_cadastral_number, p_address, p_category, p_vri, p_area_m2,
            p_cadastral_cost, p_area_inaccuracy, p_category_code,
            p_subtype_code, p_cad_quarter,
            'kpt_xml', false, true, v_geom
        )
        RETURNING id INTO v_id;
        v_action := 'created';
    END IF;

    RETURN jsonb_build_object(
        'id', v_id,
        'action', v_action,
        'has_geom', (v_geom IS NOT NULL)
    );
END;
$$;

COMMENT ON FUNCTION public.upsert_cadastral_from_kpt IS
    'Upsert кадастрового участка из КПТ XML. Создаёт новые с source=kpt_xml/in_project=false, обновляет существующие.';
