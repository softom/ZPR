-- ============================================================================
-- MS Project XML (MSPDI) — двусторонняя интеграция с calendar_entries
-- ============================================================================
-- Контекст: WIKI 11_График_и_отклонения + 15_Календарь_объекта.
--
-- Расширяем calendar_entries полями для стабильной идентификации задач
-- между БД и MS Project (Task UID), иерархии (OutlineLevel/OutlineNumber,
-- parent_entry_id), прогресса (PercentComplete) и режима планирования.
-- Создаём:
--   schedule_imports        — история загрузок XML (для аудита и стат)
--   schedule_object_mapping — справочник: raw_text из MS Project → object_id
-- ============================================================================

-- ─── 1. Расширение calendar_entries полями MSPDI ──────────────────────────
alter table calendar_entries
    add column mspdi_uid        int,
    add column mspdi_id         int,
    add column outline_level    smallint,
    add column outline_number   text,
    add column parent_entry_id  uuid references calendar_entries(id) on delete set null,
    add column is_summary       boolean not null default false,
    add column percent_complete smallint check (percent_complete is null or (percent_complete between 0 and 100)),
    add column task_mode        text not null default 'auto' check (task_mode in ('auto','manual')),
    add column is_project_wide  boolean not null default false,
    add column mspdi_notes      text,
    add column last_import_id   uuid;

-- mspdi_uid уникален среди ненулевых (партиал-индекс): задачи, созданные вручную
-- в Web UI, имеют mspdi_uid IS NULL и не конкурируют за уникальность.
create unique index calendar_entries_mspdi_uid_uidx
    on calendar_entries (mspdi_uid)
    where mspdi_uid is not null;

create index calendar_entries_parent_idx        on calendar_entries (parent_entry_id);
create index calendar_entries_outline_level_idx on calendar_entries (outline_level);
create index calendar_entries_last_import_idx   on calendar_entries (last_import_id);

-- Контракт is_project_wide ↔ object_ids: либо общая для проекта (объектов 0),
-- либо привязана к одному+ объектам.
alter table calendar_entries
    add constraint calendar_entries_project_wide_check
    check (
        (is_project_wide = true  and (object_ids = '{}'::uuid[] or array_length(object_ids,1) is null))
     or (is_project_wide = false)
    );

comment on column calendar_entries.mspdi_uid        is 'Task/UID из MS Project XML (MSPDI). Стабильный идентификатор между сохранениями файла. NULL для задач, созданных в Web UI.';
comment on column calendar_entries.mspdi_id         is 'Task/ID из MSPDI (порядковый номер в плане, может меняться при перетасовке).';
comment on column calendar_entries.outline_level    is 'Уровень иерархии задачи (1 = верхний). Для отображения wbs/гантта.';
comment on column calendar_entries.outline_number   is 'OutlineNumber из MSPDI: текст вида "1.2.3".';
comment on column calendar_entries.parent_entry_id  is 'Родительская задача (Summary). ON DELETE SET NULL — потомки не удаляются автоматически.';
comment on column calendar_entries.is_summary       is 'true = суммарная задача (имеет потомков); даты вычисляются из детей в MS Project.';
comment on column calendar_entries.percent_complete is '% выполнения 0..100 (Task/PercentComplete).';
comment on column calendar_entries.task_mode        is 'auto = планируется автоматически, manual = ручное планирование (Task/Manual в MSPDI).';
comment on column calendar_entries.is_project_wide  is 'true = задача относится ко всему проекту ЗПР, без привязки к конкретному объекту. object_ids при этом пуст.';
comment on column calendar_entries.mspdi_notes      is 'Сырые Notes из Task/Notes (для аудита и резерв-источника привязки к объекту).';
comment on column calendar_entries.last_import_id   is 'FK → schedule_imports(id) — последний импорт, который коснулся этой строки.';

-- ─── 2. История импортов MSPDI ────────────────────────────────────────────
create table schedule_imports (
    id                  uuid primary key default gen_random_uuid(),
    file_name           text not null,
    file_size           bigint,
    project_name        text,
    project_start_date  date,
    project_finish_date date,
    object_field        text not null default 'Notes',
    mspdi_uid_max       int,
    tasks_total         int not null default 0,
    tasks_inserted      int not null default 0,
    tasks_updated       int not null default 0,
    tasks_unmapped      int not null default 0,
    predecessors_total  int not null default 0,
    notes               text,
    imported_by_email   text,
    imported_at         timestamptz not null default now()
);

create index schedule_imports_imported_at_idx on schedule_imports (imported_at desc);

comment on table  schedule_imports                is 'История импортов MS Project XML (MSPDI). Каждая загрузка — отдельная запись с метаданными и статистикой.';
comment on column schedule_imports.object_field   is 'Имя поля в Task, откуда читается привязка к объекту: Notes, Text1..Text30. По умолчанию Notes.';
comment on column schedule_imports.mspdi_uid_max  is 'Максимальный Task UID при импорте — для генерации новых UID при экспорте.';
comment on column schedule_imports.tasks_unmapped is 'Сколько задач не нашли соответствия в schedule_object_mapping (попадают в очередь ручного маппинга).';

-- Теперь, когда таблица создана, привязываем FK
alter table calendar_entries
    add constraint calendar_entries_last_import_fk
    foreign key (last_import_id) references schedule_imports(id) on delete set null;

-- ─── 3. Справочник маппинга raw_text → object_id ──────────────────────────
create table schedule_object_mapping (
    id              uuid primary key default gen_random_uuid(),
    raw_text        text not null,
    object_id       uuid references objects(id) on delete cascade,
    is_project_wide boolean not null default false,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint schedule_object_mapping_target_check
        check ((object_id is not null and is_project_wide = false)
            or (object_id is null     and is_project_wide = true))
);

-- raw_text уникален (case-insensitive)
create unique index schedule_object_mapping_raw_text_uidx
    on schedule_object_mapping (lower(raw_text));

create index schedule_object_mapping_object_idx on schedule_object_mapping (object_id);

comment on table  schedule_object_mapping                 is 'Справочник: текст-привязка задачи в MS Project → object_id (или is_project_wide=true для общепроектных задач). Раскрывается при импорте XML.';
comment on column schedule_object_mapping.raw_text        is 'Исходный текст из поля привязки задачи в MS Project (case-insensitive ключ).';
comment on column schedule_object_mapping.object_id       is 'FK → objects(id). NULL при is_project_wide=true.';
comment on column schedule_object_mapping.is_project_wide is 'true = эта строка означает «задача общая для всего проекта ЗПР».';

-- updated_at триггер (переиспользуем cos_set_updated_at из 20260508000001)
create trigger schedule_object_mapping_updated_at
before update on schedule_object_mapping
for each row execute function cos_set_updated_at();

-- ─── 4. RLS ───────────────────────────────────────────────────────────────
alter table schedule_imports        enable row level security;
alter table schedule_object_mapping enable row level security;

create policy "anon select"     on schedule_imports        for select using (true);
create policy "service all"     on schedule_imports        using (true) with check (true);
create policy "anon select"     on schedule_object_mapping for select using (true);
create policy "service all"     on schedule_object_mapping using (true) with check (true);

-- ─── 5. PostgREST schema reload ───────────────────────────────────────────
notify pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (вручную):
-- ----------------------------------------------------------------------------
-- drop trigger if exists schedule_object_mapping_updated_at on schedule_object_mapping;
-- drop table  if exists schedule_object_mapping;
-- alter table calendar_entries drop constraint if exists calendar_entries_last_import_fk;
-- drop table  if exists schedule_imports;
-- alter table calendar_entries
--     drop constraint if exists calendar_entries_project_wide_check,
--     drop column if exists last_import_id,
--     drop column if exists mspdi_notes,
--     drop column if exists is_project_wide,
--     drop column if exists task_mode,
--     drop column if exists percent_complete,
--     drop column if exists is_summary,
--     drop column if exists parent_entry_id,
--     drop column if exists outline_number,
--     drop column if exists outline_level,
--     drop column if exists mspdi_id,
--     drop column if exists mspdi_uid;
-- ============================================================================
