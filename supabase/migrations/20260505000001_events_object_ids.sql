-- ============================================================
-- events.object_ids — связь с объектами по UUID
-- ============================================================
-- См. [[09_Правило_связей]]: связи между сущностями — через UUID,
-- имена тянутся JOIN'ом из таблицы-источника.
-- Старое поле events.object_codes (jsonb) остаётся как DEPRECATED для
-- обратной совместимости и удалится отдельной миграцией позже.

alter table events add column object_ids uuid[] not null default '{}';
create index events_object_ids_idx on events using gin (object_ids);

comment on column events.object_ids is 'Массив UUID объектов из objects.id. Источник истины для связи event→object';
comment on column events.object_codes is 'DEPRECATED — используй object_ids. Сохранено для обратной совместимости (jsonb массив текстовых кодов)';

-- Backfill: разрешаем object_codes (jsonb-массив) через objects.code или objects.aliases
update events e
set object_ids = (
  select coalesce(array_agg(o.id) filter (where o.id is not null), '{}'::uuid[])
  from jsonb_array_elements_text(e.object_codes) as oc
  left join objects o
    on o.code = oc or o.aliases ? oc
)
where jsonb_typeof(object_codes) = 'array' and jsonb_array_length(object_codes) > 0;

-- entity_links event→object: уже хранят UUID после миграции 20260504000001 (где обновляли to_id для всех to_type='object').
-- Подстрахуемся: сделаем UPSERT исходя из текущего object_ids события.
insert into entity_links (from_type, from_id, to_type, to_id, link_type)
select 'event', e.id::text, 'object', oid::text, 'belongs_to'
from events e, unnest(e.object_ids) as oid
on conflict (from_type, from_id, to_type, to_id, link_type) do nothing;
