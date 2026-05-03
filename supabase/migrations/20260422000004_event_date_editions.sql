-- ─── Редакции дат событий ─────────────────────────────────────────────────────
--
-- Любое событие может иметь несколько определений даты из разных источников.
-- Система выбирает редакцию с наибольшим приоритетом.
--
-- Стандартные уровни приоритета:
--   1  — план из первичного договора
--   2  — план из ДС-1
--   3  — план из ДС-2  (и т.д., каждый следующий ДС +1)
--   10 — факт (всегда приоритетнее плана)
--
-- Любая редакция содержит ПОЛНОЕ определение даты:
--   date_mode = 'absolute' → дата задана явно (date_end)
--   date_mode = 'relative' → дата = другое событие + N дней

create table event_date_editions (
    id               uuid primary key default gen_random_uuid(),

    event_id         uuid not null references events(id) on delete cascade,

    -- ── Приоритет ─────────────────────────────────────────────────────────────
    priority         int not null default 1,

    -- ── Источник редакции ─────────────────────────────────────────────────────
    source           text not null,
    -- «Договор 200326-203-1-ДУ», «ДС-1», «Факт», «Протокол совещания»

    source_entity_type text,   -- 'document' | 'meeting'
    source_entity_id   uuid,   -- FK к документу-источнику

    -- ── Определение даты ──────────────────────────────────────────────────────
    date_mode        text not null default 'absolute'
                     check (date_mode in ('absolute', 'relative')),

    -- Абсолютная дата
    date_start       date,
    date_end         date,

    -- Относительная дата
    date_ref_event_id    uuid references events(id) on delete set null,
    date_ref_from        text not null default 'end'
                         check (date_ref_from in ('start', 'end')),
    date_ref_offset      int  not null default 0,
    date_ref_offset_type text not null default 'calendar'
                         check (date_ref_offset_type in ('calendar', 'working')),

    -- Вычисленная дата для этой редакции (заполняется триггером)
    date_computed    date,

    -- Оригинальная формулировка из источника
    duration_note    text,
    -- «35 рабочих дней с даты начала выполнения работ»

    -- ── Статус ────────────────────────────────────────────────────────────────
    is_active        boolean not null default true,
    -- false = редакция отменена (без удаления — для истории)

    created_at       timestamptz not null default now()
);

create index on event_date_editions (event_id);
create index on event_date_editions (priority desc);
create index on event_date_editions (source_entity_id);
create index on event_date_editions (date_ref_event_id);

-- ─── Триггер 1: вычислить date_computed редакции при вставке / изменении ──────
create or replace function trg_edition_compute_date()
returns trigger language plpgsql as $$
declare
  base_date date;
begin
  if new.date_mode = 'absolute' then
    new.date_computed := coalesce(new.date_end, new.date_start);
  else
    -- Берём date_computed базового события из events
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
  return new;
end;
$$;

create trigger edition_compute_date
  before insert or update of
    date_mode, date_start, date_end,
    date_ref_event_id, date_ref_from, date_ref_offset, date_ref_offset_type
  on event_date_editions
  for each row execute function trg_edition_compute_date();

-- ─── Триггер 2: обновить events.date_computed при изменении редакций ──────────
-- После вставки/изменения/деактивации редакции — пересчитываем дату события
-- как date_computed редакции с наибольшим приоритетом среди активных.

create or replace function trg_edition_update_event()
returns trigger language plpgsql as $$
declare
  winning_date date;
  target_event_id uuid;
begin
  target_event_id := coalesce(new.event_id, old.event_id);

  select date_computed
    into winning_date
    from event_date_editions
   where event_id = target_event_id
     and is_active = true
   order by priority desc, created_at desc
   limit 1;

  update events
     set date_computed = winning_date
   where id = target_event_id;

  return coalesce(new, old);
end;
$$;

create trigger edition_update_event
  after insert or update or delete
  on event_date_editions
  for each row execute function trg_edition_update_event();

-- ─── Представление: активные редакции с победителем ─────────────────────────
create or replace view event_editions_resolved as
select
  e.id                                          as event_id,
  e.event_type,
  e.title,
  e.date_computed                               as effective_date,
  ed_win.priority                               as effective_priority,
  ed_win.source                                 as effective_source,
  ed_win.date_mode                              as effective_date_mode,
  ed_win.duration_note                          as effective_duration_note,
  count(ed_all.id) filter (where ed_all.is_active) as edition_count
from events e
left join lateral (
  select *
    from event_date_editions
   where event_id = e.id and is_active = true
   order by priority desc, created_at desc
   limit 1
) ed_win on true
left join event_date_editions ed_all on ed_all.event_id = e.id
group by e.id, e.event_type, e.title, e.date_computed,
         ed_win.priority, ed_win.source, ed_win.date_mode, ed_win.duration_note;

-- ─── RLS ──────────────────────────────────────────────────────────────────────
alter table event_date_editions enable row level security;

create policy "anon select" on event_date_editions for select using (true);
create policy "service all"  on event_date_editions for all  using (true) with check (true);
