-- ============================================================================
-- Версионность импортов MS Project (MSPDI)
-- ============================================================================
-- Контекст: WIKI 11_График_и_отклонения раздел «Версионность».
--
-- Каждый импорт XML = отдельная версия плана. Версии сосуществуют в БД,
-- calendar_entries размечены по version_id. Активная версия (is_active=true)
-- отображается в /calendar. Переключение — мгновенное (смена флага).
--
-- Открытый вопрос: calendar_object_status (per-object факты) — не версионированы.
-- Зафиксирован в WIKI 11_График_и_отклонения раздел «TODO».
-- ============================================================================

-- ─── 1. schedule_imports: поля версии ─────────────────────────────────────

alter table schedule_imports
    add column version_name text,
    add column xml_content  text,
    add column is_active    boolean not null default false;

create index schedule_imports_is_active_idx
    on schedule_imports (is_active)
    where is_active = true;

comment on column schedule_imports.version_name is 'Имя версии, заданное пользователем при импорте (например «v014 — апрель»)';
comment on column schedule_imports.xml_content  is 'Сырой XML файла MS Project (MSPDI) — для повторного экспорта и сравнения версий';
comment on column schedule_imports.is_active    is 'true = активная версия (одна на весь план). Активная версия отображается в /calendar и используется для экспорта по умолчанию';

-- ─── 2. calendar_entries: привязка к версии ──────────────────────────────

alter table calendar_entries
    add column schedule_version_id uuid references schedule_imports(id) on delete cascade;

create index calendar_entries_version_id_idx
    on calendar_entries (schedule_version_id);

comment on column calendar_entries.schedule_version_id is
    'FK → schedule_imports(id). Версия импорта, которой принадлежит запись. '
    'NULL = запись создана вручную или из договора (не версионируется, всегда видима).';

-- ─── 3. Уникальный индекс mspdi_uid — теперь per-version ─────────────────
-- Было: UNIQUE(mspdi_uid) WHERE mspdi_uid IS NOT NULL (глобальный, одна строка на uid)
-- Стало: UNIQUE(mspdi_uid, schedule_version_id) WHERE оба NOT NULL
-- Старые строки (schedule_version_id IS NULL) — вне этого ограничения.

drop index if exists calendar_entries_mspdi_uid_uidx;

create unique index calendar_entries_mspdi_uid_version_uidx
    on calendar_entries (mspdi_uid, schedule_version_id)
    where mspdi_uid is not null and schedule_version_id is not null;
