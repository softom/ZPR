-- ============================================================
-- ZPR — ПМТ/ППТ ДОРОГА: таблицы для импорта данных PDF
-- ============================================================
-- Источник: 03_ППТ_ПМТ_ДОРОГА_ЗПР / Том 3.2 (ПМТ-ОЧ-ПЗ)
--   Приложение 1: образуемые/изменяемые ЗУ (270 строк)
--   Приложение 2: существующие ЗУ (153 строки)
--   Приложение 3: ЗУ с характеристиками застройки (145 строк)
--   Приложения 4-5: территории общего пользования (16 строк)
-- Координаты: Том 3.2 прил.6+ и Том 1.2 (7555 точек)
-- ============================================================

-- 1. Земельные участки ДОРОГА (все приложения)
CREATE TABLE IF NOT EXISTS public.pmt_doroga_plots (
  id              serial PRIMARY KEY,
  appendix        smallint NOT NULL,          -- 1,2,3,4,5
  row_num         integer,                     -- № п/п в PDF
  plot_num_plan   text,                        -- Номер ЗУ на плане: '68(1)', '80(2)', '204'
  cadastral_designation text,                  -- Кадастровый номер / обозначение: '90:18:010176:72:ЗУ1'
  address         text,                        -- Адрес (местоположение)
  area_egrn_m2    double precision,            -- Площадь исходного ЗУ по ЕГРН, кв.м
  area_formed_m2  double precision,            -- Площадь образуемого ЗУ, кв.м (или по кадастру)
  land_category       text,                    -- Категория земель (текущая)
  land_category_new   text,                    -- Устанавливаемая категория
  vri_current         text,                    -- ВРИ текущий
  vri_new             text,                    -- ВРИ устанавливаемый
  public_territory    text,                    -- Территория общего пользования
  formation_method    text,                    -- Способ образования / примечания
  storeys             text,                    -- Этажность (прил.2,3)
  area_preliminary_m2 double precision,        -- Предварительная площадь (прил.3)
  area_use_right_m2   double precision,        -- Площадь на праве пользования (прил.3)
  area_withdrawal_m2  double precision,        -- Площадь отторжения (прил.3)
  restrictions        text,                    -- Ограничения (прил.3)
  length_m            double precision,        -- Протяженность, пог.м (прил.4-5)
  object_type         text,                    -- Тип объекта (прил.4-5)
  created_at     timestamptz DEFAULT now()
);

COMMENT ON TABLE  public.pmt_doroga_plots IS 'ЗУ из ПМТ ДОРОГА (Том 3.2). Источник: PDF, парсер import_doroga_pdf.py';
COMMENT ON COLUMN public.pmt_doroga_plots.appendix IS '1=образуемые/изменяемые, 2=существующие, 3=с застройкой, 4=ТОП, 5=охраняемые';

-- 2. Координаты характерных точек (СК-63 зона 4)
CREATE TABLE IF NOT EXISTS public.pmt_doroga_coords (
  id         serial PRIMARY KEY,
  label      text NOT NULL,                    -- Метка участка: 'ЗУ68', 'road_boundary_p22'
  point_num  integer NOT NULL,                 -- № точки
  x          double precision NOT NULL,        -- X в СК-63 зона 4 (SRID 970634)
  y          double precision NOT NULL,        -- Y в СК-63 зона 4 (SRID 970634)
  page       integer                           -- Страница PDF
);

COMMENT ON TABLE  public.pmt_doroga_coords IS 'Координаты характерных точек ЗУ ДОРОГА (СК-63 зона 4). Источник: PDF Том 3.2 прил.6+ и Том 1.2';

-- Индексы
CREATE INDEX idx_pmt_doroga_plots_appendix ON public.pmt_doroga_plots(appendix);
CREATE INDEX idx_pmt_doroga_plots_cadastral ON public.pmt_doroga_plots(cadastral_designation);
CREATE INDEX idx_pmt_doroga_coords_label ON public.pmt_doroga_coords(label);

-- RLS / доступ
ALTER TABLE public.pmt_doroga_plots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pmt_doroga_coords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pmt_doroga_plots select" ON public.pmt_doroga_plots FOR SELECT USING (true);
CREATE POLICY "pmt_doroga_coords select" ON public.pmt_doroga_coords FOR SELECT USING (true);

GRANT SELECT ON public.pmt_doroga_plots  TO anon, authenticated;
GRANT SELECT ON public.pmt_doroga_coords TO anon, authenticated;
GRANT ALL    ON public.pmt_doroga_plots  TO service_role;
GRANT ALL    ON public.pmt_doroga_coords TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pmt_doroga_plots_id_seq  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pmt_doroga_coords_id_seq TO service_role;
