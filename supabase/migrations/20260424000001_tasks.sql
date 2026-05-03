-- ============================================================
-- tasks — задачи из протоколов собраний
-- ============================================================
-- Отдельная сущность от events: у задач другой жизненный цикл
-- (поручение → выполнение → закрытие), без relative-дат и цепочек.
-- Связь с объектами / собраниями / документами — через entity_links.

create table tasks (
    id              uuid primary key default gen_random_uuid(),
    code            text unique not null,                  -- ПРОТ-{YYYY-MM-DD}-{КОД}-ЗАД-{NN}

    title           text not null,
    explanation     text,

    -- статус и приоритет
    status          text not null default 'open'
                    check (status in ('open','in_progress','done','closed','cancelled')),
    priority        text default 'medium'
                    check (priority in ('high','medium','low')),

    -- ответственный (организация)
    assignee_org    text,

    -- объекты — массив кодов из objects.code
    -- одна задача может относиться к нескольким объектам (например all-ХГ)
    object_codes    text[] not null default '{}',

    -- даты
    due_date        date,
    done_date       date,
    done_note       text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- источник
    source_protocol      text,                              -- ПРОТ-2026-04-17-МЛА
    source_meeting_date  date,
    source_meeting_path  text,                              -- путь к папке собрания (трассировка)
    migrated_from        text,                              -- путь к исходному .md

    -- содержание
    quotes          jsonb not null default '[]',            -- [{"speaker_org": "...", "text": "..."}]
    tags            text[] not null default '{}'
);

comment on table  tasks is 'Поручения из протоколов рабочих собраний';
comment on column tasks.code is 'Уникальный код: ПРОТ-{дата}-{подрядчик}-ЗАД-{NN}';
comment on column tasks.object_codes is 'Массив кодов объектов из objects.code (поддержка multi-object)';
comment on column tasks.source_meeting_path is 'Путь к папке собрания (для трассировки от .md)';
comment on column tasks.quotes is 'Цитаты из транскрипции — основание задачи';

-- Индексы
create index tasks_status_idx       on tasks (status);
create index tasks_priority_idx     on tasks (priority);
create index tasks_assignee_idx     on tasks (assignee_org);
create index tasks_due_date_idx     on tasks (due_date);
create index tasks_object_codes_idx on tasks using gin (object_codes);
create index tasks_source_protocol_idx on tasks (source_protocol);

-- Триггер обновления updated_at
create or replace function tasks_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger tasks_updated_at
    before update on tasks
    for each row
    execute function tasks_set_updated_at();

-- Расширяем entity_links: добавляем 'task' в допустимые типы
alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links drop constraint entity_links_to_type_check;

alter table entity_links add constraint entity_links_from_type_check
    check (from_type in ('event','document','letter','object','milestone','contractor','meeting','task'));

alter table entity_links add constraint entity_links_to_type_check
    check (to_type in ('event','document','letter','object','milestone','contractor','meeting','task'));

-- Расширяем link_type — добавляем семантику для задач
alter table entity_links drop constraint entity_links_link_type_check;
alter table entity_links add constraint entity_links_link_type_check
    check (link_type in (
        'belongs_to','from_document','from_letter','references','implements',
        'from_meeting','from_protocol','assigned_to','blocks','blocked_by'
    ));

-- ─── Вспомогательные представления ────────────────────────────────────────────

-- Задачи по объекту: разворачивает массив object_codes в строки
create or replace view tasks_by_object as
select
    unnest(t.object_codes) as object_code,
    t.id, t.code, t.title, t.status, t.priority, t.assignee_org,
    t.due_date, t.done_date, t.source_meeting_date
from tasks t;

-- Активные задачи (open / in_progress)
create or replace view tasks_active as
select * from tasks
where status in ('open','in_progress')
order by
    case priority when 'high' then 1 when 'medium' then 2 when 'low' then 3 end,
    due_date nulls last,
    created_at;

comment on view tasks_by_object is 'Один объект → одна строка задачи (раскрытие массива object_codes)';
comment on view tasks_active is 'Только активные задачи, отсортированы по приоритету и сроку';
