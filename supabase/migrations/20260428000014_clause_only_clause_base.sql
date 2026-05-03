-- ====================================================================
-- contract_clauses.term_base — единственное допустимое значение: 'clause'
-- ====================================================================
-- Решение пользователя (2026-04-28):
-- Так как «Дата заключения договора» теперь — обязательный якорный ПУНКТ
-- в каждом договоре, отдельная категория term_base='contract' избыточна.
-- Все ссылки идут через term_ref_clause_id на конкретный пункт (включая якорь).
--
-- Изменения:
--   1. Существующие term_base='contract' переводятся в term_base='clause'
--      + term_ref_clause_id указывает на якорный пункт того же документа.
--   2. CHECK сужается до одного значения: term_base in ('clause').
--      (NULL по-прежнему допустим — пункт без формулы.)
--   3. Если term_base='clause' — term_ref_clause_id обязателен.

-- 1. Перевод contract → clause+anchor
update contract_clauses cc
   set term_base = 'clause',
       term_ref_clause_id = (
         select anchor.id
           from contract_clauses anchor
          where anchor.document_id = cc.document_id
            and anchor.is_anchor = true
          limit 1
       )
 where cc.term_base = 'contract'
   and cc.term_ref_clause_id is null;

-- На всякий случай — у пунктов с term_base='contract' где anchor не нашёлся
-- (теоретически возможно если signed_date был null) — обнулим term_base.
update contract_clauses
   set term_base = null
 where term_base = 'contract'
   and term_ref_clause_id is null;

-- 2. Сжать check до 'clause'
alter table contract_clauses drop constraint contract_clauses_term_base_check;
alter table contract_clauses add constraint contract_clauses_term_base_check
  check (term_base in ('clause'));

-- 3. term_ref_clause_id обязателен при term_base='clause'
alter table contract_clauses
  add constraint contract_clauses_term_ref_required
  check (term_base is null or term_ref_clause_id is not null);

notify pgrst, 'reload schema';
