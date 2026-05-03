-- ============================================================
-- Добавление предварительного статуса задач
-- ============================================================
-- Workflow:
-- 1. /protocol-tasks извлекает задачи из транскрипции → status: preliminary
-- 2. Пользователь ревьюит, удаляет лишнее, корректирует
-- 3. /protocol-build (или ручное утверждение) → status: open (утверждённые)
-- 4. Жизненный цикл: open → in_progress → done → closed/cancelled

alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check
    check (status in ('preliminary','open','in_progress','done','closed','cancelled'));

comment on column tasks.status is
    'preliminary — извлечена скриптом, ждёт ревью; open — утверждена и в протоколе; in_progress/done/closed/cancelled — жизненный цикл';

-- Представление для черновиков
create or replace view tasks_preliminary as
select * from tasks where status = 'preliminary'
order by source_meeting_date desc, code;
comment on view tasks_preliminary is 'Предварительные задачи — после /protocol-tasks, до утверждения';

-- Обновляем tasks_active (только утверждённые в работе)
drop view tasks_active;
create view tasks_active as
select * from tasks
where status in ('open','in_progress')
order by
    case priority when 'high' then 1 when 'medium' then 2 when 'low' then 3 end,
    due_date nulls last,
    created_at;
comment on view tasks_active is 'Утверждённые задачи в работе (open / in_progress)';
