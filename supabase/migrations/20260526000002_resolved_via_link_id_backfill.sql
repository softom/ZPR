-- ============================================================
-- v2.4 follow-up — backfill task_object_status.resolved_via_link_id
-- ============================================================
-- В миграции 20260526000001 этап 4 (best-effort resolved_via_link_id) использовал
-- паттерн WITH inserted_links AS (INSERT...RETURNING) UPDATE ... JOIN entity_links.
-- Из-за классической PG-семантики (data-modifying CTE и основной UPDATE видят
-- разные снапшоты) — UPDATE не увидел только что вставленные строки entity_links,
-- и 161 матч не проставился.
--
-- Сейчас entity_links resolved_by уже в БД, поэтому простой UPDATE-statement
-- спокойно их находит и проставляет resolved_via_link_id.
-- ============================================================

begin;

update task_object_status tos
   set resolved_via_link_id = el.id
  from meetings m
  join entity_links el on el.from_type='task'
                      and el.to_type='meeting'
                      and el.to_id = m.id::text
                      and el.link_type='resolved_by'
 where tos.status in ('done','closed')
   and tos.resolved_via_link_id is null
   and tos.done_date is not null
   and m.meeting_date = tos.done_date
   and tos.object_id = any(m.object_ids)
   and el.from_id = tos.task_id::text;

-- Лог результата
do $$
declare
    v_count int;
begin
    select count(*) into v_count
      from task_object_status
     where resolved_via_link_id is not null;
    raise notice 'task_object_status with resolved_via_link_id after backfill: %', v_count;
end $$;

notify pgrst, 'reload schema';

commit;
