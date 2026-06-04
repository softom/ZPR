-- ============================================================
-- meetings → events: системная гарантия события «Собрание проведено»
-- ============================================================
-- Заменяет UI-логику ensureMeetingEvent (page.tsx) на DB-триггер.
-- Срабатывает при approved/protocoled + непустых object_ids; идемпотентно.
-- Также синхронизирует существующее событие при правках meetings.title/date/objects
-- и при изменении состава meeting_legal_entities.
--
-- См. WIKI 09_Правило_связей: связи только через UUID; entity_links — источник истины.

create or replace function sync_meeting_event(p_meeting_id uuid)
returns void language plpgsql as $$
declare
    v_meeting record;
    v_event_id uuid;
    v_event_title text;
begin
    select * into v_meeting from meetings where id = p_meeting_id;
    if not found then return; end if;

    -- Гейт: только утверждённые/протоколированные собрания с объектами
    if v_meeting.status not in ('approved', 'protocoled') then return; end if;
    if coalesce(array_length(v_meeting.object_ids, 1), 0) = 0 then return; end if;

    -- Гейт: должен быть хотя бы один юр.лицо-участник.
    -- Защищает от пересоздания события при cascade-DELETE meeting_legal_entities:
    -- последняя удаляемая строка увидит count=0 и триггер пропустит синхронизацию.
    if (select count(*) from meeting_legal_entities where meeting_id = p_meeting_id) = 0 then
        return;
    end if;

    v_event_title := 'Собрание: ' || v_meeting.title;

    -- Существующее событие, связанное с этим собранием?
    select from_id::uuid into v_event_id
    from entity_links
    where from_type = 'event' and to_type = 'meeting'
      and to_id = p_meeting_id::text and link_type = 'from_meeting'
    limit 1;

    if v_event_id is null then
        -- Создать
        insert into events (event_type, title, date_start, date_end, object_ids, derived_source)
        values ('meeting', v_event_title, v_meeting.meeting_date, v_meeting.meeting_date,
                v_meeting.object_ids, 'protocol')
        returning id into v_event_id;

        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('event', v_event_id::text, 'meeting', p_meeting_id::text, 'from_meeting')
        on conflict do nothing;
    else
        -- Синхронизировать существующее (если title/date/objects изменились).
        -- UPDATE триггерит events_sync_objects → пересчёт event_object_status.
        update events
        set title = v_event_title,
            date_start = v_meeting.meeting_date,
            date_end = v_meeting.meeting_date,
            object_ids = v_meeting.object_ids
        where id = v_event_id
          and (title is distinct from v_event_title
            or date_start is distinct from v_meeting.meeting_date
            or date_end is distinct from v_meeting.meeting_date
            or object_ids is distinct from v_meeting.object_ids);
    end if;

    -- Синхронизировать entity_links event → legal_entities (belongs_to)
    -- Удалить ссылки на юр.лица, которых больше нет в junction собрания
    delete from entity_links el
    where el.from_type = 'event' and el.from_id = v_event_id::text
      and el.to_type = 'legal_entity' and el.link_type = 'belongs_to'
      and not exists (
        select 1 from meeting_legal_entities mle
        where mle.meeting_id = p_meeting_id
          and mle.legal_entity_id::text = el.to_id
      );

    -- Добавить недостающие
    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    select 'event', v_event_id::text, 'legal_entity', mle.legal_entity_id::text, 'belongs_to'
    from meeting_legal_entities mle
    where mle.meeting_id = p_meeting_id
    on conflict do nothing;
end$$;

comment on function sync_meeting_event(uuid) is
  'Идемпотентно создаёт/синхронизирует событие «Собрание проведено» для собрания. Срабатывает только при status in (approved, protocoled) и непустом object_ids. Вызывается из триггеров на meetings и meeting_legal_entities.';

-- ─── Триггер 1: meetings (status/title/date/object_ids) ──────────
create or replace function trg_meetings_sync_event()
returns trigger language plpgsql as $$
begin
    perform sync_meeting_event(new.id);
    return new;
end$$;

drop trigger if exists meetings_sync_event_trg on meetings;
create trigger meetings_sync_event_trg
    after insert or update of status, title, meeting_date, object_ids on meetings
    for each row execute function trg_meetings_sync_event();

-- ─── Триггер 2: meeting_legal_entities (состав участников) ──────
create or replace function trg_meeting_le_sync_event()
returns trigger language plpgsql as $$
begin
    perform sync_meeting_event(coalesce(new.meeting_id, old.meeting_id));
    return coalesce(new, old);
end$$;

drop trigger if exists meeting_le_sync_event_trg on meeting_legal_entities;
create trigger meeting_le_sync_event_trg
    after insert or update or delete on meeting_legal_entities
    for each row execute function trg_meeting_le_sync_event();

-- ─── Backfill: прогон по всем существующим approved/protocoled ────
-- На текущей БД (на 14.05.2026) все 17 approved meetings уже имеют события —
-- этот блок будет no-op. Сохранён как safety net для миграций будущих сред.
do $$
declare r record;
begin
    for r in select id from meetings where status in ('approved','protocoled') loop
        perform sync_meeting_event(r.id);
    end loop;
end$$;

notify pgrst, 'reload schema';
