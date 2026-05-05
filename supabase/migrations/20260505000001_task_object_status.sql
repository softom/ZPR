-- ============================================================
-- task_object_status — per-object статусы задач
-- ============================================================
-- См. план wiki-twinkling-moore.md → "Per-object статусы задач".
-- См. WIKI 20_Правило_связей.md (UUID-связи между сущностями).
--
-- Заменяет агрегатный tasks.status per-object статусом.
-- tasks.status остаётся как denormalized агрегат, поддерживается
-- триггерами:
--   • task_object_status_recompute    — junction → tasks (агрегат)
--   • tasks_sync_objects              — tasks.object_ids → junction (sync)
--   • tasks_sync_status               — tasks.status preliminary→open → init junction
--   • tasks_init_junction             — INSERT tasks (не preliminary) → init junction
-- Защита от рекурсии — GUC-флаг app.skip_task_sync.

-- ─── Таблица ────────────────────────────────────────────────────
create table task_object_status (
    task_id     uuid not null references tasks(id) on delete cascade,
    object_id   uuid not null references objects(id) on delete restrict,
    status      text not null default 'open'
                check (status in ('open','in_progress','done','closed','cancelled')),
    done_date   date,
    done_note   text,
    done_by_entity_id uuid references legal_entities(id),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    primary key (task_id, object_id)
);

create index task_object_status_object_idx on task_object_status (object_id, status);
create index task_object_status_status_idx on task_object_status (status);
create index task_object_status_done_date_idx on task_object_status (done_date)
    where done_date is not null;

comment on table task_object_status is
    'Per-object статус задачи. tasks.status — denormalized агрегат, поддерживается триггерами.';

-- ─── updated_at ─────────────────────────────────────────────────
create or replace function tos_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger task_object_status_updated_at
    before update on task_object_status
    for each row execute function tos_set_updated_at();

-- ─── Backfill: одна строка на каждую (task, object_ids[i]) ─────
-- Только для не-preliminary задач (preliminary живёт на уровне tasks.status).
insert into task_object_status (task_id, object_id, status, done_date, done_note)
select t.id, oid, t.status, t.done_date, t.done_note
from tasks t, unnest(t.object_ids) as oid
where t.status != 'preliminary'
on conflict do nothing;

-- ─── recompute_task_status: junction → tasks (агрегат) ─────────
create or replace function recompute_task_status(p_task_id uuid)
returns void language plpgsql as $$
declare
    n_total  int;
    n_open   int;
    n_inprog int;
    new_status    text;
    new_done_date date;
    new_done_note text;
begin
    select count(*),
           count(*) filter (where status = 'open'),
           count(*) filter (where status = 'in_progress')
      into n_total, n_open, n_inprog
      from task_object_status
     where task_id = p_task_id;

    -- нет junction-строк — задача-черновик или legacy-без-объектов; не трогаем
    if n_total = 0 then return; end if;

    if n_open > 0 then
        new_status := 'open';
    elsif n_inprog > 0 then
        new_status := 'in_progress';
    else
        select 'done',
               max(done_date),
               (array_agg(done_note) filter (where done_note is not null))[1]
          into new_status, new_done_date, new_done_note
          from task_object_status
         where task_id = p_task_id
           and status in ('done','closed');

        -- Все строки cancelled
        if new_status is null then
            new_status := 'cancelled';
        end if;
    end if;

    -- защита от рекурсии sync-триггеров
    perform set_config('app.skip_task_sync', 'on', true);
    update tasks
       set status    = new_status,
           done_date = case when new_status = 'done'
                            then coalesce(new_done_date, done_date)
                            else done_date end,
           done_note = case when new_status = 'done'
                            then coalesce(new_done_note, done_note)
                            else done_note end
     where id = p_task_id;
    perform set_config('app.skip_task_sync', 'off', true);
end$$;

comment on function recompute_task_status(uuid) is
    'Пересчитывает tasks.status как агрегат task_object_status. Worst-case: open > in_progress > done; cancelled — если все строки cancelled.';

-- ─── trg_tos_recompute: AFTER INSERT/UPDATE/DELETE на junction ─
create or replace function trg_tos_recompute()
returns trigger language plpgsql as $$
begin
    perform recompute_task_status(coalesce(new.task_id, old.task_id));
    return coalesce(new, old);
end$$;

create trigger task_object_status_recompute
    after insert or update or delete on task_object_status
    for each row execute function trg_tos_recompute();

-- ─── trg_tasks_sync_objects: tasks.object_ids → junction sync ──
create or replace function trg_tasks_sync_objects()
returns trigger language plpgsql as $$
declare
    removed uuid[];
    added   uuid[];
begin
    -- Если recompute_task_status выставил флаг — пропускаем
    if current_setting('app.skip_task_sync', true) = 'on' then
        return new;
    end if;

    -- removed = old - new
    select coalesce(array_agg(x), '{}'::uuid[])
      into removed
      from unnest(coalesce(old.object_ids, '{}'::uuid[])) x
     where x <> all (coalesce(new.object_ids, '{}'::uuid[]));

    -- added = new - old
    select coalesce(array_agg(x), '{}'::uuid[])
      into added
      from unnest(coalesce(new.object_ids, '{}'::uuid[])) x
     where x <> all (coalesce(old.object_ids, '{}'::uuid[]));

    -- Открепили объект где статус был 'open' → DELETE (никаких следов)
    delete from task_object_status
     where task_id = new.id
       and object_id = any(removed)
       and status = 'open';

    -- Открепили объект который был in_progress/done/closed → cancelled (история)
    update task_object_status
       set status = 'cancelled',
           updated_at = now()
     where task_id = new.id
       and object_id = any(removed)
       and status in ('in_progress','done','closed');

    -- Прикрепили новый объект → INSERT со статусом из tasks.status
    -- (preliminary не пишется — junction для preliminary задач пуст)
    if new.status != 'preliminary' then
        insert into task_object_status (task_id, object_id, status)
        select new.id, oid, new.status
          from unnest(added) as oid
        on conflict do nothing;
    end if;

    return new;
end$$;

create trigger tasks_sync_objects
    after update of object_ids on tasks
    for each row execute function trg_tasks_sync_objects();

-- ─── trg_tasks_sync_status: preliminary → open (approval) ──────
-- При переходе preliminary → не-preliminary создаём строки junction
-- для всех текущих object_ids задачи.
create or replace function trg_tasks_sync_status()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_task_sync', true) = 'on' then
        return new;
    end if;

    if old.status = 'preliminary' and new.status != 'preliminary' then
        insert into task_object_status (task_id, object_id, status)
        select new.id, oid, new.status
          from unnest(coalesce(new.object_ids, '{}'::uuid[])) as oid
        on conflict do nothing;
    end if;

    return new;
end$$;

create trigger tasks_sync_status
    after update of status on tasks
    for each row execute function trg_tasks_sync_status();

-- ─── trg_tasks_init_junction: INSERT tasks (не preliminary) ────
create or replace function trg_tasks_init_junction()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_task_sync', true) = 'on' then
        return new;
    end if;

    if new.status = 'preliminary' then
        return new;
    end if;

    if new.object_ids is null or array_length(new.object_ids, 1) is null then
        return new;
    end if;

    insert into task_object_status (task_id, object_id, status)
    select new.id, oid, new.status
      from unnest(new.object_ids) as oid
    on conflict do nothing;

    return new;
end$$;

create trigger tasks_init_junction
    after insert on tasks
    for each row execute function trg_tasks_init_junction();

-- ─── View: tasks_by_object с per-object статусом ───────────────
drop view if exists tasks_by_object;

create view tasks_by_object as
select
    tos.object_id,
    tos.status              as object_status,
    tos.done_date           as object_done_date,
    tos.done_note           as object_done_note,
    tos.done_by_entity_id   as object_done_by_entity_id,
    t.id, t.code, t.title,
    t.status                as aggregate_status,
    t.priority,
    t.assignee_org,
    t.assignee_entity_id,
    t.due_date,
    t.source_meeting_date,
    t.meeting_id
from tasks t
join task_object_status tos on tos.task_id = t.id;

comment on view tasks_by_object is
    'Per-object строки задач: object_status — истинный статус задачи на объекте, aggregate_status — агрегат tasks.status.';

notify pgrst, 'reload schema';
