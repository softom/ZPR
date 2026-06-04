-- ============================================================================
-- Авто-новости из событий публикуются сразу (status='published')
-- ============================================================================
-- Причина:
--   А1-правило (28_Сущность_Новость.md): подтверждённое событие = информирование
--   пользователей, не открывающих /events. Если оставлять draft, оператор должен
--   каждое новое событие отдельно «публиковать» — фактически защёлка против
--   самой идеи автоматики.
--
-- Поведение:
--   - Триггер из events (INSERT + confirm) теперь ставит status='published',
--     published_at = coalesce(e.date_end, e.date_start, now()::date)
--   - Ручное создание news (через UI / API) по-прежнему создаёт draft (default
--     в схеме таблицы остаётся 'draft').
--   - Уже существующие draft-новости, созданные триггером (created_by IS NULL,
--     published_at IS NULL) — допубликовываем.
-- ============================================================================

create or replace function auto_create_news_from_event() returns trigger
language plpgsql as $$
declare
    v_news_id uuid;
    v_pub_at  timestamptz;
begin
    if new.is_preliminary then
        return new;
    end if;

    v_pub_at := coalesce(new.date_end, new.date_start, now()::date)::timestamptz;

    insert into news (title, body_md, object_ids,
                      status, publish_to, published_at, created_by)
    values (new.title, new.note, new.object_ids,
            'published', '{site}', v_pub_at, null)
    returning id into v_news_id;

    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    values ('news', v_news_id::text, 'event', new.id::text, 'from_event')
    on conflict do nothing;

    return new;
end $$;

create or replace function auto_create_news_from_event_confirm() returns trigger
language plpgsql as $$
declare
    v_news_id uuid;
    v_pub_at  timestamptz;
begin
    if old.is_preliminary and not new.is_preliminary then
        v_pub_at := coalesce(new.date_end, new.date_start, now()::date)::timestamptz;

        insert into news (title, body_md, object_ids,
                          status, publish_to, published_at, created_by)
        values (new.title, new.note, new.object_ids,
                'published', '{site}', v_pub_at, null)
        returning id into v_news_id;

        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('news', v_news_id::text, 'event', new.id::text, 'from_event')
        on conflict do nothing;
    end if;
    return new;
end $$;

-- Допубликация уже созданных триггером черновиков (created_by IS NULL)
update news n
   set status = 'published',
       published_at = coalesce(
         (select coalesce(e.date_end, e.date_start, n.created_at::date)::timestamptz
            from events e
            join entity_links el
              on el.to_type='event' and el.to_id = e.id::text
             and el.from_type='news' and el.from_id = n.id::text
             and el.link_type='from_event'
           limit 1),
         n.created_at
       )
 where n.status='draft' and n.created_by is null;

insert into _applied_migrations (filename) values
    ('20260513000004_news_auto_publish.sql')
on conflict do nothing;
