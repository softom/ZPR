-- ====================================================================
-- documents.doc_number — номер договора как бизнес-ключ дедупликации
-- ====================================================================

alter table documents
  add column if not exists doc_number text;

comment on column documents.doc_number
  is 'Номер договора из текста (например «2604-01», «200326-203-1-ДУ»). NULL если не определён. Уникален среди активных документов.';

-- Уникальный индекс: только по активным (not deleted) и непустым номерам
create unique index if not exists documents_doc_number_unique
  on documents (doc_number)
  where doc_number is not null
    and doc_number <> ''
    and deleted_at is null;

-- Backfill: проставить номера двум существующим договорам
update documents set doc_number = '200326-203-1-ДУ'
  where id = '0d38aed8-fb88-47ce-a3d9-5bd9012b0a2e' and doc_number is null;

update documents set doc_number = '2604-01'
  where id = '5316c232-4387-4ac9-9c23-b2bcd0866474' and doc_number is null;

notify pgrst, 'reload schema';
