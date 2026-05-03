-- ============================================================
-- legal_entities — справочник юридических лиц
-- ============================================================
-- Согласно [[17_Сущность_Договор_и_ЮрЛицо]].
-- Сущность ветки «Договор». Стороны договоров (заказчики,
-- подрядчики, третьи лица). Одно юр.лицо — много ролей в разных
-- договорах. Уникальность по ИНН.

create table legal_entities (
    id                  uuid primary key default gen_random_uuid(),
    name                text not null,                              -- «ООО «Хэдс Групп»»
    inn                 text not null unique,                       -- основной бизнес-ключ
    kpp                 text,
    ogrn                text,
    address             text,                                       -- юридический адрес
    signatory_name      text,                                       -- ФИО подписанта по умолчанию
    signatory_position  text,                                       -- должность подписанта
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

comment on table  legal_entities is 'Справочник юр.лиц — стороны договоров (заказчики, подрядчики, третьи стороны)';
comment on column legal_entities.inn is 'ИНН — уникальный бизнес-ключ. При загрузке договора: найти по ИНН или создать';
comment on column legal_entities.signatory_name is 'ФИО подписанта по умолчанию (используется в шаблонах)';

create index legal_entities_name_idx on legal_entities (name);

-- Триггер обновления updated_at
create or replace function legal_entities_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger legal_entities_updated_at
    before update on legal_entities
    for each row
    execute function legal_entities_set_updated_at();

-- ─── Связь tasks ↔ legal_entities ────────────────────────────────────────────

alter table tasks add column assignee_entity_id uuid references legal_entities(id) on delete set null;
create index tasks_assignee_entity_idx on tasks (assignee_entity_id);

comment on column tasks.assignee_entity_id is 'FK на legal_entities — основной ответственный (организация)';
comment on column tasks.assignee_org is 'Текстовое имя организации (для backwards compat и unmatched случаев)';

-- ─── Seed данных и backfill ───────────────────────────────────────────────────
-- Реальные юр.лица (ИНН, адреса, подписанты) — sensitive business data.
-- Не хранятся в публичном репозитории. Управляются через:
--   business_data.yaml          (в .gitignore — локально + Dropbox)
--   business_data.example.yaml  (шаблон в git)
--   seed_business_data.py       (читает yaml → INSERT в legal_entities + backfill tasks.assignee_entity_id)
--
-- Применять после `db-migrate.ps1`:
--   python seed_business_data.py
