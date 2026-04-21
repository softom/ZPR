-- ============================================================
-- Справочник подрядчиков
-- ============================================================

create table contractors (
    id         uuid primary key default gen_random_uuid(),
    code       text not null unique,   -- 'ХГ', '8D', 'МЛА+'
    full_name  text,                   -- полное наименование
    created_at timestamptz not null default now()
);

comment on table contractors is 'Справочник подрядчиков проекта ЗПР';

-- Начальные данные
insert into contractors (code, full_name) values
    ('ХГ',     'ООО «Хэдс Групп»'),
    ('8D',     '8D Studio'),
    ('МЛА+',   'МЛА+'),
    ('Б82',    'Бюро 82'),
    ('Акулова','Акулова'),
    ('Космос', 'Космос');

-- RLS
alter table contractors enable row level security;
create policy "dev_all" on contractors for all using (true);

-- Индекс
create index on contractors (code);
