-- Разовая правка: для всех meeting-событий (event_type='meeting') добавить
-- entity_links к юр.лицам из meeting_legal_entities соответствующего собрания.
-- link_type='belongs_to' — стандартный тип принадлежности (событие
-- «принадлежит» этим организациям как участникам), используется т.к. в
-- check-constraint entity_links нет 'participated_in'.
--
-- Идемпотентно благодаря UNIQUE (from_type, from_id, to_type, to_id, link_type)
-- + ON CONFLICT DO NOTHING.

insert into entity_links (from_type, from_id, to_type, to_id, link_type)
select 'event', e.id::text, 'legal_entity', mle.legal_entity_id::text, 'belongs_to'
from events e
join entity_links el
  on el.from_type='event'
 and el.from_id = e.id::text
 and el.link_type = 'from_meeting'
join meetings m on m.id::text = el.to_id
join meeting_legal_entities mle on mle.meeting_id = m.id
where e.event_type = 'meeting'
on conflict do nothing;
