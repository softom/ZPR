-- ============================================================
-- object_reports.object_id — переход на UUID FK
-- ============================================================
-- См. [[09_Правило_связей]]: связи между сущностями — через UUID.
-- Удаляем object_code (text), вводим object_id (uuid FK на objects.id).

alter table object_reports add column object_id uuid references objects(id);

-- Backfill (если бы было что — пока пусто; учитываем aliases на всякий случай)
update object_reports r
set object_id = o.id
from objects o
where o.code = r.object_code or o.aliases ? r.object_code;

-- Сначала удаляем view (зависит от object_code)
drop view if exists object_reports_latest;
drop index if exists object_reports_object_idx;

alter table object_reports alter column object_id set not null;
alter table object_reports drop column object_code;

create index object_reports_object_idx on object_reports (object_id, generated_at desc);

create or replace view object_reports_latest as
select distinct on (object_id) *
from object_reports
order by object_id, generated_at desc;

comment on column object_reports.object_id is 'UUID объекта из objects.id. Имя тянется JOIN-ом';
comment on view object_reports_latest is 'По одной самой свежей записи на object_id';
