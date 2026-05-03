-- ====================================================================
-- documents.signed_date + contract_clauses.is_anchor
-- ====================================================================
-- 1. documents.signed_date — дата заключения договора (из текста, через LLM).
--    Раньше использовалась только для имени папки, в БД не хранилась.
--    Нужна для:
--      - явного отображения в карточке договора;
--      - формирования «якорного» пункта (см. ниже);
--      - расчёта дат событий с term_base='contract' (модуль C).
--
-- 2. contract_clauses.is_anchor — флаг «якорного» пункта «Дата заключения договора».
--    Один на договор. Создаётся автоматически при /save и /clauses/replace,
--    если у документа есть signed_date. Через UI оператор может править,
--    но не должен явно ломать (UI блокирует удаление/перемещение якоря).
--    Назначение:
--      - визуальный ориентир в таблице пунктов («с этой даты считаются сроки»);
--      - база для модуля C: anchor → СОБЫТИЕ «Договор подписан» → база для term_base='contract'.

alter table documents
  add column if not exists signed_date date;

comment on column documents.signed_date
  is 'Дата заключения договора (из текста договора через LLM). Используется для якорного пункта и расчёта term_base=contract.';

create index if not exists documents_signed_date_idx
  on documents (signed_date) where signed_date is not null;

alter table contract_clauses
  add column if not exists is_anchor boolean not null default false;

comment on column contract_clauses.is_anchor
  is 'true = «якорный» пункт «Дата заключения договора» (один на договор, ставится автоматически при анализе)';

-- Один якорь на договор (partial unique index)
create unique index if not exists contract_clauses_one_anchor_per_doc
  on contract_clauses (document_id) where is_anchor = true;

notify pgrst, 'reload schema';
