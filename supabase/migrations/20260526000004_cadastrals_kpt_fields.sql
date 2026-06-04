-- ============================================================
-- ZPR — Расширение cadastrals полями из КПТ XML
-- ============================================================
-- Новые метаданные: кадастровая стоимость, погрешность площади,
-- код категории, подтип, кадастровый квартал.
-- Поле source — природа данных (откуда пришла запись).
-- Все участки из КПТ сохраняются, даже за пределами проекта.
-- ============================================================

-- ── Перечисление источников данных ──────────────────────────────────────────
CREATE TYPE public.cadastral_source AS ENUM (
  'pmt_ppt',     -- ПМТ / ППТ (исходная загрузка из pmt_cadastrals)
  'kpt_xml',     -- Архив кадастровых планов территорий, файлов ЕГРН
  'pkk',         -- Публичная кадастровая карта (API ПКК / НСПД)
  'manual'       -- Ручной ввод
);

-- ── Новые колонки ───────────────────────────────────────────────────────────
ALTER TABLE public.cadastrals
  ADD COLUMN IF NOT EXISTS source         cadastral_source NOT NULL DEFAULT 'pmt_ppt',
  ADD COLUMN IF NOT EXISTS cadastral_cost numeric,           -- кадастровая стоимость, руб.
  ADD COLUMN IF NOT EXISTS area_inaccuracy numeric,          -- погрешность определения площади, м²
  ADD COLUMN IF NOT EXISTS category_code  text,              -- код категории земель (003002000000 и т.п.)
  ADD COLUMN IF NOT EXISTS subtype_code   text,              -- код подтипа объекта (01=многоконтурный и т.п.)
  ADD COLUMN IF NOT EXISTS cad_quarter    text,              -- кадастровый квартал (90:18:010182)
  ADD COLUMN IF NOT EXISTS in_project     boolean NOT NULL DEFAULT true;  -- входит ли в границы проекта

COMMENT ON COLUMN public.cadastrals.source          IS 'Источник данных: pmt_ppt, kpt_xml, pkk, manual';
COMMENT ON COLUMN public.cadastrals.cadastral_cost   IS 'Кадастровая стоимость, руб. Из КПТ XML <cost><value>';
COMMENT ON COLUMN public.cadastrals.area_inaccuracy  IS 'Погрешность площади, м². Из КПТ XML <area><inaccuracy>';
COMMENT ON COLUMN public.cadastrals.category_code    IS 'Код категории земель (справочник Росреестра). Из КПТ XML <category><type><code>';
COMMENT ON COLUMN public.cadastrals.subtype_code     IS 'Код подтипа объекта (01=многоконтурный). Из КПТ XML <subtype><code>';
COMMENT ON COLUMN public.cadastrals.cad_quarter      IS 'Кадастровый квартал (90:18:010182). Вычисляется из cad_number.';
COMMENT ON COLUMN public.cadastrals.in_project       IS 'Входит ли участок в границы проекта ЗПР. false = данные из КПТ за пределами проекта.';

-- ── Заполнение cad_quarter для существующих записей ─────────────────────────
UPDATE cadastrals
SET cad_quarter = substring(cadastral_number FROM '^(\d+:\d+:\d+):')
WHERE cad_quarter IS NULL;

-- ── Индекс по кварталу ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cadastrals_quarter ON cadastrals (cad_quarter);

-- ── Обновлённый view — добавляем новые поля ─────────────────────────────────
DROP VIEW IF EXISTS public.v_cadastrals_full CASCADE;
CREATE VIEW public.v_cadastrals_full AS
SELECT cad.id,
    cad.cadastral_number,
    cad.address,
    cad.category,
    cad.vri,
    cad.ownership_raw,
    cad.ownership,
    cad.area_m2,
    cad.status,
    cad.is_seizure,
    cad.seizure_area_m2,
    cad.seizure_dpt_no,
    cad.seizure_note,
    cad.seizure_building_kn,
    cad.seizure_building_area,
    cad.vri_changes,
    cad.source,
    cad.source_page,
    cad.source_id,
    cad.cadastral_cost,
    cad.area_inaccuracy,
    cad.category_code,
    cad.subtype_code,
    cad.cad_quarter,
    cad.in_project,
    cad.active,
    cad.created_at,
    cad.updated_at,
    (cad.geom IS NOT NULL) AS has_geom,
    COALESCE(pc.plot_count, 0::bigint) AS linked_plots_count,
    COALESCE(pc.plot_codes, '{}'::text[]) AS linked_plot_codes
   FROM cadastrals cad
     LEFT JOIN LATERAL ( SELECT count(*) AS plot_count,
            array_agg(p.code ORDER BY p.code) AS plot_codes
           FROM plot_cadastrals pcl
             JOIN plots p ON p.id = pcl.plot_id
          WHERE pcl.cadastral_id = cad.id) pc ON true;
