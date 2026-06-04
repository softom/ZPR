-- ============================================================
-- meeting_topics: cleanup legacy-поля object_codes
-- ============================================================
-- Аналогично cleanup'у `tasks.object_codes` в 20260526000001 — text-дубликат
-- UUID-связи с объектами. Источник истины — meeting_topics.object_ids uuid[].
--
-- Аудит до миграции (на 26.05.2026, после применения 20260526000001):
--   total: 89, has object_codes: 88, has object_ids: 89, gap_object_ids: 0.
--
-- Применяем правило «мигрировать → ассерт → DROP» (см. WIKI 09 раздел
-- «Правило удаления legacy-полей»):
--   1. Audit pre-migration (RAISE NOTICE)
--   2. Backfill (no-op для текущих данных, но логика на случай dirty-state)
--   3. Final assert
--   4. DROP COLUMN
-- ============================================================

begin;

-- =====================================================================
-- Этап 1 — Аудит до миграции
-- =====================================================================

do $$
declare
    v_total          int;
    v_has_codes      int;
    v_has_ids        int;
    v_gap_object_ids int;
begin
    select count(*) into v_total from meeting_topics;
    select count(*) filter (where array_length(object_codes,1) > 0) into v_has_codes from meeting_topics;
    select count(*) filter (where array_length(object_ids,1) > 0)   into v_has_ids   from meeting_topics;
    select count(*) filter (where array_length(object_codes,1) > 0
                              and coalesce(array_length(object_ids,1),0) = 0)
      into v_gap_object_ids from meeting_topics;

    raise notice '── AUDIT meeting_topics (before backfill) ──';
    raise notice 'total: %', v_total;
    raise notice 'has object_codes: %', v_has_codes;
    raise notice 'has object_ids: %', v_has_ids;
    raise notice 'gap_object_ids (codes set but ids empty): %', v_gap_object_ids;
end $$;

-- =====================================================================
-- Этап 2 — Backfill (страховка): object_codes → object_ids через aliases
-- =====================================================================
-- Идемпотентно: меняем только строки где object_ids пуст а object_codes есть.
-- На текущих данных эффект 0 (gap=0), но защищаемся от dirty-state.
update meeting_topics t
   set object_ids = coalesce(subq.ids, '{}'::uuid[])
  from (
      select t2.id as topic_id,
             array_agg(o.id) filter (where o.id is not null) as ids
        from meeting_topics t2
        cross join lateral unnest(t2.object_codes) as oc
        left join objects o on o.code = oc or o.aliases ? oc
       where array_length(t2.object_codes,1) > 0
         and coalesce(array_length(t2.object_ids,1),0) = 0
       group by t2.id
  ) subq
 where t.id = subq.topic_id
   and subq.ids is not null
   and array_length(subq.ids,1) > 0;

-- =====================================================================
-- Этап 3 — Final assert
-- =====================================================================

do $$
declare
    v_gap int;
begin
    select count(*) filter (where array_length(object_codes,1) > 0
                              and coalesce(array_length(object_ids,1),0) = 0)
      into v_gap from meeting_topics;
    if v_gap > 0 then
        raise exception 'meeting_topics gap_object_ids: % строк — миграция откатывается', v_gap;
    end if;

    raise notice '── AUDIT meeting_topics (after backfill) ──';
    raise notice 'gap_object_ids: % (must be 0)', v_gap;
end $$;

-- =====================================================================
-- Этап 4 — DROP COLUMN
-- =====================================================================

alter table meeting_topics drop column if exists object_codes;

notify pgrst, 'reload schema';

commit;
