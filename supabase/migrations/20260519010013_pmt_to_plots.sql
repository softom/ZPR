-- Фаза 1 импорта ПМТ — INSERT plots из pmt_zu.
--
-- Источник: pmt_zu (212 строк) + pmt_zu_objects (для functional_object_id).
-- Целевая модель: plots ([[29_Сущность_Участок]]).
--
-- Стратегия:
--   1) kind='участок' (119) → plots (role='plot') с functional_object_id из pmt_zu_objects
--   2) kind='сервитут' (18) → plots (role='servitude') с parent_plot_id
--   3) kind='контур' с parent_zu (66) → НЕ создают свой plots, polygon добавляется к родителю.
--      Но родителя нет в pmt_zu (только контуры!) — поэтому создаём «виртуальный» plots
--      для каждого уникального parent_zu (31 шт).
--   4) kind='контур' без parent_zu (9, кадастры типа `90:18:000000:104(1)`) — пока пропускаем.
--      TODO: импортировать после Фазы 5 (кадастры).
--
-- Идемпотентность: ON CONFLICT (code) DO NOTHING — при перезапуске не дублирует.

-- 1. Основные участки (kind='участок')
INSERT INTO plots
    (code, name, role, source_pmt_zu, area_declared_m2, permitted_use, category, functional_object_id)
SELECT
    pz.zu,
    COALESCE(pz.address, pz.zu),
    'plot'::plot_role,
    pz.zu,
    pz.area_m2_coords,
    pz.permitted_use,
    pz.category,
    (SELECT fo.id
       FROM functional_objects fo
       JOIN pmt_zu_objects pzo ON pzo.zone_code = fo.zone_code
      WHERE pzo.zu = pz.zu
      LIMIT 1)
FROM pmt_zu pz
WHERE pz.kind = 'участок'
ON CONFLICT (code) DO NOTHING;

-- 2. Виртуальные родители многоконтурных ЗУ (которых нет как kind='участок' в pmt_zu)
-- parent_zu (напр. ':ЗУ50') — есть только в виде ссылок из контуров.
INSERT INTO plots
    (code, name, role, source_pmt_zu, area_declared_m2, permitted_use, category, functional_object_id, note)
SELECT
    pz.parent_zu                                                       AS code,
    pz.parent_zu                                                       AS name,
    'plot'::plot_role,
    pz.parent_zu                                                       AS source_pmt_zu,
    SUM(pz.area_m2_coords)                                             AS area_declared_m2,
    (array_agg(pz.permitted_use) FILTER (WHERE pz.permitted_use IS NOT NULL))[1] AS permitted_use,
    (array_agg(pz.category)      FILTER (WHERE pz.category      IS NOT NULL))[1] AS category,
    (SELECT fo.id
       FROM functional_objects fo
       JOIN pmt_zu_objects pzo ON pzo.zone_code = fo.zone_code
      WHERE pzo.zu = pz.parent_zu
      LIMIT 1)                                                          AS functional_object_id,
    'Виртуальный родитель многоконтурного ЗУ (собран из контуров pmt_zu)' AS note
FROM pmt_zu pz
WHERE pz.kind = 'контур'
  AND pz.parent_zu IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM plots p WHERE p.code = pz.parent_zu)
GROUP BY pz.parent_zu
ON CONFLICT (code) DO NOTHING;

-- 3. Сервитуты (kind='сервитут') — после того как все основные plots созданы
INSERT INTO plots
    (code, name, role, source_pmt_zu, parent_plot_id, area_declared_m2, note)
SELECT
    pz.zu,
    COALESCE(pz.address, pz.zu),
    'servitude'::plot_role,
    pz.zu,
    (SELECT p.id FROM plots p WHERE p.code = pz.parent_zu),
    pz.area_m2_coords,
    -- Содержание сервитута берём из pmt_servituts если есть
    (SELECT s.content FROM pmt_servituts s WHERE s.zu = pz.zu LIMIT 1)
FROM pmt_zu pz
WHERE pz.kind = 'сервитут'
ON CONFLICT (code) DO NOTHING;
