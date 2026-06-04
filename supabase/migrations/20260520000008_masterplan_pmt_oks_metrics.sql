-- ============================================================
-- ZPR — Расширение masterplan_metric_codes атрибутами из pmt_oks
-- ============================================================
-- Чтобы сравнивать этажность / статус / value между ПМТ-документом
-- и PDF ТЭП — добавляем эти атрибуты в справочник как метрики.
-- ============================================================

insert into masterplan_metric_codes (code, label, category, default_unit, network, pdf_column_no, sort_order) values
  ('etazh_max',   'Этажность максимальная', 'capacity', 'эт.', null, null, 50),
  ('status_code', 'Статус ОКС (ПМТ)',       'attr',     null,  null, null, 60),
  ('value_code',  'Код value (ПМТ)',        'attr',     null,  null, null, 61)
on conflict (code) do nothing;