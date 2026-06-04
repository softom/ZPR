-- ============================================================
-- ZPR — Справочник кодов метрик для masterplan_objects
-- ============================================================
-- Шапка для масштабируемой версионируемой системы метрик
-- (ТЭП + нагрузки) объектов мастерплана.
--
-- Колонки 3-47 PDF «Сводные ТЭП ЗПР 20.05.26» нормализуются в одну
-- таблицу значений `masterplan_object_metrics` через справочник.
-- ============================================================

create type metric_category as enum (
  'capacity',  -- ёмкость: номера, чел, машиноместа
  'area',      -- площадь, м²
  'volume',    -- объём, м³
  'load',      -- нагрузка на сеть (вода/тепло/газ/электричество/ливневка)
  'attr'       -- атрибут-категория (категория надёжности I/II/III)
);

create table masterplan_metric_codes (
  code            text primary key,
  label           text not null,
  category        metric_category not null,
  default_unit    text,                       -- 'м²', 'кВт', 'м³/сут', null для attr
  network         text,                       -- 'water'|'heat'|'gas'|'power'|'storm' — для load/attr с сетью
  pdf_column_no   smallint,                   -- 3..47 — трассировка к колонке PDF
  sort_order      smallint not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create index masterplan_metric_codes_category_idx on masterplan_metric_codes(category);
create index masterplan_metric_codes_network_idx  on masterplan_metric_codes(network) where network is not null;

comment on table masterplan_metric_codes is
  'Справочник кодов метрик объектов мастерплана. Каждая строка = один тип значения (ТЭП-показатель или нагрузка). PDF-колонки 3-47 нормализуются сюда.';
comment on column masterplan_metric_codes.code is
  'Стабильный текстовый код метрики. Пример: water_demand, area_plot, power_pp.';
comment on column masterplan_metric_codes.pdf_column_no is
  'Номер колонки в исходной таблице PDF «Сводные ТЭП». Для трассировки.';

-- ============================================================
-- Seed: 20 метрик из таблицы PDF
-- ============================================================
insert into masterplan_metric_codes (code, label, category, default_unit, network, pdf_column_no, sort_order) values
  -- Ёмкость
  ('rooms_count_ppt',  'Номерной фонд (ППТ)',                   'capacity', 'шт',     null,    3, 10),
  ('rooms_actual',     'Количество номеров (расчётное)',         'capacity', 'шт',     null,   13, 11),
  ('residents_count',  'Кол-во проживающих',                     'capacity', 'чел',    null,   15, 12),
  ('staff_count',      'Кол-во персонала (расчётное)',           'capacity', 'чел',    null,   17, 13),

  -- Площади / объём
  ('area_plot',        'Площадь участка',                        'area',     'м²',     null,    5, 20),
  ('area_built',       'Площадь застройки',                      'area',     'м²',     null,    6, 21),
  ('area_green',       'Озеленённые территории',                 'area',     'м²',     null,    7, 22),
  ('area_object',      'Площадь объекта',                        'area',     'м²',     null,    8, 23),
  ('rooms_area',       'Площадь номерного фонда',                'area',     'м²',     null,   14, 25),
  ('volume_building',  'Объём здания (расчётный)',               'volume',   'м³',     null,   12, 24),

  -- Нагрузки: вода
  ('water_demand',     'Водопотребление (Q сут.max)',            'load',     'м³/сут', 'water', 31, 30),
  ('water_drainage',   'Водоотведение',                          'load',     'м³/сут', 'water', 33, 31),

  -- Нагрузки: тепло
  ('heat_fuel',        'Теплоснабжение — расход топлива',        'load',     'м³/час', 'heat',  35, 32),
  ('heat_power',       'Теплоснабжение — мощность',              'load',     'МВт',    'heat',  36, 33),

  -- Нагрузки: газ
  ('gas',              'Газоснабжение',                          'load',     'м³/ч',   'gas',   37, 34),

  -- Ливнёвка
  ('storm',            'Ливневая канализация — сток',            'load',     'м³/год', 'storm', 43, 35),

  -- Электричество
  ('power_pp',         'Электроснабжение — расч. мощность Pр',   'load',     'кВт',    'power', 44, 40),
  ('power_s',          'Электроснабжение — полная мощность S',   'load',     'кВА',    'power', 45, 41),
  ('power_kc',         'Электроснабжение — Pр с учётом Кс',      'load',     'кВт',    'power', 46, 42),
  ('power_category',   'Электроснабжение — категория надёжн.',   'attr',     null,     'power', 47, 43);
