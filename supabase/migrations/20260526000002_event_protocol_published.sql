-- ============================================================================
-- Событие 'protocol_published' при первой публикации протокола в Telegram.
-- ============================================================================
-- Расширяет триггер meeting_publications_sync_meeting (миграция
-- 20260526000001): при ПЕРВОЙ успешной публикации (когда
-- meetings.published_at ещё NULL) создаём событие event_type='protocol_published'.
--
-- Идемпотентно: повторная публикация в новые чаты (после добавления
-- нового объекта или нового чата к существующему объекту) не дублирует
-- событие — published_at уже не NULL.
--
-- См. WIKI 14_Модель_событий → event_type='protocol_published',
--    10_Алгоритм_собрания → 26.05.2026 «Публикация протокола в TG».
-- ============================================================================

-- 1. Расширяем events_event_type_check
alter table events drop constraint events_event_type_check;
alter table events add constraint events_event_type_check
  check (event_type = any (array[
    'project_note',
    'meeting',
    'protocol_correction',
    'protocol_published',
    'contract_stage_change'
  ]));

-- 2. Расширяем триггер-функцию: создание события + обновление published_at
create or replace function meeting_publications_sync_meeting()
returns trigger language plpgsql as $$
declare
    v_meeting record;
    v_event_id uuid;
    v_first_publication boolean;
    v_meeting_code text;
    v_meeting_date_str text;
    v_event_title text;
    v_event_note text;
begin
    if new.status <> 'ok' then
        return new;
    end if;

    select * into v_meeting from meetings where id = new.meeting_id;
    if not found then
        return new;
    end if;

    -- Признак «первая публикация» — published_at ещё NULL.
    v_first_publication := v_meeting.published_at is null;

    -- Обновляем published_at = min(существующее, new.sent_at)
    update meetings
       set published_at = least(coalesce(published_at, new.sent_at), new.sent_at)
     where id = new.meeting_id;

    -- Создаём событие только при ПЕРВОЙ публикации.
    if v_first_publication then
        v_meeting_code := coalesce(v_meeting.code,
            'ПРОТ-' || to_char(v_meeting.meeting_date, 'YYYY-MM-DD'));
        v_meeting_date_str := to_char(v_meeting.meeting_date, 'DD.MM.YYYY');

        v_event_title := 'Публикация протокола ' || v_meeting_code;
        v_event_note := 'Протокол собрания «' || v_meeting.title || '» от ' ||
            v_meeting_date_str || ' отправлен в Telegram-чаты, привязанные к объектам.';

        insert into events (
            event_type, title, note, date_start, object_ids,
            derived_source, is_preliminary
        ) values (
            'protocol_published', v_event_title, v_event_note, new.sent_at::date,
            coalesce(v_meeting.object_ids, '{}'::uuid[]),
            'protocol', false
        )
        returning id into v_event_id;

        -- entity_links: event → meeting
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('event', v_event_id::text, 'meeting', new.meeting_id::text, 'references')
        on conflict do nothing;

        -- entity_links: event → каждое юр.лицо собрания
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        select 'event', v_event_id::text, 'legal_entity', mle.legal_entity_id::text, 'belongs_to'
          from meeting_legal_entities mle
         where mle.meeting_id = new.meeting_id
        on conflict do nothing;
    end if;

    return new;
end$$;

comment on function meeting_publications_sync_meeting() is
    'Триггер AFTER INSERT ON meeting_publications. При status=ok: обновляет meetings.published_at = min(); при ПЕРВОЙ публикации (published_at был NULL) создаёт event protocol_published с object_ids собрания и entity_links event→meeting, event→legal_entities.';

notify pgrst, 'reload schema';
