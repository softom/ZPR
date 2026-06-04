-- ============================================================================
-- Фаза 2 разделения СОБЫТИЕ ↔ КАЛЕНДАРЬ ОБЪЕКТА
-- ============================================================================
-- Перенос данных:
--   events (event_type IN календарных)  →  calendar_entries
--   event_object_status                  →  calendar_object_status
--   event_date_editions                  →  calendar_date_editions
--   event_predecessors                   →  calendar_predecessors (0 строк, на всякий)
--   entity_links { from_type|to_type='event' }  →  'calendar_entry' для мигрированных ID
--
-- UUID сохраняются! Никаких new gen_random_uuid().
-- 13 календарных event_type:
--   fin_advance, fin_interim, fin_final, fin_loan,
--   work_start, work_end, work_stage,
--   appr_sign, appr_submission, appr_review,
--   exec_work, contract_signed, contract_loaded
-- ============================================================================

-- Триггеры временно отключаем — иначе при INSERT в calendar_entries сработает
-- trg_calendar_compute_date с relative и FK на ещё не вставленный родитель.
-- Аналогично — junction propagate.
alter table calendar_entries        disable trigger calendar_compute_date;
alter table calendar_object_status  disable trigger calendar_object_status_propagate;
alter table calendar_object_status  disable trigger calendar_object_status_updated_at;

-- ─── 1. calendar_entries ──────────────────────────────────────────────────
insert into calendar_entries (
    id, entry_type, title, object_ids,
    date_mode, date_start, date_end,
    date_ref_entry_id, date_ref_from, date_ref_offset, date_ref_offset_type,
    date_computed, duration_note,
    exec_days, exec_type, is_manual,
    stage_name, stage_number, created_at
)
select
    id, event_type, title, object_ids,
    date_mode, date_start, date_end,
    date_ref_event_id, date_ref_from, date_ref_offset, date_ref_offset_type,
    date_computed, duration_note,
    exec_days, exec_type, is_manual,
    stage_name, stage_number, created_at
  from events
 where event_type in ('fin_advance','fin_interim','fin_final','fin_loan',
                      'work_start','work_end','work_stage',
                      'appr_sign','appr_submission','appr_review',
                      'exec_work','contract_signed','contract_loaded');

-- ─── 2. calendar_object_status ────────────────────────────────────────────
insert into calendar_object_status (
    calendar_id, object_id, is_planned, fact_date,
    fact_note, fact_by_entity_id, created_at, updated_at
)
select
    eos.event_id, eos.object_id, eos.is_planned, eos.fact_date,
    eos.fact_note, eos.fact_by_entity_id, eos.created_at, eos.updated_at
  from event_object_status eos
  join events e on e.id = eos.event_id
 where e.event_type in ('fin_advance','fin_interim','fin_final','fin_loan',
                        'work_start','work_end','work_stage',
                        'appr_sign','appr_submission','appr_review',
                        'exec_work','contract_signed','contract_loaded');

-- ─── 3. calendar_date_editions ────────────────────────────────────────────
insert into calendar_date_editions (
    id, calendar_id, priority, source, source_entity_type, source_entity_id,
    date_mode, date_start, date_end,
    date_ref_entry_id, date_ref_from, date_ref_offset, date_ref_offset_type,
    date_computed, duration_note, is_active, created_at, reason,
    exec_days, exec_type, is_manual
)
select
    ede.id, ede.event_id, ede.priority, ede.source, ede.source_entity_type, ede.source_entity_id,
    ede.date_mode, ede.date_start, ede.date_end,
    ede.date_ref_event_id, ede.date_ref_from, ede.date_ref_offset, ede.date_ref_offset_type,
    ede.date_computed, ede.duration_note, ede.is_active, ede.created_at, ede.reason,
    ede.exec_days, ede.exec_type, ede.is_manual
  from event_date_editions ede
  join events e on e.id = ede.event_id
 where e.event_type in ('fin_advance','fin_interim','fin_final','fin_loan',
                        'work_start','work_end','work_stage',
                        'appr_sign','appr_submission','appr_review',
                        'exec_work','contract_signed','contract_loaded');

-- ─── 4. calendar_predecessors (0 строк ожидается) ─────────────────────────
insert into calendar_predecessors (
    id, calendar_id, predecessor_id, link_type, lag, lag_type, notes, created_at
)
select
    ep.id, ep.event_id, ep.predecessor_id, ep.link_type, ep.lag, ep.lag_type, ep.notes, ep.created_at
  from event_predecessors ep
  join events e on e.id = ep.event_id
 where e.event_type in ('fin_advance','fin_interim','fin_final','fin_loan',
                        'work_start','work_end','work_stage',
                        'appr_sign','appr_submission','appr_review',
                        'exec_work','contract_signed','contract_loaded');

-- ─── 5. entity_links: переключаем to_type/from_type для мигрированных ─────
update entity_links
   set to_type = 'calendar_entry'
 where to_type = 'event'
   and to_id::uuid in (select id from calendar_entries);

update entity_links
   set from_type = 'calendar_entry'
 where from_type = 'event'
   and from_id::uuid in (select id from calendar_entries);

-- ─── 6. Удаляем перенесённое из events (CASCADE снесёт сателлиты) ─────────
-- event_object_status и event_date_editions имеют ON DELETE CASCADE на events.id.
-- event_predecessors тоже CASCADE. clause_events тоже CASCADE.
-- Дубликаты строк не возникнут, т.к. мы выше уже скопировали в calendar_*.
delete from events
 where event_type in ('fin_advance','fin_interim','fin_final','fin_loan',
                      'work_start','work_end','work_stage',
                      'appr_sign','appr_submission','appr_review',
                      'exec_work','contract_signed','contract_loaded');

-- Триггеры включаем обратно
alter table calendar_entries        enable trigger calendar_compute_date;
alter table calendar_object_status  enable trigger calendar_object_status_propagate;
alter table calendar_object_status  enable trigger calendar_object_status_updated_at;

-- ─── 7. Проверки integrity ────────────────────────────────────────────────
do $$
declare
    n_calendar      int;
    n_events_left   int;
    n_orphan_refs   int;
    n_links_event   int;
    n_links_cal     int;
begin
    select count(*) into n_calendar from calendar_entries;
    select count(*) into n_events_left from events;
    select count(*) into n_orphan_refs from calendar_entries
     where date_ref_entry_id is not null
       and date_ref_entry_id not in (select id from calendar_entries);
    select count(*) into n_links_event from entity_links where to_type='event' or from_type='event';
    select count(*) into n_links_cal   from entity_links where to_type='calendar_entry' or from_type='calendar_entry';

    raise notice 'calendar_entries: %', n_calendar;
    raise notice 'events осталось: %', n_events_left;
    raise notice 'orphan date_ref в calendar: %', n_orphan_refs;
    raise notice 'entity_links.event*: %', n_links_event;
    raise notice 'entity_links.calendar*: %', n_links_cal;

    if n_orphan_refs > 0 then
        raise exception 'НАЙДЕНЫ orphan-ссылки date_ref_entry_id (%) — миграция отменена', n_orphan_refs;
    end if;
end $$;

notify pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK невозможен на уровне SQL после удаления из events.
-- Сделать backup перед запуском:
--   pg_dump --table=events --table=event_object_status --table=event_date_editions
--           --table=event_predecessors --table=entity_links --data-only > backup.sql
-- ============================================================================
