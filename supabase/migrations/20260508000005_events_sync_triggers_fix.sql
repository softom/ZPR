-- ============================================================================
-- Исправление триггеров sync events.object_ids ↔ event_object_status
-- ============================================================================
-- В Phase 3 (20260508000003) удалены events.is_planned, events.fact_date и
-- event_object_status.is_planned, но триггеры trg_events_sync_objects и
-- trg_events_init_junction остались с обращениями к этим колонкам. UPDATE
-- events.object_ids падал «column is_planned of relation event_object_status
-- does not exist».
--
-- После сплита фактовые события всегда «случились», поэтому при автосинхро-
-- низации junction-строки имеют fact_date = events.date_end.
-- ============================================================================

create or replace function trg_events_sync_objects()
returns trigger language plpgsql as $$
declare
    removed uuid[];
    added   uuid[];
begin
    if current_setting('app.skip_event_sync', true) = 'on' then
        return new;
    end if;

    select coalesce(array_agg(x), '{}'::uuid[]) into removed
      from unnest(coalesce(old.object_ids, '{}'::uuid[])) x
     where x <> all (coalesce(new.object_ids, '{}'::uuid[]));

    select coalesce(array_agg(x), '{}'::uuid[]) into added
      from unnest(coalesce(new.object_ids, '{}'::uuid[])) x
     where x <> all (coalesce(old.object_ids, '{}'::uuid[]));

    delete from event_object_status
     where event_id = new.id
       and object_id = any(removed);

    -- События после сплита 20260508 — всегда факты. fact_date = date_end.
    insert into event_object_status (event_id, object_id, fact_date)
    select new.id, oid, new.date_end
      from unnest(added) as oid
    on conflict do nothing;

    return new;
end$$;

create or replace function trg_events_init_junction()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_event_sync', true) = 'on' then
        return new;
    end if;

    if new.object_ids is null or array_length(new.object_ids, 1) is null then
        return new;
    end if;

    insert into event_object_status (event_id, object_id, fact_date)
    select new.id, oid, new.date_end
      from unnest(new.object_ids) as oid
    on conflict do nothing;

    return new;
end$$;

notify pgrst, 'reload schema';
