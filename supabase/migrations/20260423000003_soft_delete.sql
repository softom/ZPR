-- Деактивация документов (soft delete)
alter table documents add column if not exists deleted_at timestamptz;
comment on column documents.deleted_at is 'NULL = активный, timestamptz = деактивирован';

-- Быстрый фильтр по активным
create index if not exists documents_active_idx on documents (created_at desc) where deleted_at is null;
