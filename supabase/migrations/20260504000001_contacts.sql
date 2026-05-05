-- ============================================================
-- contacts — справочник физлиц организаций
-- ============================================================
-- Согласно [[22_Сущность_Контакт]].
-- Физлица (сотрудники) организаций. Используются в meeting_participants.
-- Связь contact → legal_entity: 1:N (одна работа, без истории карьеры).
-- При смене места работы — либо UPDATE legal_entity_id, либо новая запись.

create table contacts (
    id              uuid primary key default gen_random_uuid(),
    legal_entity_id uuid references legal_entities(id) on delete restrict,

    -- ФИО (раздельные поля для нормализации и поиска)
    last_name       text not null,                              -- Антипов
    first_name      text not null,                              -- Артемий
    middle_name     text,                                       -- Юрьевич (опционально)

    -- Должность по умолчанию (роль на конкретном собрании может отличаться)
    -- Имя `job_title`, а не `position` — `position` зарезервировано в PL/pgSQL TABLE-returns.
    job_title       text,                                        -- Руководитель проекта

    -- Контактные данные
    email           text,
    phone           text,

    -- Метаданные
    is_active       boolean not null default true,               -- false = больше не работает
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table  contacts is 'Справочник физлиц — сотрудники организаций (legal_entities)';
comment on column contacts.legal_entity_id is 'FK на legal_entities. Одна основная организация, история карьеры не ведётся';
comment on column contacts.job_title is 'Должность по умолчанию. Для роли на конкретном собрании см. meeting_participants.role_at_meeting';
comment on column contacts.is_active is 'false если контакт неактивен (уволен, не работает) — но не удаляется';

-- Уникальность: в рамках одной организации не должно быть двух одинаковых ФИО
-- coalesce для middle_name — иначе NULL != NULL в Postgres (две записи с null middle проскочат)
create unique index contacts_unique_per_org_idx
  on contacts (legal_entity_id, last_name, first_name, coalesce(middle_name, ''));

create index contacts_last_name_idx     on contacts (last_name);
create index contacts_legal_entity_idx  on contacts (legal_entity_id);
create index contacts_is_active_idx     on contacts (is_active) where is_active = true;

-- Триггер обновления updated_at
create or replace function contacts_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger contacts_updated_at
    before update on contacts
    for each row
    execute function contacts_set_updated_at();

-- ─── Расширение entity_links: добавляем 'contact' в допустимые типы ───────────

alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links drop constraint entity_links_to_type_check;

alter table entity_links add constraint entity_links_from_type_check
    check (from_type in (
        'event','document','letter','object','milestone',
        'contractor','meeting','task','legal_entity','contact'
    ));

alter table entity_links add constraint entity_links_to_type_check
    check (to_type in (
        'event','document','letter','object','milestone',
        'contractor','meeting','task','legal_entity','contact'
    ));

-- ─── Helper-функции ───────────────────────────────────────────────────────────

-- Все контакты организации (активные)
create or replace function legal_entity_contacts(p_entity_id uuid)
returns table(
    id uuid, last_name text, first_name text, middle_name text,
    job_title text, email text, phone text
) language sql stable as $$
    select id, last_name, first_name, middle_name, job_title, email, phone
      from contacts
     where legal_entity_id = p_entity_id
       and is_active = true
     order by last_name, first_name;
$$;

comment on function legal_entity_contacts is 'Активные контакты организации, отсортированы по ФИО';

notify pgrst, 'reload schema';
