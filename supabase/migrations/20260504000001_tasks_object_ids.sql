-- ============================================================
-- tasks.object_ids — связь с объектами по UUID
-- ============================================================
-- См. [[09_Правило_связей]]: связи между сущностями — через UUID,
-- имена тянутся JOIN'ом из таблицы-источника.
-- Старое поле tasks.object_codes остаётся как DEPRECATED для
-- обратной совместимости и удалится отдельной миграцией позже.

alter table tasks add column object_ids uuid[] not null default '{}';
create index tasks_object_ids_idx on tasks using gin (object_ids);

comment on column tasks.object_ids is 'Массив UUID объектов из objects.id. Источник истины для связи task→object';
comment on column tasks.object_codes is 'DEPRECATED — используй object_ids. Сохранено для обратной совместимости';

-- Backfill: разрешаем object_codes через objects.code или objects.aliases
update tasks t
set object_ids = (
  select coalesce(array_agg(o.id) filter (where o.id is not null), '{}'::uuid[])
  from unnest(t.object_codes) as oc
  left join objects o
    on o.code = oc or o.aliases ? oc
);

-- Обновляем entity_links: from_id остаётся (UUID задачи), to_id заменяем на UUID объекта
update entity_links el
set to_id = o.id::text
from objects o
where el.from_type = 'task'
  and el.to_type = 'object'
  and (o.code = el.to_id or o.aliases ? el.to_id);

-- Перепишем view tasks_by_object на object_ids
drop view if exists tasks_by_object;
create view tasks_by_object as
select
    unnest(t.object_ids) as object_id,
    t.id, t.code, t.title, t.status, t.priority, t.assignee_org,
    t.due_date, t.done_date, t.source_meeting_date
from tasks t;

comment on view tasks_by_object is 'Один объект → одна строка задачи (раскрытие массива object_ids)';
