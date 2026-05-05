-- ============================================================
-- meeting_attachments — файлы к протоколу
-- ============================================================
-- Видеозаписи встреч и материалы, представленные на собрании.
-- Материалы (kind='material') в дальнейшем индексируются в pgvector
-- для семантического поиска (TODO — пока заглушка).

create table meeting_attachments (
    id           uuid primary key default gen_random_uuid(),
    meeting_id   uuid not null references meetings(id) on delete cascade,
    kind         text not null check (kind in ('video', 'material', 'other')),
    file_path    text not null,                          -- STORAGE_DIR-relative (POSIX)
    filename     text not null,                          -- оригинальное имя файла
    size_bytes   bigint not null default 0,
    content_type text,
    indexed_at   timestamptz,                            -- когда отправлено в pgvector (для material)
    note         text,
    created_at   timestamptz not null default now()
);

comment on table  meeting_attachments is 'Файлы-вложения к собранию: видеозаписи, материалы, прочие документы';
comment on column meeting_attachments.kind is 'video — видеозапись встречи, material — представленные материалы (индексируются в pgvector), other — прочее';
comment on column meeting_attachments.indexed_at is 'Время отправки в pgvector. NULL = не индексировано';

create index meeting_attachments_meeting_idx on meeting_attachments (meeting_id);
create index meeting_attachments_kind_idx on meeting_attachments (kind);

notify pgrst, 'reload schema';
