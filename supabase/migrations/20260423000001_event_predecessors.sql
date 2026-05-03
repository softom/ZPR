-- ─── Предшественники событий (MS Project–style) ─────────────────────────────
--
-- Позволяет строить сети задач (PDM — Precedence Diagramming Method):
--   каждое событие может иметь N предшественников из любого графика/договора.
--
-- Типы связи (как в MS Project):
--   FS (Finish-to-Start)   — потомок начинается после окончания предшественника
--   SS (Start-to-Start)    — потомок начинается не раньше начала предшественника
--   FF (Finish-to-Finish)  — потомок заканчивается не раньше окончания предшественника
--   SF (Start-to-Finish)   — потомок заканчивается не раньше начала предшественника
--
-- Lag / Lead:
--   lag > 0 — задержка (потомок ещё N дней после предшественника)
--   lag < 0 — опережение / перекрытие (потомок начинается до окончания)
--
-- date_computed события = MAX(собственная дата, MAX всех ограничений предшественников)
-- Это реализует логику критического пути (CPM).
--
-- Связь с существующим date_ref_event_id:
--   date_ref_event_id в events — упрощённая одиночная ссылка (для цепочек договоров).
--   event_predecessors — расширенный механизм для явного планирования и ГПР.
--   При вычислении date_computed оба механизма учитываются, побеждает MAX.

create table event_predecessors (
    id              uuid primary key default gen_random_uuid(),

    -- Событие, которое ЗАВИСИТ от предшественника
    event_id        uuid not null references events(id) on delete cascade,

    -- Предшественник
    predecessor_id  uuid not null references events(id) on delete cascade,

    -- Тип зависимости (MS Project: FS, SS, FF, SF)
    link_type       text not null default 'FS'
                    check (link_type in ('FS', 'SS', 'FF', 'SF')),

    -- Лаг/опережение в днях
    lag             int  not null default 0,
    lag_type        text not null default 'calendar'
                    check (lag_type in ('calendar', 'working')),

    notes           text,
    created_at      timestamptz not null default now(),

    -- Нельзя добавить одну и ту же зависимость дважды
    unique (event_id, predecessor_id, link_type),
    -- Нельзя ссылаться на себя
    check (event_id <> predecessor_id)
);

create index on event_predecessors (event_id);
create index on event_predecessors (predecessor_id);

-- ─── Функция: вычислить ограничение даты от всех предшественников ─────────────
-- Возвращает MAX(дата_ограничения) по всем активным предшественникам события.
-- Для FS/SS разница: FS смотрит на date_end предшественника, SS — на date_start.
create or replace function compute_predecessor_constraint(p_event_id uuid)
returns date language plpgsql stable as $$
declare
    max_date        date := null;
    constraint_date date;
    rec             record;
    pred_start      date;
    pred_end        date;
begin
    for rec in
        select ep.link_type,
               ep.lag,
               ep.lag_type,
               e.date_start,
               e.date_end,
               e.date_computed
          from event_predecessors ep
          join events e on e.id = ep.predecessor_id
         where ep.event_id = p_event_id
    loop
        pred_end   := coalesce(rec.date_end,   rec.date_computed);
        pred_start := coalesce(rec.date_start, rec.date_computed);

        -- Ограничивающая дата в зависимости от типа связи
        constraint_date := case rec.link_type
            when 'FS' then pred_end      -- потомок стартует от окончания предш.
            when 'SS' then pred_start    -- потомок стартует от начала предш.
            when 'FF' then pred_end      -- потомок заканчивается от окончания предш.
            when 'SF' then pred_start    -- потомок заканчивается от начала предш.
            else pred_end
        end;

        if constraint_date is not null then
            if rec.lag_type = 'working' then
                constraint_date := add_working_days(constraint_date, rec.lag);
            else
                constraint_date := constraint_date + rec.lag;
            end if;

            if max_date is null or constraint_date > max_date then
                max_date := constraint_date;
            end if;
        end if;
    end loop;

    return max_date;
end;
$$;

-- ─── Функция: каскадный пересчёт потомков ─────────────────────────────────────
-- Когда date_computed события меняется — пересчитывает всех прямых потомков
-- (и их потомков рекурсивно). Защита от циклов: максимум 30 шагов.
create or replace function propagate_event_date(p_event_id uuid, depth int default 0)
returns void language plpgsql as $$
declare
    succ_id         uuid;
    own_date        date;
    pred_constraint date;
    new_computed    date;
begin
    if depth > 30 then
        raise exception 'Слишком глубокая цепочка предшественников (event_id=%)', p_event_id;
    end if;

    -- Пересчитываем каждого прямого потомка
    for succ_id in
        select event_id
          from event_predecessors
         where predecessor_id = p_event_id
    loop
        -- Собственная дата потомка (из absolute/relative режима)
        select coalesce(date_end, date_start, date_computed)
          into own_date
          from events
         where id = succ_id;

        -- Ограничение от всех предшественников потомка
        pred_constraint := compute_predecessor_constraint(succ_id);

        new_computed := greatest(own_date, pred_constraint);

        update events
           set date_computed = new_computed
         where id = succ_id
           and date_computed is distinct from new_computed;

        -- Рекурсивно пересчитываем потомков этого потомка
        perform propagate_event_date(succ_id, depth + 1);
    end loop;
end;
$$;

-- ─── Триггер: при изменении предшественника — пересчитать зависимое событие ───
create or replace function trg_predecessor_update_event()
returns trigger language plpgsql as $$
declare
    target_event_id uuid;
    own_date        date;
    pred_constraint date;
begin
    target_event_id := coalesce(new.event_id, old.event_id);

    -- Собственная дата события (абсолютная или relative-вычисленная)
    select coalesce(date_end, date_start, date_computed)
      into own_date
      from events
     where id = target_event_id;

    -- Ограничение от всех предшественников
    pred_constraint := compute_predecessor_constraint(target_event_id);

    -- date_computed = MAX(собственная, ограничение предшественников)
    update events
       set date_computed = greatest(own_date, pred_constraint)
     where id = target_event_id;

    return coalesce(new, old);
end;
$$;

create trigger predecessor_update_event
    after insert or update or delete
    on event_predecessors
    for each row execute function trg_predecessor_update_event();

-- ─── Обновление events_compute_date — учитываем предшественников при UPDATE ───
-- Заменяем существующую функцию: после вычисления собственной даты
-- берём MAX с ограничением от event_predecessors (только для UPDATE,
-- при INSERT предшественников ещё нет — они добавляются позже).
create or replace function trg_events_compute_date()
returns trigger language plpgsql as $$
declare
    base_date       date;
    pred_constraint date;
begin
    -- ── Шаг 1: собственная дата (absolute / relative) ────────────────────────
    if new.date_mode = 'absolute' then
        new.date_computed := coalesce(new.date_end, new.date_start);
    else
        select case
                   when new.date_ref_from = 'start'
                   then coalesce(e.date_start, e.date_computed)
                   else coalesce(e.date_end,   e.date_computed)
               end
          into base_date
          from events e
         where e.id = new.date_ref_event_id;

        if base_date is not null then
            if new.date_ref_offset_type = 'working' then
                new.date_computed := add_working_days(base_date, new.date_ref_offset);
            else
                new.date_computed := base_date + new.date_ref_offset;
            end if;
        end if;
    end if;

    -- ── Шаг 2: ограничение от предшественников (только при UPDATE) ───────────
    -- При INSERT event ещё не существует → предшественники добавляются потом.
    if TG_OP = 'UPDATE' then
        pred_constraint := compute_predecessor_constraint(new.id);
        if pred_constraint is not null then
            new.date_computed := greatest(new.date_computed, pred_constraint);
        end if;
    end if;

    return new;
end;
$$;

-- ─── Представление: события с предшественниками (для диаграммы Гантта) ────────
create or replace view event_predecessors_view as
select
    e.id                as event_id,
    e.event_type,
    e.title,
    e.date_computed,
    e.date_start,
    e.date_end,
    e.object_codes,
    ep.predecessor_id,
    ep.link_type,
    ep.lag,
    ep.lag_type,
    pe.title            as predecessor_title,
    pe.date_computed    as predecessor_date,
    pe.object_codes     as predecessor_object_codes
from events e
join event_predecessors ep on ep.event_id = e.id
join events pe on pe.id = ep.predecessor_id;

-- ─── RLS ──────────────────────────────────────────────────────────────────────
alter table event_predecessors enable row level security;

create policy "anon select" on event_predecessors for select using (true);
create policy "service all"  on event_predecessors for all  using (true) with check (true);
