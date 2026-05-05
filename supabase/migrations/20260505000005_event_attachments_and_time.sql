-- ============================================================
-- event_attachments + events.event_time
-- ============================================================
-- Зеркало meeting_attachments. Связь по UUID (см. WIKI 20_Правило_связей).
-- Файлы хранятся в STORAGE_DIR/СОБЫТИЯ/{YYYY}/{MM}/{event_id}/.

create table event_attachments (
    id          uuid primary key default gen_random_uuid(),
    event_id    uuid not null references events(id) on delete cascade,
    kind        text not null default 'document'
                check (kind in ('document','image','archive','video','audio','other')),
    file_name   text not null,                       -- оригинальное имя файла
    file_path   text not null,                       -- путь от STORAGE_DIR (UNIX-стиль /)
    file_size   bigint,                              -- байты
    mime_type   text,
    summary     text,                                -- LLM-выжимка
    summary_at  timestamptz,                         -- когда сделана выжимка
    indexed_at  timestamptz,                         -- placeholder для pgvector (на будущее)
    created_at  timestamptz not null default now(),
    created_by  uuid                                 -- (опц.) FK на auth.users — не enforce
);

create index event_attachments_event_idx on event_attachments (event_id);
create index event_attachments_kind_idx  on event_attachments (kind);

comment on table event_attachments is
    'Файлы, прикреплённые к событию. Хранилище: STORAGE_DIR/СОБЫТИЯ/{YYYY}/{MM}/{event_id}/';
comment on column event_attachments.summary is
    'LLM-выжимка из файла (Polza.AI). Заполняется по кнопке «✨ Реферировать».';
comment on column event_attachments.indexed_at is
    'Placeholder для pgvector-индексации. Реальный воркер — отдельной задачей.';

-- ─── events.event_time ─────────────────────────────────────────
alter table events add column event_time time;

comment on column events.event_time is
    'Время события (опц.) для упорядочивания внутри одного дня. NULL = весь день.';

-- Backfill из note для project_note событий с временем формата «HH:MM» в первой строке
update events
   set event_time = (substring(note from '\d{1,2}:\d{2}'))::time
 where event_type = 'project_note'
   and note ~ '\d{1,2}:\d{2}'
   and event_time is null;

notify pgrst, 'reload schema';
