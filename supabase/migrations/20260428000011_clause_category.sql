-- ====================================================================
-- contract_clauses.category — классификатор пункта
-- ====================================================================
-- 4 категории, согласованные с категориями событий проекта (см. 14_Модель_событий):
--   fin   — финансовый    (авансы, окончательный расчёт, штрафы)
--   work  — производственный (этапы работ, начало/окончание выполнения)
--   appr  — согласование  (сдача документации, проверка, акты)
--   legal — юридический   (подписание договора/ДС, расторжение)
--
-- Заполняется LLM при анализе договора. Может быть NULL (не определена).
-- Якорный пункт «Дата заключения договора» — всегда 'legal'.

alter table contract_clauses
  add column if not exists category text
       check (category in ('fin','work','appr','legal'));

comment on column contract_clauses.category
  is 'Классификатор пункта: fin (финансовый) | work (производственный) | appr (согласование) | legal (юридический). NULL если не определён.';

-- Якорь — всегда 'legal'
update contract_clauses set category = 'legal' where is_anchor = true and category is null;

create index if not exists contract_clauses_category_idx
  on contract_clauses (category) where category is not null;

notify pgrst, 'reload schema';
