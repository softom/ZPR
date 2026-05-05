-- ============================================================
-- Удаление денормализованных events.entity_id / entity_type
-- ============================================================
-- См. [[20_Правило_связей]]: связи только через entity_links (UUID),
-- не дублировать. До этой миграции events имели полиморфную FK
-- entity_type ('document' | 'letter' | 'milestone' | 'meeting') + entity_id.
-- Теперь источник истины — таблица entity_links с link_type:
--   'from_document'  ← документ-родитель события
--   'from_letter'    ← письмо
--   'from_meeting'   ← собрание
--
-- Pre-check (выполнен вручную перед миграцией):
-- select count(distinct e.id) as events,
--        count(distinct el.from_id) as events_with_link
-- from events e
-- left join entity_links el
--   on el.from_type='event'
--  and el.from_id=e.id::text
--  and el.link_type in ('from_document','from_letter','from_meeting');
-- → должно быть равно (все 46 событий имеют link)

-- ─── Подстраховка: создаём недостающие entity_links на основе entity_id/type ──
-- (если pre-check выявил пропуски — здесь они закроются)
insert into entity_links (from_type, from_id, to_type, to_id, link_type)
select 'event', e.id::text, e.entity_type, e.entity_id::text,
       case e.entity_type
         when 'document' then 'from_document'
         when 'letter'   then 'from_letter'
         when 'meeting'  then 'from_meeting'
         else 'belongs_to'
       end
from events e
where e.entity_id is not null
  and e.entity_type is not null
  and not exists (
    select 1 from entity_links el
    where el.from_type='event'
      and el.from_id=e.id::text
      and el.to_type=e.entity_type
      and el.to_id=e.entity_id::text
  )
on conflict do nothing;

-- ─── Drop колонок ───────────────────────────────────────────────
alter table events drop column entity_type;
alter table events drop column entity_id;

-- Проверка ограничения отсутствия ссылок
-- (если на колонку есть FK от другой таблицы — миграция упадёт; в этой схеме их нет)

notify pgrst, 'reload schema';
