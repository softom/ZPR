-- ============================================================
-- ZPR — functional_objects (Ф1 миграция 2)
-- ============================================================
-- Функциональные объекты ППТ (отель, ТПУ, подстанция, …) как самостоятельная
-- сущность. Аккумулирует атрибуты из `pmt_zu_objects`. Существует независимо
-- от наличия участков (6 строк общей инфраструктуры без `zu`).
--
-- См. [[29_Сущность_Участок]] раздел `functional_objects`.
-- ============================================================

create table functional_objects (
    id                      uuid primary key default gen_random_uuid(),
    zone_code               text not null unique,    -- 'Г-1.5' / 'К-1.4' / 'ТИ-1.1' / 'P-1.4' / …
    queue                   text,                     -- '1' / '2' / '1-2'
    kind                    functional_object_kind not null,
    name                    text not null,            -- 'Отель 5★ Health 260' / 'ТПУ ТИ-1.1' / …
    description             text,
    object_id               uuid references objects(id),    -- маппинг на бизнес-объект ЗПР. NULL ok
    source_document_id      uuid references documents(id),  -- Том 1.2 ППТ
    source_pmt_object_name  text,                    -- snapshot pmt_zu_objects.object_name
    active                  boolean not null default true,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

create index functional_objects_object_idx   on functional_objects(object_id) where object_id is not null;
create index functional_objects_unmapped_idx on functional_objects(id) where object_id is null and active = true;
create index functional_objects_kind_idx     on functional_objects(kind);
create index functional_objects_queue_idx    on functional_objects(queue) where queue is not null;

comment on table functional_objects is
  'Функциональные объекты ППТ как самостоятельная сущность (отель/ТПУ/подстанция/общепит). Может существовать без plots (общая инфраструктура).';
comment on column functional_objects.zone_code is
  'Код функциональной зоны ППТ. Уникальный ключ — один zone_code = один functional_object.';
comment on column functional_objects.object_id is
  'Опциональная ссылка на бизнес-объект ЗПР. Заполняется при импорте через таблицу ОКС (Ф2) или вручную через UI.';
