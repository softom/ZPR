-- ============================================================
-- ZPR — начальная схема БД
-- ============================================================

-- Сброс (для повторного применения)
drop table if exists contract_milestones cascade;
drop table if exists documents          cascade;
drop table if exists letters            cascade;
drop table if exists folders            cascade;
drop table if exists objects            cascade;
drop type  if exists doc_type           cascade;
drop type  if exists doc_method         cascade;
drop type  if exists direction_type     cascade;
drop type  if exists storage_type       cascade;
drop type  if exists entity_type        cascade;

-- Enums

create type entity_type as enum ('object', 'contractor', 'customer');
create type storage_type as enum ('хранилище', 'obsidian');
create type direction_type as enum ('incoming', 'outgoing');
create type doc_method as enum (
    'Электронная_почта',
    'ЭДО',
    'Курьер',
    'Скан',
    'Факс',
    'Лично',
    'Инициализация'
);
create type doc_type as enum (
    'ВХОДЯЩИЕ',
    'ИСХОДЯЩИЕ',
    'ДОГОВОРА',
    'ФЗ',
    'ТЗ',
    'МАТЕРИАЛЫ',
    'ИРД',
    'ТУ',
    'ГРАФИКИ',
    'СТАНДАРТЫ'
);

-- ============================================================
-- objects — реестр объектов
-- ============================================================
create table objects (
    id           uuid primary key default gen_random_uuid(),
    code         text not null unique,           -- '006_ГОСТИНИЦА_400' (NNN_ТИП_ЁМКОСТЬ)
    current_name text not null,                  -- 'Отель 5★ Health'
    contractor   text,                           -- 'ХГ'
    aliases      jsonb not null default '[]',    -- ['04_HLT_260', 'Хелс']
    created_at   timestamptz not null default now()
);

comment on table  objects is 'Реестр строительных объектов проекта ЗПР';
comment on column objects.code is 'Неизменяемый код объекта: NNN_ТИП_ЁМКОСТЬ';
comment on column objects.aliases is 'Legacy-коды и прежние названия для поиска';

-- ============================================================
-- folders — имена папок по сущностям и хранилищам
-- ============================================================
create table folders (
    id           uuid primary key default gen_random_uuid(),
    entity_type  entity_type not null,
    entity_code  text not null,                  -- '006' / 'ХГ' / 'ALEAN'
    storage      storage_type not null,
    folder_name  text not null,
    created_at   timestamptz not null default now(),
    unique (entity_type, entity_code, storage)
);

comment on table  folders is 'Источник истины для имён папок. Скрипты читают пути отсюда.';
comment on column folders.folder_name is 'Пример: 006_ГОСТИНИЦА_400 или 006_ГОСТИНИЦА_400_(ХГ)';

-- ============================================================
-- letters — реестр корреспонденции
-- ============================================================
create table letters (
    id           uuid primary key default gen_random_uuid(),
    date         date not null,
    direction    direction_type not null,
    from_to      text not null,                  -- отправитель или получатель
    subject      text,
    method       doc_method not null,
    folder_path  text,                           -- относительный путь в Хранилище
    created_at   timestamptz not null default now()
);

comment on table  letters is 'Реестр входящей и исходящей корреспонденции';
comment on column letters.folder_path is 'Путь от корня Хранилища: ВХОДЯЩИЕ\2026_04_15_ХГ_ФЗ__Email';

-- ============================================================
-- documents — реестр документов
-- ============================================================
create table documents (
    id           uuid primary key default gen_random_uuid(),
    letter_id    uuid references letters(id) on delete set null,
    object_codes jsonb not null default '[]',    -- ['006', '012']
    type         doc_type not null,
    title        text not null,
    version      text,                           -- 'v1', 'ДС1'
    folder_path  text,                           -- относительный путь в Хранилище
    indexed_at   timestamptz,                    -- когда проиндексирован в Pinecone
    created_at   timestamptz not null default now()
);

comment on table  documents is 'Реестр документов. Один документ может относиться к нескольким объектам.';
comment on column documents.object_codes is 'Массив кодов объектов: ["006", "012"]';
comment on column documents.folder_path is 'Путь от корня Хранилища: ДОГОВОРА\2026_01_23_Договор_ХГ-2026-003_v1__ЭДО';

-- ============================================================
-- contract_milestones — этапы и сроки договоров
-- ============================================================
create table contract_milestones (
    id             uuid primary key default gen_random_uuid(),
    document_id    uuid not null references documents(id) on delete cascade,
    object_code    text not null,
    milestone_name text not null,
    due_date       date,
    responsible    text,
    condition      text,                         -- условие, если дата условная
    source         text,                         -- 'ДС-1', 'Приложение №3', 'Раздел 4'
    created_at     timestamptz not null default now()
);

comment on table  contract_milestones is 'Плановые этапы и сроки из договоров и ДС';
comment on column contract_milestones.source is 'Откуда извлечён этап: ДС-1 / Приложение №3 / Раздел 4';

-- ============================================================
-- Индексы
-- ============================================================
create index on objects (code);
create index on folders (entity_type, entity_code);
create index on letters (date, direction);
create index on documents (type);
create index on documents using gin (object_codes);
create index on contract_milestones (document_id);
create index on contract_milestones (object_code, due_date);

-- ============================================================
-- RLS — Row Level Security (включаем, политики добавим позже)
-- ============================================================
alter table objects             enable row level security;
alter table folders             enable row level security;
alter table letters             enable row level security;
alter table documents           enable row level security;
alter table contract_milestones enable row level security;

-- Временная открытая политика для разработки (убрать в проде)
create policy "dev_all" on objects             for all using (true);
create policy "dev_all" on folders             for all using (true);
create policy "dev_all" on letters             for all using (true);
create policy "dev_all" on documents           for all using (true);
create policy "dev_all" on contract_milestones for all using (true);
