-- Фаза 1 импорта ПМТ — UPSERT functional_objects из pmt_zu_objects.
--
-- См. [[29_Сущность_Участок]] раздел «Импорт из ПМТ — Этап 1» и [[32_План_импорта_ПМТ]] Фаза 1.
--
-- Принципы:
--   * Одна запись functional_objects на уникальный zone_code.
--   * kind определяется маппингом префикса (Г-/К-/ТИ-/С-/...).
--   * object_id здесь НЕ заполняется — будет на этапе ОКС-маппинга (Фаза 2).
--   * source_document_id — Том 1.2 ППТ (a0000001-...-0003).
--
-- Идемпотентность: ON CONFLICT (zone_code) DO UPDATE — атрибуты обновляются,
-- id сохраняется → связи с plots не ломаются при перезапуске.

INSERT INTO functional_objects
    (zone_code, queue, kind, name, source_pmt_object_name, source_document_id)
SELECT DISTINCT ON (pzo.zone_code)
    pzo.zone_code,
    pzo.queue,
    CASE
        WHEN pzo.zone_code LIKE 'Г-%'  THEN 'hotel'
        WHEN pzo.zone_code LIKE 'К-%'  THEN 'hotel'
        WHEN pzo.zone_code LIKE 'Т-%'  THEN 'transit_hotel'
        WHEN pzo.zone_code LIKE 'С-%'  THEN 'sport_entertainment'
        WHEN pzo.zone_code LIKE 'О-%'  THEN 'food'
        WHEN pzo.zone_code LIKE 'ТИ-%' THEN 'transport_infra'
        WHEN pzo.zone_code LIKE 'Х-%'  THEN 'utility'
        WHEN pzo.zone_code LIKE 'Н-%'  THEN 'promenade'
        WHEN pzo.zone_code LIKE 'P-%'  THEN 'energy'  -- латинская P (как в ПМТ)
        WHEN pzo.zone_code LIKE 'Р-%'  THEN 'energy'  -- кириллическая Р на случай
        ELSE 'other'
    END::functional_object_kind                                AS kind,
    COALESCE(pzo.object_name, pzo.zone_code)                   AS name,
    pzo.object_name                                            AS source_pmt_object_name,
    'a0000001-0000-0000-0000-000000000003'::uuid               AS source_document_id
FROM pmt_zu_objects pzo
WHERE pzo.zone_code IS NOT NULL
ORDER BY pzo.zone_code, pzo.object_name DESC NULLS LAST
ON CONFLICT (zone_code) DO UPDATE SET
    queue                  = EXCLUDED.queue,
    kind                   = EXCLUDED.kind,
    name                   = EXCLUDED.name,
    source_pmt_object_name = EXCLUDED.source_pmt_object_name,
    source_document_id     = EXCLUDED.source_document_id,
    updated_at             = now();
