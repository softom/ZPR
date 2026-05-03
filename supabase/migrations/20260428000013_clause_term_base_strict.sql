-- ====================================================================
-- contract_clauses.term_base — строгий список из 2 значений
-- ====================================================================
-- Решение пользователя (2026-04-28): не разрешать в term_base ни одну
-- из деривативных категорий, кроме 'contract' (всегда известная база)
-- и 'clause' (явная ссылка на конкретный пункт через term_ref_clause_id).
--
-- Удаляются: 'advance', 'start', 'end', 'prev', 'submission', 'review',
-- 'act', 'custom' — все они дают ошибку при пересчёте дат либо
-- ломаются при reorder ('prev').
--
-- Существующие данные с deprecated значениями переводятся в term_base=NULL,
-- старая категория сохраняется в term_text как пометка [legacy term_base=...].

update contract_clauses
   set term_text = coalesce(nullif(trim(term_text), ''), '') ||
                   case when coalesce(trim(term_text), '') = '' then '' else ' ' end ||
                   '[legacy term_base=' || term_base || ']',
       term_base = null
 where term_base in ('advance','start','end','prev','submission','review','act','custom');

alter table contract_clauses drop constraint contract_clauses_term_base_check;
alter table contract_clauses add constraint contract_clauses_term_base_check
  check (term_base in ('contract','clause'));

notify pgrst, 'reload schema';
