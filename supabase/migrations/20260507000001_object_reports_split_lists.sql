-- Разделение полей 2 и 3 на «описание» и «список основных пунктов» —
-- структура отчёта 2.1/2.2 и 3.1/3.2.
--
-- Существующие поля сохраняем со смыслом «описание»:
--   • achievements        → 2.1 Достижения за период (общее описание)
--   • next_period_tasks   → 3.1 Задачи наступающего периода (общее описание)
-- Новые поля под списки:
--   • achievements_list      → 2.2 Достижения: основные пункты
--   • next_period_tasks_list → 3.2 Задачи: основные пункты

alter table object_reports
    add column if not exists achievements_list      text,
    add column if not exists next_period_tasks_list text;

comment on column object_reports.project_movement     is 'Раздел 1: существующее движение проекта (абзац)';
comment on column object_reports.achievements          is 'Раздел 2.1: достижения за период (общее описание, абзац)';
comment on column object_reports.achievements_list     is 'Раздел 2.2: достижения за период (Markdown-список основных пунктов)';
comment on column object_reports.next_period_tasks     is 'Раздел 3.1: задачи наступающего периода (общее описание, абзац)';
comment on column object_reports.next_period_tasks_list is 'Раздел 3.2: задачи наступающего периода (Markdown-список основных пунктов)';
comment on column object_reports.risks                 is 'Раздел 4: риски (абзац)';

notify pgrst, 'reload schema';
