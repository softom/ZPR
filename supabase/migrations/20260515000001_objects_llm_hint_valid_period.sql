-- ============================================================
-- Срок действия llm_hint — чтобы устаревший hint не «прилипал» к LLM
-- ============================================================
-- Контекст: владелец объекта пишет llm_hint вида «объект на паузе по устному
-- решению заказчика». Через 2 месяца ситуация меняется — объект разморозился,
-- появились задачи, события. Но hint остаётся в БД и LLM продолжает писать
-- «на паузе».
--
-- Решение: hint получает опциональный срок действия:
--   llm_hint_valid_from  — с какой даты hint применять (по умолчанию NULL = всегда)
--   llm_hint_valid_until — до какой даты применять включительно (NULL = бессрочно)
--
-- В builders отчёта проверяем reference-date (период отчёта):
--   week/month → period_end
--   control    → period_start (snapshot)
-- Если reference-date вне [valid_from, valid_until] — hint в LLM-промпт НЕ
-- передаётся. На сам текст hint в БД это не влияет — только на его применимость.
-- ============================================================

alter table objects
    add column if not exists llm_hint_valid_from  date,
    add column if not exists llm_hint_valid_until date;

comment on column objects.llm_hint_valid_from is
    'Опциональная дата начала применимости llm_hint. NULL = применять всегда.';
comment on column objects.llm_hint_valid_until is
    'Опциональная дата конца применимости llm_hint (включительно). NULL = бессрочно.';

-- Sanity check: если оба заданы — until >= from
alter table objects drop constraint if exists objects_llm_hint_valid_period_check;
alter table objects add constraint objects_llm_hint_valid_period_check
    check (llm_hint_valid_until is null or llm_hint_valid_from is null
           or llm_hint_valid_until >= llm_hint_valid_from);

notify pgrst, 'reload schema';
