-- ====================================================================
-- contract_clauses.term_ref_clause_id — ссылка на конкретный пункт договора
-- ====================================================================
-- Расширение модели формулы срока: помимо абстрактных term_base ('contract',
-- 'advance', 'prev', 'act' и т.п.) пункт может ссылаться на конкретный
-- ДРУГОЙ пункт того же договора.
--
-- Семантика:
--   term_base='clause' + term_ref_clause_id=<id>
--     → дата вычисляется как date_of(<id>) + term_days [рабочих/календарных].
--
-- ON DELETE SET NULL: если целевой пункт удаляется — ссылка обнуляется,
-- в UI появится подсказка «целевой пункт удалён».

-- Расширяем check term_base новым значением 'clause'
alter table contract_clauses drop constraint if exists contract_clauses_term_base_check;
alter table contract_clauses add constraint contract_clauses_term_base_check
  check (term_base in (
    'contract',
    'advance',
    'start',
    'end',
    'prev',
    'submission',
    'review',
    'act',
    'custom',
    'clause'  -- NEW
  ));

alter table contract_clauses
  add column if not exists term_ref_clause_id uuid
       references contract_clauses(id) on delete set null;

create index if not exists contract_clauses_term_ref_clause_idx
  on contract_clauses (term_ref_clause_id) where term_ref_clause_id is not null;

comment on column contract_clauses.term_ref_clause_id
  is 'FK на конкретный пункт того же договора (если term_base=clause). ON DELETE SET NULL.';

notify pgrst, 'reload schema';
