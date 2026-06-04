-- Migration: add start_date to tasks
-- 2026-06-02
-- Дата начала задачи (отдельно от due_date — срок выполнения).
-- При создании задачи из события — default = дата события.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date date;

COMMENT ON COLUMN tasks.start_date IS 'Дата начала работы над задачей (опционально). При создании из события — дата события.';
