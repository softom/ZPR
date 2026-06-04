-- ============================================================
-- contract_stages_with_progress: добавляем source_page/source_quote
-- ============================================================
-- Цель: UI отличает «LLM-этап» (есть source_quote) от «ручной этап»
-- (source_quote IS NULL). Используется для визуальной маркировки
-- и для предупреждения при /extract-stages (чтобы не затирать ручные правки).
-- ============================================================

drop view if exists contract_stages_with_progress;
create view contract_stages_with_progress as
select
    cs.id,
    cs.document_id,
    cs.stage_number,
    cs.stage_name,
    cs.description,
    cs.sort_order,
    cs.is_default,
    cs.source_page,
    cs.source_quote,
    (select count(*) from contract_clauses cc where cc.stage_id = cs.id) as clauses_count,
    (select count(*) from contract_clauses cc where cc.stage_id = cs.id and cc.clause_date is not null) as clauses_with_date,
    (cs.id = (select current_stage_id from documents d where d.id = cs.document_id)) as is_current
from contract_stages cs;

notify pgrst, 'reload schema';
