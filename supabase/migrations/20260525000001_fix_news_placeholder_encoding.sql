-- ============================================================================
-- Фикс кодировки в триггерах news: 'Новое событие' вместо '????? ???????'
-- ============================================================================
-- Контекст: миграция 20260515000001_news_skip_placeholder.sql при применении
-- через psql на Windows-консоли с cp1251 потеряла кириллицу — строка
-- 'Новое событие' превратилась в семь вопросительных знаков. Проверка
-- никогда не срабатывала, поэтому каждое новое событие, созданное через
-- «+ Создать событие» в UI, создавало мусорную news с title='Новое событие'.
--
-- Этот файл нужно применять через `docker cp + docker exec ... psql -f` —
-- НЕ через `psql < file` на Windows.
-- ============================================================================

create or replace function auto_create_news_from_event()
returns trigger language plpgsql as $$
declare
    v_news_id uuid;
    v_pub_at  timestamptz;
begin
    if new.is_preliminary then return new; end if;
    if new.title = 'Новое событие' then return new; end if;  -- placeholder из UI

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

create or replace function trg_events_publish_on_title_change()
returns trigger language plpgsql as $$
declare
    v_news_id uuid;
    v_already_published boolean;
begin
    if new.is_preliminary then return new; end if;
    if new.title = 'Новое событие' then return new; end if;
    if coalesce(old.title, '') <> 'Новое событие' then return new; end if;

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

-- ─── Чистка существующих мусорных news «Новое событие» ──────────────────
-- Для каждой такой news: сначала пересоздаём её title из связанного event,
-- если событие нашлось и имеет реальный title. Иначе — удаляем.

with link_event as (
    select n.id as news_id, e.title as event_title, e.id as event_id
      from news n
      join entity_links el on el.from_id=n.id::text and el.from_type='news'
                          and el.to_type='event' and el.link_type='from_event'
      join events e on e.id::text=el.to_id
     where n.title='Новое событие'
       and e.title is not null
       and e.title <> 'Новое событие'
)
update news n
   set title    = le.event_title,
       body_md  = e.note,
       object_ids = e.object_ids
  from link_event le
  join events e on e.id = le.event_id
 where n.id = le.news_id;

-- Удаляем оставшиеся «Новое событие» news которые так и не получили реального title
delete from entity_links
 where from_type='news'
   and link_type='from_event'
   and from_id in (
       select id::text from news where title='Новое событие'
   );
delete from news where title='Новое событие';

notify pgrst, 'reload schema';
