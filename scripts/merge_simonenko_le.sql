-- ============================================================
-- Merge duplicate legal_entity: «ИП Симоненко (Бюро 82)» → правильную запись
-- ============================================================
-- Дубль появился при парсинге договоров (LLM создал плейсхолдер с ИНН-заглушкой).
-- Объединяем в одну запись с настоящим ИНН.
--
-- WRONG (удалить): 663799ad-c9f5-4170-bcb0-88c3d6bf5b81  INN 910000000000
-- OK    (оставить): 013f9894-74cd-4708-881e-4beb646aa51c  INN 910200110001
--
-- Аудит ссылок до запуска (см. counts ниже) показал 0 конфликтов на
-- contacts_unique_per_org_idx, meeting_legal_entities(meeting_id, legal_entity_id),
-- entity_links(from_type, from_id, to_type, to_id, link_type).

begin;

-- 1. Слить aliases: union обоих + добавить старое имя дубля как алиас
update legal_entities ok
   set aliases = (
         select coalesce(jsonb_agg(distinct elem), '[]'::jsonb)
           from (
             select jsonb_array_elements_text(ok.aliases)                                              as elem
             union
             select jsonb_array_elements_text((select aliases from legal_entities where id='663799ad-c9f5-4170-bcb0-88c3d6bf5b81'::uuid))
             union
             select (select name from legal_entities where id='663799ad-c9f5-4170-bcb0-88c3d6bf5b81'::uuid)
           ) all_aliases
       )::jsonb
 where ok.id = '013f9894-74cd-4708-881e-4beb646aa51c'::uuid;

-- 2. Перевесить FK на правильную запись
update contacts               set legal_entity_id         = '013f9894-74cd-4708-881e-4beb646aa51c' where legal_entity_id         = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update documents              set customer_entity_id      = '013f9894-74cd-4708-881e-4beb646aa51c' where customer_entity_id      = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update documents              set contractor_entity_id    = '013f9894-74cd-4708-881e-4beb646aa51c' where contractor_entity_id    = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update event_object_status    set fact_by_entity_id       = '013f9894-74cd-4708-881e-4beb646aa51c' where fact_by_entity_id       = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update meeting_legal_entities set legal_entity_id         = '013f9894-74cd-4708-881e-4beb646aa51c' where legal_entity_id         = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update meeting_topics         set raised_by_entity_id     = '013f9894-74cd-4708-881e-4beb646aa51c' where raised_by_entity_id     = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update meeting_topics         set corrected_by_entity_id  = '013f9894-74cd-4708-881e-4beb646aa51c' where corrected_by_entity_id  = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update task_object_status     set done_by_entity_id       = '013f9894-74cd-4708-881e-4beb646aa51c' where done_by_entity_id       = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update tasks                  set assignee_entity_id      = '013f9894-74cd-4708-881e-4beb646aa51c' where assignee_entity_id      = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update tasks                  set corrected_by_entity_id  = '013f9894-74cd-4708-881e-4beb646aa51c' where corrected_by_entity_id  = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';

-- 3. Полиморфные entity_links
update entity_links set from_id = '013f9894-74cd-4708-881e-4beb646aa51c'
 where from_type = 'legal_entity' and from_id = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';
update entity_links set to_id   = '013f9894-74cd-4708-881e-4beb646aa51c'
 where to_type   = 'legal_entity' and to_id   = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';

-- 4. Финальная проверка: на дубль не должно остаться ссылок
do $$
declare v_remaining int;
begin
  select
    (select count(*) from contacts               where legal_entity_id         = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from documents              where customer_entity_id      = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from documents              where contractor_entity_id    = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from event_object_status    where fact_by_entity_id       = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from meeting_legal_entities where legal_entity_id         = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from meeting_topics         where raised_by_entity_id     = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from meeting_topics         where corrected_by_entity_id  = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from task_object_status     where done_by_entity_id       = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from tasks                  where assignee_entity_id      = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from tasks                  where corrected_by_entity_id  = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from entity_links           where from_type='legal_entity' and from_id='663799ad-c9f5-4170-bcb0-88c3d6bf5b81') +
    (select count(*) from entity_links           where to_type='legal_entity'   and to_id  ='663799ad-c9f5-4170-bcb0-88c3d6bf5b81')
  into v_remaining;
  if v_remaining > 0 then
    raise exception 'Остались ссылки на дубль: %', v_remaining;
  end if;
end$$;

-- 5. Удалить дубль
delete from legal_entities where id = '663799ad-c9f5-4170-bcb0-88c3d6bf5b81';

-- 6. Показать итог
select id, name, inn, aliases, signatory_name from legal_entities where id = '013f9894-74cd-4708-881e-4beb646aa51c';

commit;
