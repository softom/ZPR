-- ============================================================
-- Ранжирование задач для попадания в отчёт (резюме по объекту).
-- ============================================================
-- Алгоритм формирования отчёта разделён на 2 шага:
--   Шаг 1. Ранжирование задач — отдельный проход (LLM или вручную).
--          Результат записывается в `tasks.report_relevance`.
--   Шаг 2. Сборка отчёта — LLM получает уже отрангированный список,
--          не «думает» каждый раз заново.
--
-- Параллельно: пред-отчёт на /tasks использует это поле для сортировки —
-- наиболее важные задачи всплывают вверх, пользователь правит/закрывает их,
-- эффективно воздействуя на финальный отчёт.
--
-- Уровни (по образцу events.importance + дополнительный 'skip'):
--   critical — обязательно упомянуть в отчёте (горящая, блокирующая)
--   high     — важно упомянуть
--   normal   — можно упомянуть (default)
--   low      — упоминать только если место позволяет
--   skip     — НЕ упоминать (явно исключена из отчёта)
-- NULL = не оценена.
-- ============================================================

alter table tasks
    add column if not exists report_relevance text;

alter table tasks drop constraint if exists tasks_report_relevance_check;
alter table tasks add constraint tasks_report_relevance_check
    check (report_relevance is null
           or report_relevance in ('critical','high','normal','low','skip'));

comment on column tasks.report_relevance is
    'Релевантность задачи для попадания в отчёт. critical/high/normal/low/skip. NULL=не оценена. См. WIKI 19 → «Ранжирование для отчёта».';

-- Partial-индекс для быстрых отчётов «top-relevant»
create index if not exists tasks_report_relevance_high_idx
    on tasks (report_relevance, due_date)
    where report_relevance in ('critical','high');

notify pgrst, 'reload schema';
