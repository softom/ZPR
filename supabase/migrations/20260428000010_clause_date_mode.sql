-- ====================================================================
-- contract_clauses.date_mode — режим пункта (date / term)
-- ====================================================================
-- 'date' — оператор зафиксировал абсолютную дату как источник истины.
--          В UI clause_date редактируется (зелёная рамка). term_* — read-only справка.
-- 'term' — оператор работает с формулой срока. term_* редактируются (зелёные).
--          clause_date — расчётная (серая italic), не редактируется.
--  null  — пункт пустой; оба поля доступны.
--
-- Дефолт при INSERT (save / clauses/replace / clauses POST):
--   term_* заполнено      → 'term' (формула приоритетнее, она «строже»)
--   только clause_date    → 'date'
--   ничего не задано      → null
--
-- Якорный пункт is_anchor=true всегда хранится как 'date'.

alter table contract_clauses
  add column if not exists date_mode text
       check (date_mode in ('date','term'));

comment on column contract_clauses.date_mode
  is 'Режим определяющего поля: date = дата зафиксирована, term = срок-формула. NULL = пусто.';

-- Backfill для уже существующих строк по их содержимому
update contract_clauses set date_mode =
  case
    when term_days is not null and term_base is not null then 'term'
    when clause_date is not null then 'date'
    else null
  end
  where date_mode is null;

notify pgrst, 'reload schema';
