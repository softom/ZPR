-- ============================================================
-- ZPR — Документ-основание для объектов, геометрии, нагрузок и растров
-- ============================================================
-- Каждый объект, каждая правка геометрии, каждая нагрузка и каждый
-- растр должен ссылаться на документ-основание (FK → documents.id).
-- У документов есть версионность через documents.supersedes_id —
-- цепочка «v1 → v2 → v3» (NULL у первой версии).
-- ============================================================

-- ============================================================
-- 1. Версионность documents
-- ============================================================
alter table documents add column if not exists supersedes_id uuid references documents(id) on delete set null;

create index if not exists documents_supersedes_idx on documents (supersedes_id) where supersedes_id is not null;

comment on column documents.supersedes_id is
  'Документ-предшественник (предыдущая версия). NULL = первая версия. Цепочка через supersedes_id формирует историю версий одного документа.';

-- View «актуальные версии» — документы, которых не отменяет никто другой.
-- Используется в UI для выбора документа-основания.
drop view if exists v_documents_current cascade;
create view v_documents_current as
select d.*
from documents d
where not exists (
  select 1 from documents d2
  where d2.supersedes_id = d.id
);

comment on view v_documents_current is
  'Документы, не отменённые более новой версией. Используется в UI для выбора документа-основания.';

-- ============================================================
-- 2. FK source_document_id на сущности
-- ============================================================

-- objects — документ-основание создания объекта (приказ, постановление, договор)
alter table objects
  add column if not exists source_document_id uuid references documents(id) on delete set null;
create index if not exists objects_source_doc_idx on objects (source_document_id);
comment on column objects.source_document_id is
  'Документ-основание создания объекта (приказ, постановление, ИРД).';

-- object_geometries — документ-основание текущей версии геометрии
alter table object_geometries
  add column if not exists source_document_id uuid references documents(id) on delete set null;
create index if not exists object_geometries_source_doc_idx on object_geometries (source_document_id);
comment on column object_geometries.source_document_id is
  'Документ-основание этой версии геометрии (межевой план, проект, ТУ, кадастровый план).';

-- object_geometry_revisions — документ-основание правки
alter table object_geometry_revisions
  add column if not exists source_document_id uuid references documents(id) on delete set null;
create index if not exists object_geometry_revisions_source_doc_idx on object_geometry_revisions (source_document_id);
comment on column object_geometry_revisions.source_document_id is
  'Документ-основание правки геометрии (новая редакция межевого плана, ДС).';

-- utility_loads — документ-основание нагрузки (ТУ, расчётный отчёт)
alter table utility_loads
  add column if not exists source_document_id uuid references documents(id) on delete set null;
create index if not exists utility_loads_source_doc_idx on utility_loads (source_document_id);
comment on column utility_loads.source_document_id is
  'Документ-основание нагрузки (ТУ, расчётный отчёт). Дублирует free-text utility_loads.source_doc для типизации.';

-- raster_layers — документ-основание растра (отчёт об изысканиях с DEM)
alter table raster_layers
  add column if not exists source_document_id uuid references documents(id) on delete set null;
create index if not exists raster_layers_source_doc_idx on raster_layers (source_document_id);
comment on column raster_layers.source_document_id is
  'Документ-основание растра (отчёт об инженерных изысканиях, аэрофотосъёмка).';

-- mesh_assets — документ-основание (отчёт о лазерном сканировании, BIM)
alter table mesh_assets
  add column if not exists source_document_id uuid references documents(id) on delete set null;
create index if not exists mesh_assets_source_doc_idx on mesh_assets (source_document_id);
comment on column mesh_assets.source_document_id is
  'Документ-основание Mesh-данных (отчёт о лазерном сканировании, BIM-модель).';

-- ============================================================
-- 3. Триггер аудита — переносить source_document_id в revisions
-- ============================================================
-- Заменяем функцию: теперь она копирует source_document_id из object_geometries
-- в object_geometry_revisions, чтобы история сохраняла документ-основание правки.
create or replace function fn_object_geometries_audit() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    insert into object_geometry_revisions
      (geometry_id, object_id, kind, name, geom, properties,
       operation, changed_by, source_document_id)
    values (new.id, new.object_id, new.kind, new.name, new.geom, new.properties,
            'insert', session_user, new.source_document_id);
    return new;
  elsif tg_op = 'UPDATE' then
    if old.geom is distinct from new.geom
       or old.properties is distinct from new.properties
       or old.kind <> new.kind
       or old.name is distinct from new.name
       or old.source_document_id is distinct from new.source_document_id then
      insert into object_geometry_revisions
        (geometry_id, object_id, kind, name, geom, properties,
         operation, changed_by, source_document_id)
      values (old.id, old.object_id, old.kind, old.name, old.geom, old.properties,
              'update', session_user, new.source_document_id);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into object_geometry_revisions
      (geometry_id, object_id, kind, name, geom, properties,
       operation, changed_by, source_document_id)
    values (old.id, old.object_id, old.kind, old.name, old.geom, old.properties,
            'delete', session_user, old.source_document_id);
    return old;
  end if;
  return null;
end$$;

-- Триггер пересоздавать не надо — он ссылается на функцию по имени.

-- ============================================================
-- 4. Доступ ArcGIS — на новые поля
-- ============================================================
grant select on v_documents_current to arcgis_writer, anon, authenticated;
