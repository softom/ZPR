-- ============================================================
-- Weekly Report v3 — новая структура секции (2026-05-14)
-- ============================================================
-- На weekly_report_DRAFT.md v3 утверждена новая структура секции:
--   1. Заголовок (объект)
--   2. Договоры (из БД, не LLM): doc_number + signed_date + current_stage_name
--   3. Движение проекта за неделю (1 абзац) → используем существующее
--      object_reports.project_movement
--   4. Ключевые события и задачи (LLM формирует):
--      • ✓ Выполнено (события + закрытые задачи) → новое поле weekly_done_brief
--      • Обобщение тем собраний → новое поле weekly_topics_brief
--      • 🔜 Предстоит (задачи следующего периода) → новое поле weekly_upcoming_brief
--
-- Старые поля 6-секционной структуры (achievements / achievements_list /
-- next_period_tasks / next_period_tasks_list / risks) — DEPRECATED для week,
-- но оставлены для совместимости с уже созданными отчётами.
-- ============================================================

alter table object_reports
    add column if not exists weekly_done_brief     text,
    add column if not exists weekly_topics_brief   text,
    add column if not exists weekly_upcoming_brief text;

comment on column object_reports.weekly_done_brief is
    'Weekly v3: список событий и закрытых задач за период (Markdown-буллеты, маркер "•").';
comment on column object_reports.weekly_topics_brief is
    'Weekly v3: связный абзац (1-3 предложения), обобщающий ключевые темы собраний за период.';
comment on column object_reports.weekly_upcoming_brief is
    'Weekly v3: список активных и предстоящих задач (Markdown-буллеты с маркером "🔜").';

-- Старые поля помечаем DEPRECATED для weekly. month-отчёты пока пользуют их.
comment on column object_reports.achievements is
    'WEEK→DEPRECATED (используй weekly_done_brief). Для month — раздел "Достижения за период: описание".';
comment on column object_reports.achievements_list is
    'WEEK→DEPRECATED (включено в weekly_done_brief). Для month — "Достижения за период: основные пункты".';
comment on column object_reports.next_period_tasks is
    'WEEK→DEPRECATED (включено в weekly_upcoming_brief). Для month — "Задачи наступающего периода: описание".';
comment on column object_reports.next_period_tasks_list is
    'WEEK→DEPRECATED (используй weekly_upcoming_brief). Для month — "Задачи наступающего периода: основные пункты".';
comment on column object_reports.risks is
    'WEEK→DEPRECATED (в weekly v3 риски не отдельным блоком). Для month — раздел "Риски".';

notify pgrst, 'reload schema';
