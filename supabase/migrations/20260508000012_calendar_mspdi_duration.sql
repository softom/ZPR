-- ============================================================================
-- Сохранение длительности задач MS Project (Duration) + календарных настроек.
-- ============================================================================
-- Без этих полей Project при открытии экспортированного XML ставит «?»
-- у всех сроков: он не знает <Duration> задачи и <MinutesPerDay> проекта,
-- поэтому не может пересчитать рабочие дни.
-- ============================================================================

alter table calendar_entries
    add column mspdi_duration text;

comment on column calendar_entries.mspdi_duration is
    'Длительность задачи в формате MSPDI ISO 8601 (например «PT240H0M0S» = 240 часов). Сохраняется при импорте и пишется обратно при экспорте — без неё Project помечает сроки «?» в Manual mode.';

alter table schedule_imports
    add column project_calendar_settings jsonb;

comment on column schedule_imports.project_calendar_settings is
    'Календарные настройки шапки проекта из исходного XML: minutes_per_day, minutes_per_week, days_per_month, default_start_time, default_finish_time, calendar_uid. Восстанавливаются в шапке экспорта.';

notify pgrst, 'reload schema';
