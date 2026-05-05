-- Разовая правка: восстановить кириллический префикс «Собрание:» в title
-- meeting-событий, которые при backfill (через PowerShell stdin) получили
-- битый title из-за encoding.

do $$
declare m record;
begin
  for m in
    select e.id as event_id, mt.title as m_title
      from events e
      join entity_links el on el.from_type='event'
                          and el.from_id=e.id::text
                          and el.link_type='from_meeting'
      join meetings mt on mt.id::text=el.to_id
     where e.event_type='meeting'
  loop
    update events
       set title = 'Собрание: ' || m.m_title
     where id = m.event_id;
  end loop;
end$$;
