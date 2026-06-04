-- ============================================================================
-- event_classifier_feedback: добавляем auto_object_codes для tracking object-правок
-- ============================================================================
-- При accept/reject в /events/preliminary оператор может править object_ids
-- (добавлять/убирать объекты). Чтобы LLM учился на этих правках:
--   auto_object_codes  — что предложил классификатор изначально
--   object_codes       — что оставил оператор (финал, был и раньше)
-- Diff (auto vs final) подмешивается в few-shot examples L2-промпта.
-- ============================================================================

alter table event_classifier_feedback
    add column auto_object_codes text[] not null default '{}';

-- Бэкфилл существующих записей: для них считаем что diff'а не было
update event_classifier_feedback
   set auto_object_codes = object_codes
 where auto_object_codes = '{}';

insert into _applied_migrations (filename) values
    ('20260514000001_feedback_object_diff.sql')
on conflict do nothing;
