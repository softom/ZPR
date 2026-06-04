-- ============================================================
-- ZPR — стейджинг-таблицы ПМТ (Ф0 плана импорта)
-- ============================================================
-- 20 таблиц `pmt_*` из выгрузки [[31_Данные_ПМТ_по_участкам]].
-- Хранят исходные данные ПМТ в нормализованной форме как «архивный слой»
-- (1:1 с CSV-файлами в Хранилище). Целевая рабочая модель — `plots` /
-- `plot_polygons` / `plot_polygon_assignments` / `functional_objects` /
-- `engineering_loads` — заполняется ИЗ этих таблиц в Фазах 1-3.
--
-- Все таблицы — public schema. RLS не включаем (стейджинг, только для импорта
-- и аудита). Заливка данных — через `\copy` из CSV в `D:\Dropbox\ЗПР\ИРД\
-- 02_ППТ_ПМТ_КУРОРТ_ЗПР\Таблицы\` (см. scripts/load_pmt_data.ps1).
-- ============================================================

-- ============================================================
-- 00. pmt_sources — справочник источников (4 тома)
-- ============================================================
create table pmt_sources (
    source_id   text primary key,
    title       text not null,
    volume      text,
    kind        text,
    path        text,
    doc_date    date,
    version     text,
    srid        int default 970634,
    document_id uuid references documents(id)
);

insert into pmt_sources (source_id, title, volume, kind, path, doc_date, version, document_id) values
  ('PMT_T3_2_2026_03_24', 'ПМТ ОЧ ТЧ Том 3.2 ЗПР', '3.2', 'утверждаемая часть ПМТ',
   'ИРД\02_ППТ_ПМТ_КУРОРТ_ЗПР\ПМТ_Том3.2_ОЧ_ТЧ_v1__2026-03-24.pdf',
   '2026-03-24', 'v1', 'a0000001-0000-0000-0000-000000000001'),
  ('PMT_T4_2_2026_03_24', 'ПМТ МО ТЧ Том 4.2 ЗПР', '4.2', 'материалы по обоснованию ПМТ',
   'ИРД\02_ППТ_ПМТ_КУРОРТ_ЗПР\ПМТ_Том4.2_МО_ТЧ_v1__2026-03-24.pdf',
   '2026-03-24', 'v1', 'a0000001-0000-0000-0000-000000000002'),
  ('PPT_T1_2_2026_03_24', 'ППТ ОЧ ТЧ Том 1.2 ЗПР', '1.2', 'утверждаемая часть ППТ',
   'ИРД\02_ППТ_ПМТ_КУРОРТ_ЗПР\ППТ_Том1.2_ОЧ_ТЧ_v1__2026-03-24.pdf',
   '2026-03-24', 'v1', 'a0000001-0000-0000-0000-000000000003'),
  ('PPT_T2_2_2026_03_24', 'ППТ МО ТЧ Том 2.2 ЗПР', '2.2', 'материалы по обоснованию ППТ',
   'ИРД\02_ППТ_ПМТ_КУРОРТ_ЗПР\ППТ_Том2.2_МО_ТЧ_v1__2026-03-24.pdf',
   '2026-03-24', 'v1', 'a0000001-0000-0000-0000-000000000004');

-- ============================================================
-- 01. pmt_cadastrals — исходные кадастровые участки
-- ============================================================
create table pmt_cadastrals (
    cadastral   text primary key,
    address     text,
    category    text,
    vri         text,
    status      text,
    ownership   text,
    area_m2     bigint,
    page_t42    int,
    source_id   text references pmt_sources(source_id)
);

-- ============================================================
-- 02. pmt_stage1_izyatie — изъятие у частных собственников
-- ============================================================
create table pmt_stage1_izyatie (
    id                  bigserial primary key,
    pp                  text,
    dpt_no              text,
    cadastral           text references pmt_cadastrals(cadastral),
    ownership           text,
    address             text,
    area_m2_seizure     bigint,
    category            text,
    vri                 text,
    note                text,
    building_kn         text,
    building_ownership  text,
    building_area       text,
    page                int,
    source_id           text references pmt_sources(source_id)
);
create index on pmt_stage1_izyatie(cadastral);
create index on pmt_stage1_izyatie(dpt_no);

-- ============================================================
-- 03. pmt_vri_changes — изменения ВРИ для исходных кадастров
-- ============================================================
create table pmt_vri_changes (
    id            bigserial primary key,
    stage         int,
    pp            text,
    dpt_no        text,
    cadastral     text references pmt_cadastrals(cadastral),
    address       text,
    area_m2       bigint,
    category_old  text,
    vri_old       text,
    category_new  text,
    vri_new       text,
    page          int,
    source_id     text references pmt_sources(source_id)
);
create index on pmt_vri_changes(cadastral);
create index on pmt_vri_changes(dpt_no);

-- ============================================================
-- 04. pmt_zu — образуемые ЗУ
-- ============================================================
create table pmt_zu (
    zu               text primary key,
    plot_id          text,
    parent_zu        text references pmt_zu(zu),
    kind             text,
    stage            int,
    address          text,
    category         text,
    permitted_use    text,
    method           text,
    area_m2_table    numeric,
    area_m2_coords   numeric,
    page_table       int,
    page_coords      int,
    points_count     int,
    source_id        text references pmt_sources(source_id)
);
create index on pmt_zu(parent_zu) where parent_zu is not null;
create index on pmt_zu(kind);

-- ============================================================
-- 05. pmt_zu_points — координаты поворотных точек
-- ============================================================
create table pmt_zu_points (
    id          bigserial primary key,
    zu          text not null references pmt_zu(zu),
    plot_id     text,
    point_n     text,
    x           numeric(12,2),
    y           numeric(12,2),
    srid        int default 970634,
    page        int,
    source_id   text references pmt_sources(source_id)
);
create index on pmt_zu_points(zu);

-- ============================================================
-- 06. pmt_zu_stage_attrs — атрибуты ЗУ по этапам
-- ============================================================
create table pmt_zu_stage_attrs (
    id              bigserial primary key,
    zu              text not null references pmt_zu(zu),
    stage           int,
    pp              text,
    points_range    text,
    address         text,
    category        text,
    vri             text,
    area_m2         numeric,
    method          text,
    page            int,
    source_id       text references pmt_sources(source_id),
    unique (zu, stage)
);

-- ============================================================
-- 07. pmt_servituts — сервитуты
-- ============================================================
create table pmt_servituts (
    id          bigserial primary key,
    pp          text,
    zu          text,
    parent_zu   text references pmt_zu(zu),
    content     text,
    area_m2     bigint,
    page        int,
    source_id   text references pmt_sources(source_id)
);
create index on pmt_servituts(parent_zu);

-- ============================================================
-- 08. pmt_zu_objects — связь ЗУ ↔ функциональный объект ППТ
-- ============================================================
create table pmt_zu_objects (
    id           bigserial primary key,
    queue        text,
    zone_code    text,
    zone_raw     text,
    zu           text references pmt_zu(zu),
    cadastral    text references pmt_cadastrals(cadastral),
    object_name  text,
    page         int,
    source_id    text references pmt_sources(source_id)
);
create index on pmt_zu_objects(zu) where zu is not null;
create index on pmt_zu_objects(zone_code);

-- ============================================================
-- 09. pmt_zouit — зоны с особыми условиями использования территории
-- ============================================================
create table pmt_zouit (
    id            bigserial primary key,
    zone_type     text,
    kind_class    text,
    description   text,
    legal_basis   text,
    page          int,
    source_id     text references pmt_sources(source_id)
);

-- ============================================================
-- 10. pmt_zone_params — параметры застройки зон ППТ
-- ============================================================
create table pmt_zone_params (
    zone_code      text primary key,
    area_m2        numeric,
    k_otn          numeric,
    k_isp          numeric,
    k_oz_pct       numeric,
    k_oz_text      text,
    k_det_pct      numeric,
    k_det_text     text,
    k_vzr_pct      numeric,
    k_vzr_text     text,
    k_mm           numeric,
    k_mm_text      text,
    etazh_max      int,
    page           int,
    source_id      text references pmt_sources(source_id)
);

-- ============================================================
-- 11. pmt_oks — объекты капитального строительства из ППТ
-- ============================================================
create table pmt_oks (
    id            bigserial primary key,
    zone_code     text references pmt_zone_params(zone_code),
    object_name   text,
    status_code   text,
    value_code    text,
    queue         text,
    etazh_max     int,
    page          int,
    source_id     text references pmt_sources(source_id)
);
create index on pmt_oks(zone_code);

-- ============================================================
-- 12. pmt_eng_objects — инженерные объекты
-- ============================================================
create table pmt_eng_objects (
    id          bigserial primary key,
    kind        text,
    pos         text,
    capacity    text,
    units       text,
    status      text,
    page        int,
    source_id   text references pmt_sources(source_id)
);

-- ============================================================
-- 13. pmt_loads — расчётные нагрузки по инженерным сетям
-- ============================================================
create table pmt_loads (
    id            bigserial primary key,
    network       text not null,        -- water/sewer/storm/heat/gas/power/telecom
    zone_code     text,
    zu_list       text,
    object_name   text,
    capacity      text,
    load_value    numeric,
    load_units    text,
    page          int,
    source_id     text references pmt_sources(source_id)
);
create index on pmt_loads(network);
create index on pmt_loads(zone_code);

-- ============================================================
-- 14. pmt_cadastrals_pmt_t1 — ЗУ в ЕГРН на дату ПМТ
-- ============================================================
create table pmt_cadastrals_pmt_t1 (
    cadastral   text primary key,
    address     text,
    category    text,
    vri         text,
    status      text,
    ownership   text,
    area_m2     bigint,
    page        int,
    source_id   text references pmt_sources(source_id)
);

-- ============================================================
-- 15. pmt_zu_public — земли общего пользования
-- ============================================================
create table pmt_zu_public (
    id          bigserial primary key,
    zu          text references pmt_zu(zu),
    purpose     text,
    page        int,
    source_id   text references pmt_sources(source_id)
);

-- ============================================================
-- 16. pmt_boundary — координаты границы территории проектирования
-- ============================================================
create table pmt_boundary (
    id          bigserial primary key,
    point_n     text,
    x           numeric(12,2),
    y           numeric(12,2),
    srid        int default 970634,
    page        int,
    source_id   text references pmt_sources(source_id)
);

-- ============================================================
-- 17. pmt_redlines — координаты красных линий
-- ============================================================
create table pmt_redlines (
    id          bigserial primary key,
    kvartal     text,
    point_n     text,
    x           numeric(12,2),
    y           numeric(12,2),
    srid        int default 970634,
    page        int,
    source_id   text references pmt_sources(source_id)
);
create index on pmt_redlines(kvartal);

-- ============================================================
-- 18. pmt_zouit_reg — ЗОУИТ с реестровыми номерами
-- ============================================================
create table pmt_zouit_reg (
    id            bigserial primary key,
    registry_no   text,
    zone_type     text,
    kind_class    text,
    description   text,
    legal_basis   text,
    page          int,
    source_id     text references pmt_sources(source_id)
);
create index on pmt_zouit_reg(registry_no);

-- ============================================================
-- 19. pmt_okn — Объекты культурного наследия
-- ============================================================
create table pmt_okn (
    id                  bigserial primary key,
    name                text,
    authors             text,
    year_created        int,
    type                text,
    category            text,
    cadastral           text,
    registry_number     text,
    address             text,
    okhrana_zone        text,
    okhrana_zone_doc    text,
    territory_doc       text,
    inclusion_doc       text,
    restoration_plan    text,
    related_zone        text,
    related_zu          text,
    page                int,
    source_id           text references pmt_sources(source_id)
);
