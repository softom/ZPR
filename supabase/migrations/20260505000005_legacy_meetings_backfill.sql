-- Backfill: создаём пустые meetings-записи для legacy-задач
-- (импортированных из MD-архива, у которых meeting_id IS NULL).
--
-- Цель: каждая задача знает к какому собранию относится. Пользователь
-- сможет загрузить файлы оригинальных протоколов через Секцию 5
-- (meeting_attachments) — meetings уже в статусе approved.
--
-- См. план wiki-twinkling-moore.md → "Per-object статусы → Открытые follow-up"
-- и сообщение пользователя 05.05.2026.

-- 1) Создаём meetings для каждого уникального (source_protocol, source_meeting_date)
insert into meetings (
    code, meeting_date, title, contractor_code,
    status, object_ids,
    created_at, updated_at
)
select
    src.source_protocol            as code,
    src.source_meeting_date        as meeting_date,
    'Собрание ' || src.source_protocol as title,
    -- Извлекаем код подрядчика: ПРОТ-YYYY-MM-DD-{code} → 5-й сегмент через split_part
    split_part(src.source_protocol, '-', 5) as contractor_code,
    'approved'                      as status,
    src.union_object_ids            as object_ids,
    now()                           as created_at,
    now()                           as updated_at
from (
    select source_protocol,
           source_meeting_date,
           array(
               select distinct unnest(object_ids)
               from tasks t2
               where t2.source_protocol = t1.source_protocol
                 and t2.meeting_id is null
           ) as union_object_ids
    from tasks t1
    where t1.source_protocol is not null
      and t1.meeting_id is null
    group by source_protocol, source_meeting_date
) src
on conflict (code) do nothing;

-- 2) Привязываем задачи к созданным meetings
update tasks t
   set meeting_id = m.id
  from meetings m
 where t.meeting_id is null
   and t.source_protocol is not null
   and m.code = t.source_protocol;

-- 3) Создаём события «Собрание проведено» для каждого backfill-собрания
--    (если ещё не создано — entity_links уникальны по from_type/from_id/to_type/to_id/link_type).
do $$
declare
    m record;
    new_event_id uuid;
begin
    for m in
        select id, code, title, meeting_date, object_ids
          from meetings
         where status = 'approved'
           and array_length(object_ids, 1) > 0
           and not exists (
               select 1 from entity_links
                where to_type = 'meeting'
                  and to_id = meetings.id::text
                  and link_type = 'from_meeting'
           )
    loop
        insert into events (
            event_type, title, date_mode, date_end, date_computed,
            is_planned, fact_date, object_ids
        )
        values (
            'meeting',
            'Собрание: ' || m.title,
            'absolute',
            m.meeting_date,
            m.meeting_date,
            false,
            m.meeting_date,
            m.object_ids
        )
        returning id into new_event_id;

        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('event', new_event_id::text, 'meeting', m.id::text, 'from_meeting')
        on conflict do nothing;
    end loop;
end$$;

notify pgrst, 'reload schema';
