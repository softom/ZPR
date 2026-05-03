-- ─── План vs Факт: причины переносов и каскадный пересчёт от факта ──────────
--
-- 1. Добавляем reason в event_date_editions — причина создания редакции
-- 2. Исправляем триггеры: при расчёте относительных дат используем
--    fact_date предшественника (если выставлена) вместо плановой
-- 3. Обновляем propagate_event_date: обходит оба типа связей
--    (date_ref_event_id + event_predecessors)
-- 4. Новый триггер: при изменении fact_date → пересчитываем всю цепочку потомков

-- ─── 1. Поле reason в event_date_editions ────────────────────────────────────
alter table event_date_editions
    add column if not exists reason text;
-- Примеры: «Задержка аванса», «Задержка проектанта — сложный узел перекрытия»,
--          «Форс-мажор: затопление», «Согласовано с МЛА+ на совещании 20.05»

-- ─── 2. Исправление трг_events_compute_date ──────────────────────────────────
-- fact_date предшественника > плановой дате при вычислении относительных сроков

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
        -- Эффективная дата предшественника: факт (если выполнено) → план
        select coalesce(
                   e.fact_date,
                   case when new.date_ref_from = 'start'
                        then coalesce(e.date_start, e.date_computed)
                        else coalesce(e.date_end,   e.date_computed)
                   end
               )
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

    -- ── Шаг 2: ограничение от event_predecessors (только при UPDATE) ─────────
    if TG_OP = 'UPDATE' then
        pred_constraint := compute_predecessor_constraint(new.id);
        if pred_constraint is not null then
            new.date_computed := greatest(new.date_computed, pred_constraint);
        end if;
    end if;

    return new;
end;
$$;

-- ─── 3. Исправление trg_edition_compute_date ─────────────────────────────────
-- Та же логика: fact_date предшественника для relative редакций

create or replace function trg_edition_compute_date()
returns trigger language plpgsql as $$
declare
    base_date date;
begin
    if new.date_mode = 'absolute' then
        new.date_computed := coalesce(new.date_end, new.date_start);
    else
        select coalesce(
                   e.fact_date,
                   case when new.date_ref_from = 'start'
                        then coalesce(e.date_start, e.date_computed)
                        else coalesce(e.date_end,   e.date_computed)
                   end
               )
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
    return new;
end;
$$;

-- ─── 4. Обновление propagate_event_date ──────────────────────────────────────
-- Обходит оба типа цепочек: date_ref_event_id и event_predecessors.
-- При изменении fact_date у предшественника — пересчитывает потомков.

create or replace function propagate_event_date(p_event_id uuid, depth int default 0)
returns void language plpgsql as $$
declare
    rec          record;
    succ_id      uuid;
    base_date    date;
    new_computed date;
    pred_constr  date;
begin
    if depth > 30 then
        raise exception 'Слишком глубокая цепочка предшественников (event_id=%)', p_event_id;
    end if;

    -- ── Ветка 1: потомки через date_ref_event_id (цепочки договоров) ──────────
    for rec in
        select * from events where date_ref_event_id = p_event_id
    loop
        -- Эффективная дата предшественника: факт > план
        select coalesce(
                   e.fact_date,
                   case when rec.date_ref_from = 'start'
                        then coalesce(e.date_start, e.date_computed)
                        else coalesce(e.date_end,   e.date_computed)
                   end
               )
          into base_date
          from events e
         where e.id = p_event_id;

        if base_date is not null then
            if rec.date_ref_offset_type = 'working' then
                new_computed := add_working_days(base_date, rec.date_ref_offset);
            else
                new_computed := base_date + rec.date_ref_offset;
            end if;

            update events
               set date_computed = new_computed
             where id = rec.id
               and date_computed is distinct from new_computed;

            perform propagate_event_date(rec.id, depth + 1);
        end if;
    end loop;

    -- ── Ветка 2: потомки через event_predecessors (явные MS Project-связи) ────
    for succ_id in
        select event_id from event_predecessors where predecessor_id = p_event_id
    loop
        pred_constr := compute_predecessor_constraint(succ_id);

        select greatest(coalesce(e.date_end, e.date_start), pred_constr)
          into new_computed
          from events e
         where e.id = succ_id;

        update events
           set date_computed = new_computed
         where id = succ_id
           and date_computed is distinct from new_computed;

        perform propagate_event_date(succ_id, depth + 1);
    end loop;
end;
$$;

-- ─── 5. Триггер: fact_date изменилась → пересчитать всю цепочку потомков ─────
create or replace function trg_events_fact_date_changed()
returns trigger language plpgsql as $$
begin
    if new.fact_date is distinct from old.fact_date then
        perform propagate_event_date(new.id);
    end if;
    return new;
end;
$$;

create trigger events_fact_date_propagate
    after update of fact_date on events
    for each row execute function trg_events_fact_date_changed();

-- ─── Представление: история смещений по событию (для отчёта) ─────────────────
create or replace view event_shift_history as
select
    e.id                                        as event_id,
    e.event_type,
    e.title,
    e.object_codes,
    -- Контрактный план (редакция с минимальным приоритетом среди активных)
    first_ed.date_computed                      as plan_contract,
    first_ed.source                             as plan_source,
    -- Текущий план (победившая редакция)
    e.date_computed                             as plan_current,
    -- Факт
    e.fact_date,
    -- Отклонение: факт или текущий план vs контрактный план
    coalesce(e.fact_date, e.date_computed)
        - first_ed.date_computed                as deviation_days,
    -- Редакции с причинами (все кроме первой — это и есть история переносов)
    (
        select jsonb_agg(
            jsonb_build_object(
                'priority',  ed.priority,
                'source',    ed.source,
                'date',      ed.date_computed,
                'reason',    ed.reason,
                'created_at', ed.created_at
            ) order by ed.priority
        )
        from event_date_editions ed
        where ed.event_id = e.id
          and ed.is_active = true
          and ed.priority > (select min(e2.priority) from event_date_editions e2 where e2.event_id = e.id and e2.is_active = true)
    )                                           as shift_history
from events e
left join lateral (
    select date_computed, source
      from event_date_editions
     where event_id = e.id and is_active = true
     order by priority asc, created_at asc
     limit 1
) first_ed on true;
