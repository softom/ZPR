-- ============================================================
-- ZPR — engineering_loads (Ф3 плана импорта ПМТ)
-- ============================================================
-- Расчётные нагрузки по 7 инженерным сетям из Тома 2.2 ППТ.
-- 175 строк в `pmt_loads` → таблица `engineering_loads` с FK на
-- functional_objects (по zone_code) и/или plots (по zu_list).
-- ENUM `engineering_network` уже создан в 20260519010003_plot_types_and_enums.sql.
--
-- См. [[32_План_импорта_ПМТ]] раздел Ф3.
-- ============================================================

create table engineering_loads (
    id                   uuid primary key default gen_random_uuid(),
    network              engineering_network not null,
    functional_object_id uuid references functional_objects(id),
    plot_id              uuid references plots(id),
    object_name          text,                              -- snapshot из pmt_loads.object_name
    capacity_raw         text,                              -- «260 номеров», «1500 м2»
    load_value           numeric,
    load_units           text,                              -- 'м3/сут' / 'кВА' / 'Гкал/ч' / 'м3/ч'
    source_zu_list       text,                              -- snapshot для трассировки
    source_zone_code     text,                              -- snapshot для трассировки
    source_pmt_pp        text,                              -- № п/п в исходной таблице ПМТ
    source_document_id   uuid not null references documents(id),
    raw                  text,                              -- исходная ячейка таблицы
    note                 text,
    created_at           timestamptz not null default now(),
    check (functional_object_id is not null or plot_id is not null or source_zone_code is not null)
);

create index engineering_loads_fo_idx        on engineering_loads(functional_object_id) where functional_object_id is not null;
create index engineering_loads_plot_idx      on engineering_loads(plot_id) where plot_id is not null;
create index engineering_loads_network_idx   on engineering_loads(network);
create index engineering_loads_doc_idx       on engineering_loads(source_document_id);
create index engineering_loads_zone_code_idx on engineering_loads(source_zone_code) where source_zone_code is not null;

comment on table engineering_loads is
  'Расчётные нагрузки по инженерным сетям из Тома 2.2 ППТ. Привязка по functional_object (зона ППТ) или конкретному ЗУ.';
comment on column engineering_loads.functional_object_id is
  'FK на functional_objects (через zone_code). NULL если нагрузка специфична для одного ЗУ.';
comment on column engineering_loads.plot_id is
  'FK на plots (через source_pmt_zu). NULL если нагрузка зональная.';

-- ============================================================
-- View для UI: нагрузки на функциональный объект (суммарные)
-- ============================================================
create or replace view v_engineering_loads_by_functional as
select
    el.functional_object_id,
    el.network,
    sum(el.load_value) as total_load,
    max(el.load_units) as units,
    count(*) as items_count,
    array_agg(distinct el.source_pmt_pp order by el.source_pmt_pp) filter (where el.source_pmt_pp is not null) as pp_list
from engineering_loads el
where el.functional_object_id is not null
group by el.functional_object_id, el.network;

comment on view v_engineering_loads_by_functional is
  'Суммарные нагрузки на функциональный объект ППТ по 7 сетям. Для карточки functional_object.';

-- ============================================================
-- View для UI: нагрузки на конкретный ЗУ
-- ============================================================
create or replace view v_engineering_loads_by_plot as
select
    el.plot_id,
    el.network,
    el.load_value,
    el.load_units,
    el.object_name,
    el.capacity_raw,
    el.source_pmt_pp,
    el.note,
    el.raw,
    el.source_document_id
from engineering_loads el
where el.plot_id is not null;

comment on view v_engineering_loads_by_plot is
  'Нагрузки конкретного ЗУ. Для карточки plot.';
