-- ============================================================
-- event_object_status — per-object факт по событиям
-- ============================================================
-- Зеркало task_object_status (см. 20260505000001).
-- Семантика событий проще: is_planned + fact_date (не enum status).
--
-- Триггеры:
--   • event_object_status_recompute    — junction → events.fact_date / is_planned (агрегат)
--   • events_sync_objects              — events.object_ids → junction (sync)
--   • events_init_junction             — INSERT events → init junction
-- Защита от рекурсии — GUC-флаг app.skip_event_sync.

-- ─── Таблица ────────────────────────────────────────────────────
create table event_object_status (
    event_id          uuid not null references events(id) on delete cascade,
    object_id         uuid not null references objects(id) on delete restrict,
    is_planned        boolean not null default true,    -- true=план; false=факт зафиксирован
    fact_date         date,                             -- per-object фактическая дата
    fact_note         text,
    fact_by_entity_id uuid references legal_entities(id),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    primary key (event_id, object_id),
    constraint eos_fact_consistency check (
        (is_planned = true and fact_date is null) or
        (is_planned = false and fact_date is not null)
    )
);

create index event_object_status_object_idx on event_object_status (object_id, is_planned);
create index event_object_status_fact_date_idx on event_object_status (fact_date)
    where fact_date is not null;

comment on table event_object_status is
    'Per-object факт события. events.fact_date / is_planned — denormalized агрегат, поддерживается триггерами.';

-- ─── updated_at ─────────────────────────────────────────────────
create or replace function eos_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger event_object_status_updated_at
    before update on event_object_status
    for each row execute function eos_set_updated_at();

-- ─── Backfill: одна строка на каждую (event, oid in object_ids) ─
-- Берём текущий events.is_planned и events.fact_date.
-- Если событие is_planned=false, но fact_date null — это нарушение, чиним: ставим is_planned=true.
insert into event_object_status (event_id, object_id, is_planned, fact_date)
select e.id,
       oid,
       case when e.is_planned = false and e.fact_date is null then true else e.is_planned end,
       case when e.is_planned = false and e.fact_date is null then null else e.fact_date end
from events e, unnest(e.object_ids) as oid
on conflict do nothing;

-- ─── recompute_event_fact: junction → events (агрегат) ─────────
-- Агрегатные правила:
--   • is_planned = true пока хотя бы у одного объекта is_planned=true
--   • fact_date = NULL если is_planned=true; иначе MAX(fact_date) по всем объектам
create or replace function recompute_event_fact(p_event_id uuid)
returns void language plpgsql as $$
declare
    n_total       int;
    n_planned     int;
    new_planned   boolean;
    new_fact_date date;
begin
    select count(*),
           count(*) filter (where is_planned = true)
      into n_total, n_planned
      from event_object_status
     where event_id = p_event_id;

    -- Нет junction-строк (legacy без объектов или только что вставленное событие) — не трогаем
    if n_total = 0 then return; end if;

    if n_planned > 0 then
        new_planned := true;
        new_fact_date := null;
    else
        -- все объекты завершены → фиксируем максимум по фактам
        new_planned := false;
        select max(fact_date) into new_fact_date
          from event_object_status
         where event_id = p_event_id;
    end if;

    perform set_config('app.skip_event_sync', 'on', true);
    update events
       set is_planned = new_planned,
           fact_date  = new_fact_date
     where id = p_event_id
       and (is_planned is distinct from new_planned or fact_date is distinct from new_fact_date);
    perform set_config('app.skip_event_sync', 'off', true);
end$$;

comment on function recompute_event_fact(uuid) is
    'Пересчитывает events.is_planned/fact_date как агрегат event_object_status.';

-- ─── trg_eos_recompute ────────────────────────────────────────
create or replace function trg_eos_recompute()
returns trigger language plpgsql as $$
begin
    perform recompute_event_fact(coalesce(new.event_id, old.event_id));
    return coalesce(new, old);
end$$;

create trigger event_object_status_recompute
    after insert or update or delete on event_object_status
    for each row execute function trg_eos_recompute();

-- ─── trg_events_sync_objects ──────────────────────────────────
-- При изменении events.object_ids: удаляем строки выпавших объектов
-- (с потерей факта, если был — оставляем как историю или удаляем?
-- Зеркало tasks_object_status: open удаляем, in_progress/done → cancelled).
-- Но у событий нет cancelled-состояния — просто удаляем выпавшие per-object строки.
-- Если факт был — он попадёт в events.fact_date уже не учтённым; будет пересчитано.
create or replace function trg_events_sync_objects()
returns trigger language plpgsql as $$
declare
    removed uuid[];
    added   uuid[];
begin
    if current_setting('app.skip_event_sync', true) = 'on' then
        return new;
    end if;

    select coalesce(array_agg(x), '{}'::uuid[])
      into removed
      from unnest(coalesce(old.object_ids, '{}'::uuid[])) x
     where x <> all (coalesce(new.object_ids, '{}'::uuid[]));

    select coalesce(array_agg(x), '{}'::uuid[])
      into added
      from unnest(coalesce(new.object_ids, '{}'::uuid[])) x
     where x <> all (coalesce(old.object_ids, '{}'::uuid[]));

    delete from event_object_status
     where event_id = new.id
       and object_id = any(removed);

    insert into event_object_status (event_id, object_id, is_planned, fact_date)
    select new.id, oid,
           case when new.is_planned = false and new.fact_date is null then true else new.is_planned end,
           case when new.is_planned = false and new.fact_date is null then null else new.fact_date end
      from unnest(added) as oid
    on conflict do nothing;

    return new;
end$$;

create trigger events_sync_objects
    after update of object_ids on events
    for each row execute function trg_events_sync_objects();

-- ─── trg_events_init_junction ─────────────────────────────────
create or replace function trg_events_init_junction()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_event_sync', true) = 'on' then
        return new;
    end if;

    if new.object_ids is null or array_length(new.object_ids, 1) is null then
        return new;
    end if;

    insert into event_object_status (event_id, object_id, is_planned, fact_date)
    select new.id, oid,
           case when new.is_planned = false and new.fact_date is null then true else new.is_planned end,
           case when new.is_planned = false and new.fact_date is null then null else new.fact_date end
      from unnest(new.object_ids) as oid
    on conflict do nothing;

    return new;
end$$;

create trigger events_init_junction
    after insert on events
    for each row execute function trg_events_init_junction();

-- ─── View: events_by_object ───────────────────────────────────
create or replace view events_by_object as
select
    eos.object_id,
    eos.is_planned         as object_is_planned,
    eos.fact_date          as object_fact_date,
    eos.fact_note          as object_fact_note,
    eos.fact_by_entity_id  as object_fact_by_entity_id,
    e.id, e.event_type, e.title,
    e.is_planned           as aggregate_is_planned,
    e.fact_date            as aggregate_fact_date,
    e.date_start, e.date_end, e.date_computed,
    e.stage_name, e.note
from events e
join event_object_status eos on eos.event_id = e.id;

comment on view events_by_object is
    'Per-object строки событий: object_is_planned/object_fact_date — истинный факт на объекте, aggregate_* — events.* агрегат.';

notify pgrst, 'reload schema';
