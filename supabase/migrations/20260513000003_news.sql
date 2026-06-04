-- ============================================================================
-- Сущность Новость (`news`) — лента публикаций проекта
-- ============================================================================
-- См. MD WIKI/CLAUDE/28_Сущность_Новость.md
--
-- Что делает миграция:
--   1) Таблица news (title, body_md, object_ids, importance, status, publish_to, ...)
--   2) Расширение entity_links: from_type/to_type += 'news', link_type += 'from_event'
--   3) Триггер events_auto_news: каждое подтверждённое (is_preliminary=false) событие
--      → черновик новости + связь entity_links news→event link_type='from_event'
--   4) RLS: viewer/аноним — только published; uploader/admin — full CRUD
-- ============================================================================

-- ── 1. Таблица news ─────────────────────────────────────────────────────────

create table news (
    id            uuid primary key default gen_random_uuid(),

    title         text not null,
    body_md       text,

    object_ids    uuid[] not null default '{}',

    importance    text not null default 'normal'
                  check (importance in ('high','normal','low')),

    status        text not null default 'draft'
                  check (status in ('draft','published','archived')),

    publish_to    text[] not null default '{site}',

    publish_at    timestamptz,
    published_at  timestamptz,

    created_by    uuid,

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index news_status_idx       on news (status);
create index news_published_at_idx on news (published_at desc nulls last);
create index news_object_ids_idx   on news using gin (object_ids);

comment on table  news is 'Лента публикаций проекта. Каждое подтверждённое событие → черновик новости (триггер). См. MD WIKI 28.';
comment on column news.title        is 'Заголовок (обязательный)';
comment on column news.body_md      is 'Основной текст в Markdown';
comment on column news.object_ids   is 'JSONB-массив UUID объектов (см. 09_Правило_связей)';
comment on column news.importance   is 'high | normal | low — для подкраски в ленте';
comment on column news.status       is 'draft | published | archived';
comment on column news.publish_to   is 'Куда публиковать: site | tg | bitrix | email_digest';
comment on column news.publish_at   is 'Желаемое время публикации (NULL = сразу)';
comment on column news.published_at is 'Фактический переход в published';
comment on column news.created_by   is 'auth.users.id; NULL если создано триггером';

-- updated_at триггер (по аналогии с tasks_set_updated_at и др.)
create or replace function news_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end $$;

create trigger news_updated_at
    before update on news
    for each row execute function news_set_updated_at();

-- ── 2. Расширение entity_links ──────────────────────────────────────────────

alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links drop constraint entity_links_to_type_check;
alter table entity_links drop constraint entity_links_link_type_check;

alter table entity_links add constraint entity_links_from_type_check
    check (from_type in ('event','calendar_entry','document','letter','object',
                         'milestone','contractor','meeting','task','legal_entity',
                         'contact','meeting_topic','news'));

alter table entity_links add constraint entity_links_to_type_check
    check (to_type in ('event','calendar_entry','document','letter','object',
                       'milestone','contractor','meeting','task','legal_entity',
                       'contact','meeting_topic','news'));

alter table entity_links add constraint entity_links_link_type_check
    check (link_type in ('belongs_to','from_document','from_letter','references',
                         'implements','from_meeting','from_protocol','assigned_to',
                         'blocks','blocked_by',
                         'fulfills',
                         'from_event','from_calendar_entry','about_entity'));

comment on column entity_links.link_type is
    'belongs_to/assigned_to — стандарт. fulfills — событие закрывает веху. '
    'from_event/from_calendar_entry — новость порождена событием/вехой (см. 28). '
    'about_entity — новость относится к юр.лицу.';

-- ── 3. Триггер: подтверждённое событие → черновик новости ───────────────────

create or replace function auto_create_news_from_event() returns trigger
language plpgsql as $$
declare
    v_news_id uuid;
begin
    -- Preliminary события (классификатор не уверен) — новость не создаём
    if new.is_preliminary then
        return new;
    end if;

    insert into news (title, body_md, object_ids, status, publish_to, created_by)
    values (new.title, new.note, new.object_ids, 'draft', '{site}', null)
    returning id into v_news_id;

    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    values ('news', v_news_id::text, 'event', new.id::text, 'from_event')
    on conflict do nothing;

    return new;
end $$;

create trigger events_auto_news
    after insert on events
    for each row execute function auto_create_news_from_event();

-- Триггер на подтверждение preliminary события
create or replace function auto_create_news_from_event_confirm() returns trigger
language plpgsql as $$
declare
    v_news_id uuid;
begin
    if old.is_preliminary and not new.is_preliminary then
        insert into news (title, body_md, object_ids, status, publish_to, created_by)
        values (new.title, new.note, new.object_ids, 'draft', '{site}', null)
        returning id into v_news_id;

        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('news', v_news_id::text, 'event', new.id::text, 'from_event')
        on conflict do nothing;
    end if;
    return new;
end $$;

create trigger events_auto_news_on_confirm
    after update of is_preliminary on events
    for each row execute function auto_create_news_from_event_confirm();

-- ── 4. RLS политики ─────────────────────────────────────────────────────────

alter table news enable row level security;

-- Анонимы и viewer видят только опубликованные
create policy news_select_published_anyone on news
    for select using (status = 'published' or user_role() in ('uploader','admin'));

create policy news_insert_uploader on news
    for insert with check (user_role() in ('uploader','admin'));

create policy news_update_uploader on news
    for update using (user_role() in ('uploader','admin'))
    with check (user_role() in ('uploader','admin'));

create policy news_delete_admin on news
    for delete using (user_role() = 'admin');

-- ── 5. Регистрация миграции ─────────────────────────────────────────────────

insert into _applied_migrations (filename) values
    ('20260513000003_news.sql')
on conflict do nothing;
