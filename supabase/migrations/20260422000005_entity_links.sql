-- ─── Универсальная таблица связей между сущностями системы ──────────────────
--
-- Каждая строка = одна направленная связь: from_type/from_id → to_type/to_id
-- Используется для явных M:N-отношений между любыми сущностями.
--
-- Допустимые типы сущностей (from_type / to_type):
--   'event'       — events.id            (uuid)
--   'document'    — documents.id         (uuid)
--   'letter'      — letters.id           (uuid)
--   'object'      — objects.code         (text: "006_ГОСТИНИЦА_400")
--   'milestone'   — contract_milestones.id (uuid)
--   'contractor'  — contractors.id       (uuid)
--   'meeting'     — (future)
--
-- Допустимые типы связей (link_type):
--   'belongs_to'    — событие/документ принадлежит объекту или договору
--   'from_document' — событие создано на основании этого документа
--   'from_letter'   — событие создано на основании этого письма
--   'references'    — неспецифическая ссылка
--   'implements'    — план-факт (future: этап ГПР реализует этап договора)

create table entity_links (
    id            uuid primary key default gen_random_uuid(),

    -- Источник связи
    from_type     text not null
                  check (from_type in ('event','document','letter','object','milestone','contractor','meeting')),
    from_id       text not null,
    -- UUID или текстовый код (например код объекта "006_ГОСТИНИЦА_400")

    -- Цель связи
    to_type       text not null
                  check (to_type in ('event','document','letter','object','milestone','contractor','meeting')),
    to_id         text not null,

    -- Тип отношения
    link_type     text not null default 'belongs_to'
                  check (link_type in ('belongs_to','from_document','from_letter','references','implements')),

    notes         text,
    created_at    timestamptz not null default now(),

    -- Уникальность: одна связь одного типа между двумя сущностями
    unique (from_type, from_id, to_type, to_id, link_type)
);

-- Индексы для обоих направлений поиска
create index on entity_links (from_type, from_id);
create index on entity_links (to_type, to_id);
create index on entity_links (link_type);

-- ─── Вспомогательные функции ──────────────────────────────────────────────────

-- Получить все объекты, к которым привязано событие
create or replace function event_objects(p_event_id uuid)
returns table(object_code text) language sql stable as $$
  select to_id
    from entity_links
   where from_type = 'event'
     and from_id   = p_event_id::text
     and to_type   = 'object'
     and link_type = 'belongs_to';
$$;

-- Получить все события по объекту (для таймлайна)
create or replace function object_events(p_object_code text)
returns table(event_id uuid) language sql stable as $$
  select from_id::uuid
    from entity_links
   where from_type = 'event'
     and to_type   = 'object'
     and to_id     = p_object_code
     and link_type = 'belongs_to';
$$;

-- Получить все события по договору
create or replace function document_events(p_document_id uuid)
returns table(event_id uuid) language sql stable as $$
  select from_id::uuid
    from entity_links
   where from_type = 'event'
     and to_type   = 'document'
     and to_id     = p_document_id::text
     and link_type = 'from_document';
$$;

-- ─── RLS ──────────────────────────────────────────────────────────────────────
alter table entity_links enable row level security;

create policy "anon select" on entity_links for select using (true);
create policy "service all"  on entity_links for all  using (true) with check (true);
