-- ============================================================================
-- Триггер auto_create_news_from_event: пропускать placeholder-title
-- + новый триггер: публиковать в news, когда title изменился с placeholder
-- ============================================================================
-- Контекст: «+ Создать событие» в UI создаёт заготовку с title='Новое событие'.
-- Раньше эти заготовки сразу попадали в /news, засоряя главную страницу.
-- Теперь news создаётся только когда title действительно отредактирован.
-- ============================================================================

create or replace function auto_create_news_from_event()
returns trigger language plpgsql as $$
declare
    v_news_id uuid;
    v_pub_at  timestamptz;
begin
    if new.is_preliminary then return new; end if;
    if new.title = 'Новое событие' then return new; end if;   -- placeholder — ждём правки title

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
end$$;

-- ─── Триггер на UPDATE title: если вышли из placeholder — публикуем ────────
create or replace function trg_events_publish_on_title_change()
returns trigger language plpgsql as $$
declare
    v_news_id uuid;
    v_already_published boolean;
begin
    if new.is_preliminary then return new; end if;
    if new.title = 'Новое событие' then return new; end if;   -- всё ещё placeholder
    if coalesce(old.title, '') <> 'Новое событие' then return new; end if;  -- было НЕ placeholder

    -- Был placeholder → стало настоящее имя. Проверяем, что news ещё нет.
    select exists(
        select 1 from entity_links
         where from_type='news'
           and to_type='event'
           and to_id=new.id::text
           and link_type='from_event'
    ) into v_already_published;
    if v_already_published then return new; end if;

    insert into news (title, body_md, object_ids,
                      status, publish_to, published_at, created_by)
    values (new.title, new.note, new.object_ids,
            'published', '{site}',
            coalesce(new.date_end, new.date_start, now()::date)::timestamptz,
            null)
    returning id into v_news_id;

    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    values ('news', v_news_id::text, 'event', new.id::text, 'from_event')
    on conflict do nothing;

    return new;
end$$;

drop trigger if exists events_publish_on_title_change on events;
create trigger events_publish_on_title_change
    after update of title on events
    for each row
    execute function trg_events_publish_on_title_change();

notify pgrst, 'reload schema';
