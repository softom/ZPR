-- ============================================================================
-- Фаза 1 разделения СОБЫТИЕ ↔ КАЛЕНДАРЬ ОБЪЕКТА
-- ============================================================================
-- Контекст: см. WIKI 14_Модель_событий v6.0 + 15_Календарь_объекта.md
--
-- Создаём параллельную "плановую" сторону: договорные события
-- (fin_*, work_*, appr_*, exec_*, contract_*) переедут сюда из events
-- в Фазе 2 (миграция 20260508000002), а в Фазе 3 (20260508000003) из events
-- будут удалены плановые колонки.
--
-- ROLLBACK сценарий: см. конец файла (закомментированный блок).
-- ============================================================================

-- ─── Основная таблица ──────────────────────────────────────────────────────
create table calendar_entries (
    id                   uuid primary key default gen_random_uuid(),
    entry_type           text not null,                                   -- бывший event_type
    title                text not null,
    -- ── Привязка к объекту (UUID, см. WIKI 09_Правило_связей) ──
    object_ids           uuid[] not null default '{}',
    -- ── Формула даты ──
    date_mode            text not null default 'absolute'
                         check (date_mode in ('absolute','relative')),
    date_start           date,
    date_end             date,
    date_ref_entry_id    uuid references calendar_entries(id) on delete set null,
    date_ref_from        text default 'end' check (date_ref_from in ('start','end')),
    date_ref_offset      int not null default 0,
    date_ref_offset_type text not null default 'calendar' check (date_ref_offset_type in ('calendar','working')),
    date_computed        date,
    -- ── Длительность работ ──
    duration_note        text,
    exec_days            smallint,
    exec_type            text default 'calendar' check (exec_type in ('working','calendar')),
    is_manual            boolean not null default false,
    -- ── Этап ──
    stage_name           text,
    stage_number         int,
    -- ── Аудит ──
    created_at           timestamptz not null default now()
);

create index calendar_entries_date_computed_idx on calendar_entries (date_computed);
create index calendar_entries_date_end_idx       on calendar_entries (date_end);
create index calendar_entries_entry_type_idx     on calendar_entries (entry_type);
create index calendar_entries_date_ref_idx       on calendar_entries (date_ref_entry_id);
create index calendar_entries_object_ids_idx     on calendar_entries using gin (object_ids);

comment on table  calendar_entries is
    'Календарь объекта: плановые/прогнозные вехи от пунктов договора (fin_*, work_*, appr_*, exec_*, contract_*). Срез 5.1 events с date_mode/relative-цепочкой. См. WIKI 15_Календарь_объекта.';
comment on column calendar_entries.entry_type is
    'Тип календарной вехи (бывший event_type). См. WIKI 15.';
comment on column calendar_entries.date_ref_entry_id is
    'FK на родителя в формульной цепочке. При миграции UUID сохраняем (см. 20260508000002).';

-- ─── Per-object junction (зеркало event_object_status) ─────────────────────
create table calendar_object_status (
    calendar_id       uuid not null references calendar_entries(id) on delete cascade,
    object_id         uuid not null references objects(id) on delete restrict,
    is_planned        boolean not null default true,
    fact_date         date,
    fact_note         text,
    fact_by_entity_id uuid references legal_entities(id),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    primary key (calendar_id, object_id),
    constraint cos_fact_consistency check (
        (is_planned = true  and fact_date is null) or
        (is_planned = false and fact_date is not null)
    )
);

create index calendar_object_status_object_idx on calendar_object_status (object_id, is_planned);
create index calendar_object_status_fact_date_idx on calendar_object_status (fact_date) where fact_date is not null;

comment on table calendar_object_status is
    'Per-object план/факт по календарной вехе. Источник истины для фактических дат — здесь. Триггер пересчитывает агрегаты в calendar_entries.';

-- ─── История правок дат (зеркало event_date_editions) ──────────────────────
create table calendar_date_editions (
    id                   uuid primary key default gen_random_uuid(),
    calendar_id          uuid not null references calendar_entries(id) on delete cascade,
    priority             int not null default 1,
    source               text not null,
    source_entity_type   text,
    source_entity_id     uuid,
    date_mode            text not null default 'absolute' check (date_mode in ('absolute','relative')),
    date_start           date,
    date_end             date,
    date_ref_entry_id    uuid references calendar_entries(id) on delete set null,
    date_ref_from        text not null default 'end' check (date_ref_from in ('start','end')),
    date_ref_offset      int not null default 0,
    date_ref_offset_type text not null default 'calendar' check (date_ref_offset_type in ('calendar','working')),
    date_computed        date,
    duration_note        text,
    is_active            boolean not null default true,
    created_at           timestamptz not null default now(),
    reason               text,
    exec_days            smallint,
    exec_type            text default 'calendar' check (exec_type in ('working','calendar')),
    is_manual            boolean not null default false
);

create index calendar_date_editions_calendar_idx on calendar_date_editions (calendar_id);
create index calendar_date_editions_active_idx   on calendar_date_editions (calendar_id, is_active);

comment on table calendar_date_editions is
    'История правок дат для календарных вех (причины задержек, источник изменения). Зеркало event_date_editions.';

-- ─── MS Project-стиль предшественники (зеркало event_predecessors) ─────────
create table calendar_predecessors (
    id             uuid primary key default gen_random_uuid(),
    calendar_id    uuid not null references calendar_entries(id) on delete cascade,
    predecessor_id uuid not null references calendar_entries(id) on delete cascade,
    link_type      text not null default 'FS' check (link_type in ('FS','SS','FF','SF')),
    lag            int not null default 0,
    lag_type       text not null default 'calendar' check (lag_type in ('calendar','working')),
    notes          text,
    created_at     timestamptz not null default now(),
    constraint calendar_predecessors_unique unique (calendar_id, predecessor_id, link_type),
    constraint calendar_predecessors_no_self check (calendar_id <> predecessor_id)
);

create index calendar_predecessors_calendar_idx on calendar_predecessors (calendar_id);

comment on table calendar_predecessors is
    'MS Project-стиль зависимости: FS/SS/FF/SF + lag (раб./календ.). Параллельно formula chain через date_ref_entry_id.';

-- ─── Функция: расчёт ограничения от предшественников ───────────────────────
create or replace function compute_calendar_predecessor_constraint(p_calendar_id uuid)
returns date language plpgsql stable as $$
declare
    max_date        date := null;
    constraint_date date;
    rec             record;
    pred_start      date;
    pred_end        date;
begin
    for rec in
        select cp.link_type, cp.lag, cp.lag_type,
               c.date_start, c.date_end, c.date_computed
          from calendar_predecessors cp
          join calendar_entries c on c.id = cp.predecessor_id
         where cp.calendar_id = p_calendar_id
    loop
        pred_end   := coalesce(rec.date_end,   rec.date_computed);
        pred_start := coalesce(rec.date_start, rec.date_computed);
        constraint_date := case rec.link_type
            when 'FS' then pred_end
            when 'SS' then pred_start
            when 'FF' then pred_end
            when 'SF' then pred_start
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

-- ─── Триггер: пересчёт date_computed (BEFORE INS/UPD) ──────────────────────
create or replace function trg_calendar_compute_date()
returns trigger language plpgsql as $$
declare
    base_date       date;
    pred_constraint date;
begin
    if new.date_mode = 'absolute' then
        new.date_computed := coalesce(new.date_end, new.date_start);
    else
        select coalesce(
                   (select max(fact_date) from calendar_object_status where calendar_id = e.id),
                   case when new.date_ref_from = 'start'
                        then coalesce(e.date_start, e.date_computed)
                        else coalesce(e.date_end,   e.date_computed)
                   end
               )
          into base_date
          from calendar_entries e
         where e.id = new.date_ref_entry_id;
        if base_date is not null then
            if new.date_ref_offset_type = 'working' then
                new.date_computed := add_working_days(base_date, new.date_ref_offset);
            else
                new.date_computed := base_date + new.date_ref_offset;
            end if;
        end if;
    end if;
    if TG_OP = 'UPDATE' then
        pred_constraint := compute_calendar_predecessor_constraint(new.id);
        if pred_constraint is not null then
            new.date_computed := greatest(new.date_computed, pred_constraint);
        end if;
    end if;
    return new;
end;
$$;

create trigger calendar_compute_date
before insert or update of
    date_mode, date_start, date_end,
    date_ref_entry_id, date_ref_from, date_ref_offset, date_ref_offset_type
on calendar_entries
for each row
execute function trg_calendar_compute_date();

-- ─── Каскадное распространение даты (рекурсивно по потомкам) ───────────────
create or replace function propagate_calendar_date(p_calendar_id uuid, depth integer default 0)
returns void language plpgsql as $$
declare
    rec          record;
    succ_id      uuid;
    base_date    date;
    new_computed date;
    pred_constr  date;
begin
    if depth > 30 then
        raise exception 'Превышена глубина рекурсии распространения даты (calendar_id=%)', p_calendar_id;
    end if;

    -- 1. Прямые потомки через date_ref_entry_id
    for rec in select * from calendar_entries where date_ref_entry_id = p_calendar_id
    loop
        select coalesce(
                   (select max(fact_date) from calendar_object_status where calendar_id = e.id),
                   case when rec.date_ref_from = 'start'
                        then coalesce(e.date_start, e.date_computed)
                        else coalesce(e.date_end,   e.date_computed)
                   end
               )
          into base_date
          from calendar_entries e
         where e.id = p_calendar_id;
        if base_date is not null then
            if rec.date_ref_offset_type = 'working' then
                new_computed := add_working_days(base_date, rec.date_ref_offset);
            else
                new_computed := base_date + rec.date_ref_offset;
            end if;
            update calendar_entries
               set date_computed = new_computed
             where id = rec.id
               and date_computed is distinct from new_computed;
            perform propagate_calendar_date(rec.id, depth + 1);
        end if;
    end loop;

    -- 2. Потомки через calendar_predecessors (MS Project)
    for succ_id in select calendar_id from calendar_predecessors where predecessor_id = p_calendar_id
    loop
        pred_constr := compute_calendar_predecessor_constraint(succ_id);
        select greatest(coalesce(c.date_end, c.date_start), pred_constr)
          into new_computed
          from calendar_entries c
         where c.id = succ_id;
        update calendar_entries
           set date_computed = new_computed
         where id = succ_id
           and date_computed is distinct from new_computed;
        perform propagate_calendar_date(succ_id, depth + 1);
    end loop;
end;
$$;

-- ─── Пересчёт агрегата is_planned по junction ──────────────────────────────
-- В calendar_entries колонок is_planned/fact_date НЕТ (мы их не выносим),
-- агрегат живёт в calendar_object_status через max(fact_date). Для UI
-- агрегатные значения вычисляются на лету или через VIEW.
-- Но триггер на junction всё равно нужен — каскадно протолкнуть дату по
-- цепочке formula chain, когда меняется fact_date.

create or replace function trg_cos_propagate()
returns trigger language plpgsql as $$
begin
    -- При изменении fact_date по объекту — пересчитываем потомков
    -- (max fact_date по родителю используется в propagate_calendar_date).
    perform propagate_calendar_date(coalesce(new.calendar_id, old.calendar_id));
    return coalesce(new, old);
end;
$$;

create trigger calendar_object_status_propagate
after insert or update of fact_date or delete
on calendar_object_status
for each row
execute function trg_cos_propagate();

create or replace function cos_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger calendar_object_status_updated_at
before update on calendar_object_status
for each row
execute function cos_set_updated_at();

-- ─── Расширяем entity_links: добавляем 'calendar_entry' ────────────────────
alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links drop constraint entity_links_to_type_check;

alter table entity_links add constraint entity_links_from_type_check
    check (from_type in ('event','calendar_entry','document','letter','object',
                         'milestone','contractor','meeting','task','legal_entity',
                         'contact','meeting_topic'));

alter table entity_links add constraint entity_links_to_type_check
    check (to_type in ('event','calendar_entry','document','letter','object',
                       'milestone','contractor','meeting','task','legal_entity',
                       'contact','meeting_topic'));

-- Расширяем link_type для семантической связи "событие закрывает календарную веху"
alter table entity_links drop constraint entity_links_link_type_check;
alter table entity_links add constraint entity_links_link_type_check
    check (link_type in ('belongs_to','from_document','from_letter','references',
                         'implements','from_meeting','from_protocol','assigned_to',
                         'blocks','blocked_by',
                         'fulfills'));

comment on column entity_links.link_type is
    'belongs_to/assigned_to — стандарт. fulfills — событие-факт закрывает плановую веху календаря.';

-- ─── RLS policies (зеркало events) ─────────────────────────────────────────
alter table calendar_entries        enable row level security;
alter table calendar_object_status  enable row level security;
alter table calendar_date_editions  enable row level security;
alter table calendar_predecessors   enable row level security;

create policy "anon select" on calendar_entries        for select using (true);
create policy "service all" on calendar_entries        using (true) with check (true);
create policy "anon select" on calendar_object_status  for select using (true);
create policy "service all" on calendar_object_status  using (true) with check (true);
create policy "anon select" on calendar_date_editions  for select using (true);
create policy "service all" on calendar_date_editions  using (true) with check (true);
create policy "anon select" on calendar_predecessors   for select using (true);
create policy "service all" on calendar_predecessors   using (true) with check (true);

notify pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (выполнять вручную при необходимости отката):
-- ----------------------------------------------------------------------------
-- drop trigger if exists calendar_object_status_propagate on calendar_object_status;
-- drop trigger if exists calendar_object_status_updated_at on calendar_object_status;
-- drop trigger if exists calendar_compute_date on calendar_entries;
-- drop function if exists trg_calendar_compute_date;
-- drop function if exists trg_cos_propagate;
-- drop function if exists cos_set_updated_at;
-- drop function if exists propagate_calendar_date;
-- drop function if exists compute_calendar_predecessor_constraint;
-- drop table if exists calendar_predecessors;
-- drop table if exists calendar_date_editions;
-- drop table if exists calendar_object_status;
-- drop table if exists calendar_entries;
-- alter table entity_links drop constraint entity_links_from_type_check;
-- alter table entity_links drop constraint entity_links_to_type_check;
-- alter table entity_links drop constraint entity_links_link_type_check;
-- (восстановить старые constraint-ы из 20260505000003_drop_event_entity_polymorphic)
-- ============================================================================
