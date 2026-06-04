-- ============================================================
-- v2.5 — «Ответственные» задачи через entity_links(assigned_to)
-- ============================================================
-- Дизайн: assignee — это связь задачи с legal_entity И/ИЛИ contact через
-- entity_links(link_type='assigned_to'). Уже разрешено в check_constraint.
--
-- `tasks.assignee_entity_id` (uuid → legal_entities) остаётся как
-- denormalized cache «основная ответственная организация» —
-- по аналогии с `tasks.meeting_id ↔ entity_links(raised_from)`.
--
-- `tasks.assignee_org` (text) остаётся как denormalized snapshot имени
-- организации, синхронизируется триггером с legal_entities.name через FK.
-- Cleanup колонки — отдельной миграцией позже (см. WIKI 19 TODO).
--
-- Этапы (одна транзакция):
--   1. Backfill: tasks.assignee_entity_id → entity_links(assigned_to → legal_entity)
--   2. Sync trigger: tasks.assignee_entity_id ↔ entity_links(assigned_to)
--      + tasks.assignee_org auto-mirror из legal_entities.name
--   3. Final assert + indexes
-- ============================================================

begin;

-- =====================================================================
-- Этап 1 — Backfill entity_links(assigned_to)
-- =====================================================================

insert into entity_links (from_type, from_id, to_type, to_id, link_type)
select 'task', id::text, 'legal_entity', assignee_entity_id::text, 'assigned_to'
  from tasks
 where assignee_entity_id is not null
on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;

-- Аудит
do $$
declare
    v_tasks_with_assignee int;
    v_links_assigned_to   int;
begin
    select count(*) filter (where assignee_entity_id is not null) into v_tasks_with_assignee from tasks;
    select count(*) into v_links_assigned_to
      from entity_links
     where from_type='task' and to_type='legal_entity' and link_type='assigned_to';
    raise notice '── AUDIT: tasks_with_assignee_entity_id=%, entity_links(assigned_to)=%',
                 v_tasks_with_assignee, v_links_assigned_to;
end $$;

-- =====================================================================
-- Этап 2 — Sync triggers (tasks.assignee_entity_id ↔ entity_links)
-- =====================================================================
-- Семантика:
--   - tasks.assignee_entity_id хранит «основную организацию-ответственного».
--   - В entity_links может быть >1 связи assigned_to (несколько ответственных).
--   - Денормализация: assignee_entity_id отражает ПЕРВУЮ привязку (по created_at)
--     к legal_entity. Изменение поля tasks → отражается в entity_links.
--     Изменение entity_links → отражается в tasks (берётся первая).
--   - assignee_org (text) автоматически отзеркаливается из legal_entities.name
--     при INSERT/UPDATE на tasks.

-- 2.1: Forward — tasks.assignee_entity_id UPDATE → upsert entity_link
create or replace function trg_tasks_sync_assigned_to()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_task_link_sync', true) = 'on' then
        return new;
    end if;

    -- meeting_id NULL → NULL: ничего
    if old.assignee_entity_id is null and new.assignee_entity_id is null then
        return new;
    end if;

    perform set_config('app.skip_task_link_sync', 'on', true);

    -- Был старый — удаляем его link (если он не совпадает с новым)
    if old.assignee_entity_id is not null
       and old.assignee_entity_id is distinct from new.assignee_entity_id then
        delete from entity_links
         where from_type='task' and from_id=new.id::text
           and to_type='legal_entity' and to_id=old.assignee_entity_id::text
           and link_type='assigned_to';
    end if;

    -- Новый — добавляем link
    if new.assignee_entity_id is not null then
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('task', new.id::text, 'legal_entity', new.assignee_entity_id::text, 'assigned_to')
        on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;
    end if;

    perform set_config('app.skip_task_link_sync', 'off', true);
    return new;
end $$;

drop trigger if exists tasks_sync_assigned_to on tasks;
create trigger tasks_sync_assigned_to
    after update of assignee_entity_id on tasks
    for each row
    execute function trg_tasks_sync_assigned_to();

-- 2.2: На INSERT задачи — отзеркалить assignee_entity_id в entity_links (если есть)
create or replace function trg_tasks_init_assigned_to()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_task_link_sync', true) = 'on' then
        return new;
    end if;
    if new.assignee_entity_id is not null then
        perform set_config('app.skip_task_link_sync', 'on', true);
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('task', new.id::text, 'legal_entity', new.assignee_entity_id::text, 'assigned_to')
        on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;
        perform set_config('app.skip_task_link_sync', 'off', true);
    end if;
    return new;
end $$;

drop trigger if exists tasks_init_assigned_to on tasks;
create trigger tasks_init_assigned_to
    after insert on tasks
    for each row
    execute function trg_tasks_init_assigned_to();

-- 2.3: Backward — entity_links(assigned_to → legal_entity) → tasks.assignee_entity_id
-- Логика: INSERT первой такой связи → set assignee_entity_id, если NULL.
--         DELETE связи которая = текущему assignee_entity_id → pick remaining
--         (по created_at ASC), либо NULL если их больше нет.
create or replace function trg_entity_links_sync_assignee_entity_id()
returns trigger language plpgsql as $$
declare
    v_task_id   uuid;
    v_target_id uuid;
    v_first     uuid;
begin
    if current_setting('app.skip_task_link_sync', true) = 'on' then
        return coalesce(new, old);
    end if;

    -- INSERT assigned_to → legal_entity
    if tg_op = 'INSERT'
       and new.from_type='task' and new.to_type='legal_entity' and new.link_type='assigned_to' then
        begin
            v_task_id   := new.from_id::uuid;
            v_target_id := new.to_id::uuid;
        exception when invalid_text_representation then
            return new;
        end;
        perform set_config('app.skip_task_link_sync', 'on', true);
        update tasks set assignee_entity_id = v_target_id
         where id = v_task_id and assignee_entity_id is null;
        perform set_config('app.skip_task_link_sync', 'off', true);
        return new;
    end if;

    -- DELETE assigned_to → legal_entity
    if tg_op = 'DELETE'
       and old.from_type='task' and old.to_type='legal_entity' and old.link_type='assigned_to' then
        begin
            v_task_id   := old.from_id::uuid;
            v_target_id := old.to_id::uuid;
        exception when invalid_text_representation then
            return old;
        end;
        -- Если удалили link который = текущему assignee_entity_id — переключиться
        -- на следующего (по created_at ASC), либо NULL
        select to_id::uuid into v_first
          from entity_links
         where from_type='task' and from_id=v_task_id::text
           and to_type='legal_entity' and link_type='assigned_to'
         order by created_at asc
         limit 1;
        perform set_config('app.skip_task_link_sync', 'on', true);
        update tasks set assignee_entity_id = v_first
         where id = v_task_id and assignee_entity_id = v_target_id;
        perform set_config('app.skip_task_link_sync', 'off', true);
        return old;
    end if;

    return coalesce(new, old);
end $$;

drop trigger if exists entity_links_sync_assignee_entity_id on entity_links;
create trigger entity_links_sync_assignee_entity_id
    after insert or delete on entity_links
    for each row
    execute function trg_entity_links_sync_assignee_entity_id();

-- 2.4: tasks.assignee_org как denormalized snapshot legal_entities.name
-- Синхронизируется автоматически при INSERT/UPDATE OF assignee_entity_id.
create or replace function trg_tasks_mirror_assignee_org()
returns trigger language plpgsql as $$
declare
    v_name text;
begin
    -- Только если изменился assignee_entity_id (или INSERT)
    if tg_op = 'INSERT'
       or new.assignee_entity_id is distinct from old.assignee_entity_id then
        if new.assignee_entity_id is not null then
            select name into v_name from legal_entities where id = new.assignee_entity_id;
            new.assignee_org := v_name;
        else
            -- assignee_entity_id NULL → assignee_org NULL (если нет ручного override)
            -- Не трогаем если уже NULL.
            if new.assignee_org is not null then
                new.assignee_org := null;
            end if;
        end if;
    end if;
    return new;
end $$;

drop trigger if exists tasks_mirror_assignee_org on tasks;
create trigger tasks_mirror_assignee_org
    before insert or update of assignee_entity_id on tasks
    for each row
    execute function trg_tasks_mirror_assignee_org();

-- Backfill: переcинхронизировать существующие записи (там где assignee_entity_id
-- задан, а assignee_org либо пустое, либо устарело).
update tasks t
   set assignee_org = le.name
  from legal_entities le
 where t.assignee_entity_id = le.id
   and (t.assignee_org is null or t.assignee_org is distinct from le.name);

-- =====================================================================
-- Этап 3 — Final assert
-- =====================================================================

do $$
declare
    v_missing int;
    v_total_assigned int;
begin
    select count(*) into v_missing
      from tasks t
     where t.assignee_entity_id is not null
       and not exists (
           select 1 from entity_links el
            where el.from_type='task' and el.from_id = t.id::text
              and el.to_type='legal_entity' and el.to_id = t.assignee_entity_id::text
              and el.link_type='assigned_to'
       );
    if v_missing > 0 then
        raise exception 'assert: % задач с assignee_entity_id без entity_link(assigned_to) — миграция откатывается', v_missing;
    end if;

    select count(*) into v_total_assigned
      from entity_links
     where from_type='task' and to_type='legal_entity' and link_type='assigned_to';
    raise notice '── DONE: entity_links(assigned_to) total=%', v_total_assigned;
end $$;

-- =====================================================================
-- Индексы для быстрой выборки assignees (задача → ответственные)
-- (entity_links уже имеет общий индекс по from_type+from_id; этого достаточно)
-- =====================================================================

notify pgrst, 'reload schema';

commit;
