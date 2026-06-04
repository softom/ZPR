-- ============================================================
-- meeting_legal_entities.role: явная семантика участия юр.лица в собрании
-- ============================================================
-- Заменяет deprecated meetings.contractor_code (text). Связь meeting→подрядчик
-- теперь читается через junction по UUID, а короткое имя контрагента — через
-- JOIN на legal_entities (aliases / short_name).
--
-- См. WIKI 09_Правило_связей: связи только через UUID.

-- Backfill role на основе aliases (UUID-based heuristic — стартовая точка;
-- пользователь может поправить per-meeting в UI Секции 1).
update meeting_legal_entities mle
set role = sub.role
from (
  select id, case
    -- Подрядчики (по aliases)
    when aliases ?| array['ХГ','Хэдс Групп','HeadsGroup','Heads Group'] then 'contractor'
    when aliases ?| array['МЛА','МЛА+','MLA','MLA+'] then 'contractor'
    when aliases ?| array['Б82','Бюро 82','Бюро82'] then 'contractor'
    when aliases ?| array['8D']                       then 'contractor'
    when aliases ?| array['М-ЛИТ','СЗ М-ЛИТ']         then 'contractor'
    when aliases ?| array['Импульс','ИМПУЛЬС']        then 'contractor'
    when aliases ?| array['Современные Геотехнологии'] then 'contractor'
    -- Заказчик
    when aliases ?| array['ТЗ','ТЗ-ЮГ','ТЗ ЮГ','Заказчик-ЮГ','Заказчик ЮГ'] then 'customer'
    -- Операторы отелей
    when aliases ?| array['СК','Семейные курорты']    then 'operator'
    when aliases ?| array['ГостК','Арбат','Гостиничная компания'] then 'operator'
    -- Инвестор
    when aliases ?| array['Монолит','ООО Монолит']    then 'investor'
    else 'participant'
  end as role
  from legal_entities
) sub
where mle.legal_entity_id = sub.id
  and mle.role is null;

-- Дубликаты / без aliases → 'participant'
update meeting_legal_entities set role = 'participant' where role is null;

-- Проверочное ограничение + NOT NULL + DEFAULT
alter table meeting_legal_entities
  alter column role set not null,
  alter column role set default 'participant';

alter table meeting_legal_entities
  add constraint meeting_legal_entities_role_check
    check (role in ('contractor','customer','operator','investor','expert','participant'));

comment on column meeting_legal_entities.role is
  'Роль юр.лица в собрании: contractor (подрядчик), customer (заказчик), operator (оператор отеля), investor, expert, participant. Используется в process/route.ts для UUID-driven вывода короткого кода контрагента. Заменяет deprecated meetings.contractor_code.';

-- Индекс для быстрого поиска подрядчика собрания
create index if not exists meeting_legal_entities_role_idx
  on meeting_legal_entities (meeting_id, role)
  where role = 'contractor';

-- Помечаем legacy-поле deprecated (удалится отдельной миграцией позже)
comment on column meetings.contractor_code is
  'DEPRECATED (с 08.05.2026): связь meeting→подрядчик теперь живёт в meeting_legal_entities.role=contractor. Поле сохранено только для возможного roll-back. Удалится отдельной миграцией после стабилизации.';

notify pgrst, 'reload schema';
