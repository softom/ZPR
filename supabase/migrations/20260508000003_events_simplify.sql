-- ============================================================================
-- Фаза 3 разделения СОБЫТИЕ ↔ КАЛЕНДАРЬ ОБЪЕКТА
-- ============================================================================
-- events упрощается до журнала фактов:
--   - drop date_mode, date_ref_*, duration_note, exec_*, is_manual
--   - drop is_planned, fact_date (фактовое событие = всегда факт; date = date_end)
--   - drop object_codes (DEPRECATED уже)
--   - drop триггеры plan-каскада (теперь живут в calendar_*)
--   - drop event_predecessors, event_date_editions (фактам не нужны)
--   - drop clause_events (0 строк, замещено entity_links link_type='from_document')
--   - сужение check_event_type до фактовых
-- ============================================================================

-- Сначала чистим зависимые VIEW (они смотрят на устаревшие колонки/таблицы)
drop view if exists event_shift_history       cascade;
drop view if exists event_editions_resolved   cascade;
drop view if exists event_predecessors_view   cascade;
drop view if exists events_by_object          cascade;
drop view if exists object_timeline           cascade;

-- Триггеры и функции plan-каскада
drop trigger if exists events_compute_date          on events;
drop trigger if exists events_fact_date_propagate   on events;
drop trigger if exists event_object_status_recompute on event_object_status;

drop function if exists trg_events_compute_date()        cascade;
drop function if exists trg_events_fact_date_changed()   cascade;
drop function if exists trg_eos_recompute()              cascade;
drop function if exists recompute_event_fact(uuid)       cascade;
drop function if exists propagate_event_date(uuid, int)  cascade;
drop function if exists compute_predecessor_constraint(uuid) cascade;

-- Сателлиты, привязанные к плану
drop table if exists event_predecessors  cascade;
drop table if exists event_date_editions cascade;
drop table if exists clause_events       cascade;

-- FK из events на самоё себя — был для date_ref_event_id
alter table events drop constraint if exists events_date_ref_event_id_fkey;

-- ─── Удаляем плановые/чейновые колонки из events ──────────────────────────
alter table events
    drop column if exists date_mode,
    drop column if exists date_ref_event_id,
    drop column if exists date_ref_from,
    drop column if exists date_ref_offset,
    drop column if exists date_ref_offset_type,
    drop column if exists duration_note,
    drop column if exists exec_days,
    drop column if exists exec_type,
    drop column if exists is_manual,
    drop column if exists is_planned,
    drop column if exists fact_date,
    drop column if exists object_codes,
    drop column if exists stage_number;

-- date_computed остаётся, но теперь — просто = coalesce(date_end, date_start),
-- поддерживается простым триггером (без relative-логики).
create or replace function trg_events_simple_compute_date()
returns trigger language plpgsql as $$
begin
    new.date_computed := coalesce(new.date_end, new.date_start);
    return new;
end;
$$;

create trigger events_compute_date
before insert or update of date_start, date_end
on events
for each row
execute function trg_events_simple_compute_date();

-- Backfill: пересчитать date_computed для всех событий (на всякий случай)
update events set date_computed = coalesce(date_end, date_start)
 where date_computed is distinct from coalesce(date_end, date_start);

-- ─── Junction event_object_status — упрощается ────────────────────────────
-- is_planned для фактового события всегда false (событие = случилось).
-- Удаляем колонку is_planned, но сохраняем fact_date (per-object факт).
-- Старая check «eos_fact_consistency» больше не нужна.
alter table event_object_status drop constraint if exists eos_fact_consistency;
alter table event_object_status drop column if exists is_planned;

-- Заодно: для project_note/meeting/protocol_correction is_planned был false,
-- fact_date был date_end. Если в junction осталось is_planned=true (что
-- не должно быть, т.к. фактовые событиями) — fact_date = NULL. Backfill:
update event_object_status eos
   set fact_date = e.date_end,
       updated_at = now()
  from events e
 where e.id = eos.event_id
   and eos.fact_date is null;

-- ─── Сужаем event_type check ──────────────────────────────────────────────
alter table events drop constraint if exists events_event_type_check;
alter table events add constraint events_event_type_check
    check (event_type in ('project_note','meeting','protocol_correction'));

-- ─── Пересоздаём VIEW events_by_object под новую схему ───────────────────
create or replace view events_by_object as
  select eos.object_id,
         eos.fact_date     as object_fact_date,
         eos.fact_note     as object_fact_note,
         eos.fact_by_entity_id as object_fact_by_entity_id,
         e.id,
         e.event_type,
         e.title,
         e.date_start,
         e.date_end,
         e.date_computed,
         e.event_time,
         e.stage_name,
         e.note
    from events e
    join event_object_status eos on eos.event_id = e.id;

comment on view events_by_object is
    'Per-object развёртка событий-фактов. Для плана см. calendar_entries + calendar_object_status.';

-- ─── object_timeline VIEW: единый таймлайн (events ∪ calendar) ────────────
create or replace view object_timeline as
  -- Фактовые события
  select
      'event'::text       as source_kind,
      e.id                as source_id,
      eos.object_id       as object_id,
      e.date_computed     as date,
      e.event_time        as time,
      e.event_type        as kind,
      e.title             as title,
      e.note              as description,
      e.stage_name        as stage_name,
      'fact'::text        as planned_or_fact
    from events e
    join event_object_status eos on eos.event_id = e.id
  union all
  -- Календарные вехи
  select
      'calendar_entry'::text as source_kind,
      c.id                   as source_id,
      cos.object_id          as object_id,
      coalesce(cos.fact_date, c.date_computed) as date,
      null::time             as time,
      c.entry_type           as kind,
      c.title                as title,
      c.duration_note        as description,
      c.stage_name           as stage_name,
      case when cos.is_planned then 'plan' else 'fact' end as planned_or_fact
    from calendar_entries c
    join calendar_object_status cos on cos.calendar_id = c.id;

comment on view object_timeline is
    'Единый таймлайн объекта: журнал событий + календарь вех. Сортировать по date desc, time desc nulls last.';

notify pgrst, 'reload schema';
