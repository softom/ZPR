-- ─── Вспомогательная функция: прибавить рабочие дни ─────────────────────────
-- Пропускает субботу (6) и воскресенье (0). Без учёта праздников.
create or replace function add_working_days(base_date date, n int)
returns date language plpgsql immutable as $$
declare
  d         date := base_date;
  remaining int  := abs(n);
  step      int  := case when n >= 0 then 1 else -1 end;
begin
  while remaining > 0 loop
    d := d + step;
    if extract(dow from d) not in (0, 6) then
      remaining := remaining - 1;
    end if;
  end loop;
  return d;
end;
$$;

-- ─── Основная таблица событий ─────────────────────────────────────────────────
create table if not exists events (
    id               uuid primary key default gen_random_uuid(),

    -- Тип и название
    event_type       text not null,
    -- Типы: contract_signed | contract_received | contract_loaded
    --        milestone_event | payment_advance | payment_final
    --        meeting | protocol_published
    --        schedule_milestone | schedule_actual

    title            text not null,

    -- ── Режим даты ────────────────────────────────────────────────────────────
    -- 'absolute' — date_start / date_end заданы явно
    -- 'relative' — дата вычисляется относительно другого события
    date_mode        text not null default 'absolute'
                     check (date_mode in ('absolute', 'relative')),

    -- ── Абсолютные даты (для date_mode = 'absolute') ─────────────────────────
    date_start       date,   -- начало (для диапазонных событий)
    date_end         date,   -- окончание / основная дата

    -- ── Относительная привязка (для date_mode = 'relative') ──────────────────
    date_ref_event_id    uuid references events(id) on delete set null,
    --   ↑ базовое событие цепочки

    date_ref_from        text default 'end'
                         check (date_ref_from in ('start', 'end')),
    --   от какого края базового события считать смещение

    date_ref_offset      int not null default 0,
    --   смещение в днях (положительное = после, отрицательное = до)

    date_ref_offset_type text not null default 'calendar'
                         check (date_ref_offset_type in ('calendar', 'working')),
    --   тип дней: 'calendar' — календарные, 'working' — рабочие (пн–пт)

    -- ── Кэш вычисленной даты ─────────────────────────────────────────────────
    -- Заполняется приложением. Для 'absolute' = date_end.
    -- Для 'relative' = add_working_days(base, offset) или base + offset.
    -- Используется для сортировки и отображения таймлайна.
    date_computed    date,

    -- Исходная формулировка срока из договора
    duration_note    text,
    -- Пример: «35 рабочих дней с даты начала выполнения работ»

    -- ── Статус ───────────────────────────────────────────────────────────────
    is_planned       boolean not null default true,
    --   true = план, false = факт (выполнено)

    fact_date        date,
    --   фактическая дата выполнения (заполняется при наступлении события)

    -- ── Привязка к объектам ───────────────────────────────────────────────────
    object_codes     jsonb not null default '[]',
    -- ["006_ГОСТИНИЦА_400"]

    -- ── Связь с источником ───────────────────────────────────────────────────
    entity_type      text,   -- 'document' | 'letter' | 'milestone' | 'meeting'
    entity_id        uuid,   -- FK к записи-источнику

    -- ── Контекст этапа ────────────────────────────────────────────────────────
    stage_name       text,
    stage_number     int,

    notes            text,
    created_at       timestamptz not null default now()
);

-- ─── Индексы ──────────────────────────────────────────────────────────────────
create index on events (event_type);
create index on events (date_computed);
create index on events (date_end);
create index on events (date_ref_event_id);
create index on events (entity_id);
create index on events using gin (object_codes);

-- ─── Функция: разрешить дату события по цепочке ──────────────────────────────
-- Обходит цепочку date_ref_event_id → ... → абсолютное событие.
-- Защита от циклов: максимум 20 шагов.
create or replace function resolve_event_date(p_event_id uuid)
returns date language plpgsql stable as $$
declare
  rec       events%rowtype;
  base_date date;
  steps     int := 0;
  cur_id    uuid := p_event_id;
begin
  loop
    steps := steps + 1;
    if steps > 20 then
      raise exception 'Цикл в цепочке событий (event_id=%)', p_event_id;
    end if;

    select * into rec from events where id = cur_id;
    if not found then return null; end if;

    if rec.date_mode = 'absolute' then
      -- Достигли основания цепочки
      return coalesce(rec.date_end, rec.date_start);
    end if;

    -- relative: идём к базовому событию
    if rec.date_ref_event_id is null then return null; end if;

    -- Получаем дату базового события
    select case when rec.date_ref_from = 'start'
                then coalesce(e.date_start, e.date_computed)
                else coalesce(e.date_end,   e.date_computed)
           end
      into base_date
      from events e
     where e.id = rec.date_ref_event_id;

    if base_date is null then return null; end if;

    -- Применяем смещение
    if rec.date_ref_offset_type = 'working' then
      return add_working_days(base_date, rec.date_ref_offset);
    else
      return base_date + rec.date_ref_offset;
    end if;
  end loop;
end;
$$;

-- ─── Триггер: обновлять date_computed при изменении даты или ссылки ──────────
-- Примечание: не вызываем resolve_event_date(new.id) — это BEFORE trigger,
-- строка ещё не вставлена. Вместо этого берём date_computed базового события
-- напрямую. Цепочка строится последовательно: база → потомки.
create or replace function trg_events_compute_date()
returns trigger language plpgsql as $$
declare
  base_date date;
begin
  if new.date_mode = 'absolute' then
    new.date_computed := coalesce(new.date_end, new.date_start);
  else
    select case
             when new.date_ref_from = 'start'
             then coalesce(e.date_start, e.date_computed)
             else coalesce(e.date_end, e.date_computed)
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

create trigger events_compute_date
  before insert or update of
    date_mode, date_start, date_end,
    date_ref_event_id, date_ref_from, date_ref_offset, date_ref_offset_type
  on events
  for each row execute function trg_events_compute_date();

-- ─── RLS (повторяет политику остальных таблиц) ───────────────────────────────
alter table events enable row level security;

create policy "anon select" on events for select using (true);
create policy "service all"  on events for all using (true)
  with check (true);
