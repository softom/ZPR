-- ============================================================
-- v2.4 — Унификация связей задачи через entity_links (фазы жизненного цикла)
-- ============================================================
-- См. WIKI 19_Сущность_Задача раздел «v2.4», WIKI 09_Правило_связей раздел
-- «Правило удаления legacy-полей».
--
-- Этапы (одна транзакция):
--   0. Additive: новые link_type + task_object_status.resolved_via_link_id
--   1. Аудит до миграции (RAISE NOTICE)
--   2. Backfill данных (meetings.folder_path, tasks.tags ← migrated_from,
--      object_ids ← object_codes, страховка meeting_id)
--   3. INSERT entity_links(raised_from) для tasks.meeting_id
--   4. Best-effort: resolved_via_link_id для исторических закрытий
--   5. Триггеры sync tasks.meeting_id ↔ entity_links(raised_from)
--   6. Final assert + DROP COLUMN
-- ============================================================

begin;

-- =====================================================================
-- Этап 0 — Additive
-- =====================================================================

-- 0.1: Расширить check_constraint entity_links_link_type_check
-- ВАЖНО: сохраняем ВСЕ существующие link_type из текущего constraint
-- (включая from_event/from_calendar_entry/about_entity — добавлены в более
-- поздних миграциях, не отражённых в WIKI 09 на момент 26.05.2026).
alter table entity_links drop constraint if exists entity_links_link_type_check;
alter table entity_links add constraint entity_links_link_type_check
    check (link_type in (
        -- Существующие (preserve):
        'belongs_to','from_document','from_letter','references','implements',
        'from_meeting','from_protocol','assigned_to','blocks','blocked_by',
        'fulfills','from_event','from_calendar_entry','about_entity',
        -- Новые фазовые типы для задач (см. WIKI 19):
        'raised_from','related_to','resolved_by'
    ));

-- 0.2: Колонка task_object_status.resolved_via_link_id
alter table task_object_status
    add column if not exists resolved_via_link_id uuid
        references entity_links(id) on delete set null;

create index if not exists task_object_status_resolved_via_link_idx
    on task_object_status (resolved_via_link_id)
    where resolved_via_link_id is not null;

comment on column task_object_status.resolved_via_link_id is
    'Указатель на entity_link фазы resolved_by — источник этого per-object закрытия. См. WIKI 19_Сущность_Задача «Жизненный цикл связей».';

-- =====================================================================
-- Этап 1 — Аудит до миграции
-- =====================================================================

do $$
declare
    v_has_source_protocol   int;
    v_has_meeting_path      int;
    v_has_migrated_from     int;
    v_has_object_codes      int;
    v_gap_meeting           int;
    v_gap_object_ids        int;
    v_meetings_no_folder    int;
    v_total                 int;
begin
    select count(*) into v_total from tasks;

    select count(*) filter (where source_protocol     is not null) into v_has_source_protocol from tasks;
    select count(*) filter (where source_meeting_path is not null) into v_has_meeting_path    from tasks;
    select count(*) filter (where migrated_from       is not null) into v_has_migrated_from   from tasks;
    select count(*) filter (where array_length(object_codes,1) > 0) into v_has_object_codes from tasks;

    select count(*) filter (where source_protocol is not null and meeting_id is null)
      into v_gap_meeting from tasks;

    select count(*) filter (where array_length(object_codes,1) > 0
                              and coalesce(array_length(object_ids,1),0) = 0)
      into v_gap_object_ids from tasks;

    select count(distinct m.id)
      into v_meetings_no_folder
      from tasks t
      join meetings m on m.id = t.meeting_id
     where m.folder_path is null and t.source_meeting_path is not null;

    raise notice '── AUDIT (before backfill) ──';
    raise notice 'tasks total: %', v_total;
    raise notice 'has source_protocol: %', v_has_source_protocol;
    raise notice 'has source_meeting_path: %', v_has_meeting_path;
    raise notice 'has migrated_from: %', v_has_migrated_from;
    raise notice 'has object_codes: %', v_has_object_codes;
    raise notice 'gap_meeting (source_protocol set but meeting_id null): %', v_gap_meeting;
    raise notice 'gap_object_ids (object_codes set but object_ids empty): %', v_gap_object_ids;
    raise notice 'meetings can receive folder_path from tasks: %', v_meetings_no_folder;
end $$;

-- =====================================================================
-- Этап 2 — Backfill данных
-- =====================================================================

-- 2.a) source_meeting_path → meetings.folder_path
--      Для собраний у которых folder_path NULL и среди привязанных задач есть
--      непустой source_meeting_path — берём MIN (стабильный выбор).
--      Где задачи дают разные значения — берётся первый.
with picked as (
    select t.meeting_id, min(t.source_meeting_path) as path
      from tasks t
      join meetings m on m.id = t.meeting_id
     where m.folder_path is null
       and t.source_meeting_path is not null
     group by t.meeting_id
)
update meetings m
   set folder_path = p.path,
       updated_at  = now()
  from picked p
 where p.meeting_id = m.id
   and m.folder_path is null;

-- 2.b) migrated_from → tasks.tags с префиксом 'legacy_md:'
--      Идемпотентно: не добавляем если такой тег уже есть.
update tasks
   set tags = array_append(tags, 'legacy_md:' || migrated_from)
 where migrated_from is not null
   and not (tags && array[('legacy_md:' || migrated_from)]);

-- 2.c) object_codes → object_ids (на случай если есть gap).
--      Резолвим через objects.code OR aliases ? code.
update tasks t
   set object_ids = coalesce(subq.ids, '{}'::uuid[])
  from (
      select t2.id as task_id,
             array_agg(o.id) filter (where o.id is not null) as ids
        from tasks t2
        cross join lateral unnest(t2.object_codes) as oc
        left join objects o on o.code = oc or o.aliases ? oc
       where array_length(t2.object_codes,1) > 0
         and coalesce(array_length(t2.object_ids,1),0) = 0
       group by t2.id
  ) subq
 where t.id = subq.task_id
   and subq.ids is not null
   and array_length(subq.ids,1) > 0;

-- 2.d) Страховка для source_protocol gap (на текущих данных = 0, но защищаемся
--      на случай редкого dirty-state). Создаёт недостающие meetings и
--      проставляет tasks.meeting_id.
insert into meetings (code, meeting_date, title, status, object_ids)
select distinct
       t.source_protocol,
       t.source_meeting_date,
       'Собрание ' || t.source_protocol,
       'approved',
       coalesce(t.object_ids, '{}'::uuid[])
  from tasks t
 where t.source_protocol is not null
   and t.meeting_id is null
   and t.source_meeting_date is not null
on conflict (code) do nothing;

update tasks t
   set meeting_id = m.id
  from meetings m
 where t.meeting_id is null
   and t.source_protocol is not null
   and m.code = t.source_protocol;

-- =====================================================================
-- Этап 3 — entity_links(raised_from) для tasks.meeting_id
-- =====================================================================

insert into entity_links (from_type, from_id, to_type, to_id, link_type)
select 'task', t.id::text, 'meeting', t.meeting_id::text, 'raised_from'
  from tasks t
 where t.meeting_id is not null
on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;

-- =====================================================================
-- Этап 4 — Best-effort resolved_via_link_id для исторических закрытий
-- =====================================================================
-- Логика: для пары (task, object) со status in ('done','closed') и done_date,
-- если на эту дату существует meeting содержащий object_id в meeting.object_ids —
-- создаётся entity_link(from=task, to=meeting, link_type='resolved_by')
-- и task_object_status.resolved_via_link_id указывает на него.

with closures as (
    select tos.task_id, tos.object_id, tos.done_date, m.id as meeting_id
      from task_object_status tos
      join meetings m on m.meeting_date = tos.done_date
                     and tos.object_id = any(m.object_ids)
     where tos.status in ('done','closed')
       and tos.resolved_via_link_id is null
       and tos.done_date is not null
), inserted_links as (
    insert into entity_links (from_type, from_id, to_type, to_id, link_type, notes)
    select distinct 'task', c.task_id::text, 'meeting', c.meeting_id::text,
           'resolved_by',
           'backfill 26.05.2026: автоматическая привязка к собранию по done_date'
      from closures c
    on conflict (from_type, from_id, to_type, to_id, link_type) do nothing
    returning id, from_id, to_id
)
update task_object_status tos
   set resolved_via_link_id = el.id
  from entity_links el
  join closures c on c.task_id::text = el.from_id and c.meeting_id::text = el.to_id
 where el.from_type = 'task' and el.to_type = 'meeting' and el.link_type = 'resolved_by'
   and tos.task_id = c.task_id
   and tos.object_id = c.object_id
   and tos.resolved_via_link_id is null;

-- =====================================================================
-- Этап 5 — Триггеры sync tasks.meeting_id ↔ entity_links(raised_from)
-- =====================================================================

-- Forward: tasks.meeting_id (изменён) → upsert entity_links(raised_from)
create or replace function trg_tasks_sync_raised_from()
returns trigger language plpgsql as $$
begin
    -- Защита от рекурсии (если придёт из обратного триггера)
    if current_setting('app.skip_task_link_sync', true) = 'on' then
        return new;
    end if;

    -- Был meeting_id, стал NULL → удаляем link
    if new.meeting_id is null and old.meeting_id is not null then
        perform set_config('app.skip_task_link_sync', 'on', true);
        delete from entity_links
         where from_type = 'task' and from_id = new.id::text
           and to_type   = 'meeting' and to_id = old.meeting_id::text
           and link_type = 'raised_from';
        perform set_config('app.skip_task_link_sync', 'off', true);
        return new;
    end if;

    -- Был один meeting_id, стал другой → удаляем старый link, добавляем новый
    if new.meeting_id is not null and old.meeting_id is distinct from new.meeting_id then
        perform set_config('app.skip_task_link_sync', 'on', true);
        if old.meeting_id is not null then
            delete from entity_links
             where from_type = 'task' and from_id = new.id::text
               and to_type   = 'meeting' and to_id = old.meeting_id::text
               and link_type = 'raised_from';
        end if;
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('task', new.id::text, 'meeting', new.meeting_id::text, 'raised_from')
        on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;
        perform set_config('app.skip_task_link_sync', 'off', true);
    end if;

    return new;
end $$;

drop trigger if exists tasks_sync_raised_from on tasks;
create trigger tasks_sync_raised_from
    after update of meeting_id on tasks
    for each row
    execute function trg_tasks_sync_raised_from();

-- Также для INSERT: новая задача с meeting_id → создаём link
create or replace function trg_tasks_init_raised_from()
returns trigger language plpgsql as $$
begin
    if current_setting('app.skip_task_link_sync', true) = 'on' then
        return new;
    end if;
    if new.meeting_id is not null then
        perform set_config('app.skip_task_link_sync', 'on', true);
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('task', new.id::text, 'meeting', new.meeting_id::text, 'raised_from')
        on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;
        perform set_config('app.skip_task_link_sync', 'off', true);
    end if;
    return new;
end $$;

drop trigger if exists tasks_init_raised_from on tasks;
create trigger tasks_init_raised_from
    after insert on tasks
    for each row
    execute function trg_tasks_init_raised_from();

-- Backward: INSERT/DELETE entity_links(raised_from to meeting) → tasks.meeting_id
-- Только если задача — UUID-валидный from_id и to_type='meeting'.
create or replace function trg_entity_links_sync_meeting_id()
returns trigger language plpgsql as $$
declare
    v_task_id   uuid;
    v_meeting_id uuid;
begin
    if current_setting('app.skip_task_link_sync', true) = 'on' then
        return coalesce(new, old);
    end if;

    -- INSERT raised_from → tasks.meeting_id := to_id (если ещё не стоит)
    if tg_op = 'INSERT'
       and new.from_type = 'task'
       and new.to_type   = 'meeting'
       and new.link_type = 'raised_from' then
        begin
            v_task_id    := new.from_id::uuid;
            v_meeting_id := new.to_id::uuid;
        exception when invalid_text_representation then
            return new;  -- невалидный UUID — ничего не делаем
        end;
        perform set_config('app.skip_task_link_sync', 'on', true);
        update tasks set meeting_id = v_meeting_id
         where id = v_task_id and (meeting_id is null or meeting_id <> v_meeting_id);
        perform set_config('app.skip_task_link_sync', 'off', true);
        return new;
    end if;

    -- DELETE raised_from → tasks.meeting_id := NULL (если совпадает с удалённой ссылкой)
    if tg_op = 'DELETE'
       and old.from_type = 'task'
       and old.to_type   = 'meeting'
       and old.link_type = 'raised_from' then
        begin
            v_task_id    := old.from_id::uuid;
            v_meeting_id := old.to_id::uuid;
        exception when invalid_text_representation then
            return old;
        end;
        perform set_config('app.skip_task_link_sync', 'on', true);
        update tasks set meeting_id = null
         where id = v_task_id and meeting_id = v_meeting_id;
        perform set_config('app.skip_task_link_sync', 'off', true);
        return old;
    end if;

    return coalesce(new, old);
end $$;

drop trigger if exists entity_links_sync_meeting_id on entity_links;
create trigger entity_links_sync_meeting_id
    after insert or delete on entity_links
    for each row
    execute function trg_entity_links_sync_meeting_id();

-- =====================================================================
-- Этап 6 — Final assert + DROP
-- =====================================================================

do $$
declare
    v_gap_meeting    int;
    v_gap_object_ids int;
    v_missing_links  int;
    v_after_audit    record;
begin
    -- 6.1: gaps должны быть 0
    select count(*) filter (where source_protocol is not null and meeting_id is null)
      into v_gap_meeting from tasks;
    if v_gap_meeting > 0 then
        raise exception 'gap_meeting: % задач с source_protocol без meeting_id — миграция откатывается', v_gap_meeting;
    end if;

    select count(*) filter (where array_length(object_codes,1) > 0
                              and coalesce(array_length(object_ids,1),0) = 0)
      into v_gap_object_ids from tasks;
    if v_gap_object_ids > 0 then
        raise exception 'gap_object_ids: % задач без object_ids — миграция откатывается', v_gap_object_ids;
    end if;

    -- 6.2: для всех задач с meeting_id должен существовать raised_from link
    select count(*) into v_missing_links
      from tasks t
     where t.meeting_id is not null
       and not exists (
           select 1 from entity_links el
            where el.from_type='task' and el.from_id = t.id::text
              and el.to_type='meeting' and el.to_id = t.meeting_id::text
              and el.link_type='raised_from'
       );
    if v_missing_links > 0 then
        raise exception 'missing_raised_from: % задач с meeting_id без entity_link — миграция откатывается', v_missing_links;
    end if;

    -- 6.3: лог состояния после backfill (для трассировки)
    select
        (select count(*) from tasks)                                  as tasks_total,
        (select count(*) from entity_links where from_type='task' and link_type='raised_from') as raised_from_links,
        (select count(*) from entity_links where from_type='task' and link_type='resolved_by') as resolved_by_links,
        (select count(*) from task_object_status where resolved_via_link_id is not null) as tos_with_resolution
    into v_after_audit;

    raise notice '── AUDIT (after backfill) ──';
    raise notice 'tasks total: %', v_after_audit.tasks_total;
    raise notice 'entity_links raised_from: %', v_after_audit.raised_from_links;
    raise notice 'entity_links resolved_by: %', v_after_audit.resolved_by_links;
    raise notice 'task_object_status with resolved_via_link_id: %', v_after_audit.tos_with_resolution;
end $$;

-- 6.4: чистим индексы (DROP до DROP COLUMN — иначе ругается)
drop index if exists tasks_source_protocol_idx;
drop index if exists tasks_object_codes_idx;

-- 6.5: DROP зависимых view (потом пересоздадим)
drop view if exists tasks_active;
drop view if exists tasks_preliminary;
drop view if exists tasks_by_object;

-- 6.6: DROP COLUMN (одной командой)
alter table tasks
    drop column if exists source_protocol,
    drop column if exists source_meeting_date,
    drop column if exists source_meeting_path,
    drop column if exists migrated_from,
    drop column if exists object_codes;

-- 6.7: Пересоздаём views без legacy-полей

-- tasks_active — open + in_progress, отсортированы по приоритету и сроку
create view tasks_active as
 select id, code, title, explanation, status, priority,
        assignee_org, assignee_entity_id, object_ids, meeting_id,
        due_date, done_date, done_note,
        created_at, updated_at,
        quotes, tags
   from tasks
  where status = any (array['open'::text,'in_progress'::text])
  order by case priority when 'high' then 1 when 'medium' then 2 when 'low' then 3 end,
           due_date,
           created_at;

comment on view tasks_active is
    'Только активные задачи, отсортированы по приоритету и сроку.';

-- tasks_preliminary — только preliminary, для ревью оператором.
-- Сортировка по дате собрания берётся через meeting_id JOIN.
create view tasks_preliminary as
 select t.id, t.code, t.title, t.explanation, t.status, t.priority,
        t.assignee_org, t.assignee_entity_id, t.object_ids, t.meeting_id,
        t.due_date, t.done_date, t.done_note,
        t.created_at, t.updated_at,
        t.quotes, t.tags,
        m.meeting_date
   from tasks t
   left join meetings m on m.id = t.meeting_id
  where t.status = 'preliminary'::text
  order by m.meeting_date desc nulls last, t.code;

comment on view tasks_preliminary is
    'Черновики задач (status=preliminary) для ревью оператором. meeting_date берётся JOIN на meetings.';

-- tasks_by_object — per-object развёртка с новой колонкой resolved_via_link_id
create view tasks_by_object as
select
    tos.object_id,
    tos.status              as object_status,
    tos.done_date           as object_done_date,
    tos.done_note           as object_done_note,
    tos.done_by_entity_id   as object_done_by_entity_id,
    tos.resolved_via_link_id,
    t.id, t.code, t.title,
    t.status                as aggregate_status,
    t.priority,
    t.assignee_org,
    t.assignee_entity_id,
    t.due_date,
    t.meeting_id
from tasks t
join task_object_status tos on tos.task_id = t.id;

comment on view tasks_by_object is
    'Per-object строки задач: object_status — истинный статус задачи на объекте, aggregate_status — агрегат tasks.status. resolved_via_link_id указывает на entity_link фазы resolved_by.';

notify pgrst, 'reload schema';

commit;
