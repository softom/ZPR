-- ============================================================================
-- Замена partial-unique-index на calendar_entries.mspdi_uid на полный.
-- ============================================================================
-- Причина: supabase-js / PostgreSQL `ON CONFLICT (column)` не принимает
-- partial-индекс как конфликт-таргет — нужен полный unique либо именованный
-- constraint. NULL-значения остаются разрешёнными (в Postgres NULL не
-- конфликтует с NULL по умолчанию), так что задачи без mspdi_uid (созданные
-- в Web UI) по-прежнему могут существовать в любом количестве.
-- ============================================================================

drop index if exists calendar_entries_mspdi_uid_uidx;

create unique index calendar_entries_mspdi_uid_uidx
    on calendar_entries (mspdi_uid);

notify pgrst, 'reload schema';
