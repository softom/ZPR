-- ============================================================
-- ZPR — выравнивание стейджинг-таблиц pmt_* под формат CSV-выгрузки
-- ============================================================
-- В файлах CSV (из D:\Dropbox\ЗПР\ИРД\02_ППТ_ПМТ_КУРОРТ_ЗПР\Таблицы\) есть
-- колонки, которых не было в исходной DDL из миграции 20260519010002. Этот
-- align расширяет таблицы под фактический формат выгрузки.
-- ============================================================

-- pmt_oks: CSV имеет zone_section (категория зоны типа «Зона гостиничной деятельности Г-1»)
alter table pmt_oks add column if not exists zone_section text;

-- pmt_eng_objects: CSV имеет name (полное наименование) и count (кол-во)
alter table pmt_eng_objects add column if not exists name  text;
alter table pmt_eng_objects add column if not exists count int;

-- pmt_loads: CSV имеет pp (№ п/п), raw (исходная ячейка таблицы); load_units нет, его и не было в CSV
alter table pmt_loads add column if not exists pp  text;
alter table pmt_loads add column if not exists raw text;

-- pmt_zu_public: CSV имеет address, area_m2, raw; purpose не использовали
alter table pmt_zu_public add column if not exists address text;
alter table pmt_zu_public add column if not exists area_m2 int;
alter table pmt_zu_public add column if not exists raw     text;

-- pmt_cadastrals_pmt_t1: CSV имеет pp (№ п/п)
alter table pmt_cadastrals_pmt_t1 add column if not exists pp text;
-- В CSV PK не cadastral (могут быть дубли) — нужен id. Удаляю PK на cadastral.
alter table pmt_cadastrals_pmt_t1 drop constraint if exists pmt_cadastrals_pmt_t1_pkey;
alter table pmt_cadastrals_pmt_t1 add column if not exists id bigserial;
alter table pmt_cadastrals_pmt_t1 add primary key (id);

-- pmt_okn: CSV имеет много дополнительных колонок
alter table pmt_okn add column if not exists coords_available    text;
alter table pmt_okn add column if not exists coords_source       text;
alter table pmt_okn add column if not exists pages_t22           text;
alter table pmt_okn add column if not exists pages_t42           text;
alter table pmt_okn add column if not exists pages_t12           text;
alter table pmt_okn add column if not exists source_id_primary   text;
alter table pmt_okn add column if not exists source_id_secondary text;
-- В CSV нет single source_id — есть primary/secondary. Делаю source_id nullable.
alter table pmt_okn alter column source_id drop not null;
-- Также: year_created в CSV может быть пустым → numeric
alter table pmt_okn alter column year_created type text using year_created::text;
