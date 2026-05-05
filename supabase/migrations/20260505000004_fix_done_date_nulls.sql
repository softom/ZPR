-- Гигиена данных: задачи и junction-строки со status='done' / 'closed',
-- но done_date IS NULL. После миграции 20260505000001 backfill наследовал
-- NULL из исторических tasks (до 05.05.2026 done_date не был обязательным).
--
-- Решение: проставить best-effort дату — приоритет:
--   1. source_meeting_date (когда задача создана)
--   2. updated_at::date
--   3. current_date

-- 1) Junction: done/closed без done_date → from источника
update task_object_status tos
   set done_date = coalesce(t.source_meeting_date, t.updated_at::date, current_date)
  from tasks t
 where tos.task_id = t.id
   and tos.status in ('done','closed')
   and tos.done_date is null;

-- 2) tasks.status: done/closed без done_date → синхронизируем с агрегатом junction
--    (берём max(done_date) из junction). Делаем это в обход триггеров sync —
--    через прямой UPDATE с временным выключением триггера через GUC-флаг.
do $$
begin
    perform set_config('app.skip_task_sync', 'on', true);

    update tasks t
       set done_date = (
             select max(done_date) from task_object_status
              where task_id = t.id and status in ('done','closed')
           )
     where t.status in ('done','closed')
       and t.done_date is null;

    perform set_config('app.skip_task_sync', 'off', true);
end$$;

-- Гарантия на будущее: NOT NULL для done_date нельзя поставить на колонку
-- (текущие задачи open её не имеют). Поэтому — частичный CHECK constraint:
alter table tasks
    drop constraint if exists tasks_done_date_when_done;
alter table tasks
    add constraint tasks_done_date_when_done
    check (status not in ('done','closed') or done_date is not null);

alter table task_object_status
    drop constraint if exists task_object_status_done_date_when_done;
alter table task_object_status
    add constraint task_object_status_done_date_when_done
    check (status not in ('done','closed') or done_date is not null);

notify pgrst, 'reload schema';
