-- ============================================================
-- meetings + meeting_participants
-- ============================================================
-- Собрание становится сущностью БД. Участники — связь контактов с собранием
-- через таблицу meeting_participants. Транскрипция хранится в STORAGE_DIR
-- (transcription_path — относительный путь от STORAGE_DIR).
--
-- Старый workflow (Skill /protocol-tasks из CLI с Участники.md в файле собрания)
-- остаётся совместимым через поле folder_path и опциональный экспорт Участники.md.

create table meetings (
    id              uuid primary key default gen_random_uuid(),
    code            text unique,                            -- ПРОТ-{дата}-{код}; опционально
    meeting_date    date not null,
    title           text not null,
    project         text,
    contractor_code text,                                    -- ХГ / МЛА / Б82 / 8D / null
    folder_path     text,                                    -- BASE_DIR-relative (для совместимости со Skill)
    transcription_path text,                                  -- STORAGE_DIR-relative

    status          text not null default 'planned'
                    check (status in (
                      'planned',
                      'transcript_uploaded',
                      'processed',
                      'approved',
                      'protocoled'
                    )),

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table  meetings is 'Рабочие собрания с подрядчиками — сущность процедуры обработки протокола';
comment on column meetings.contractor_code is 'Код подрядчика (ХГ/МЛА/Б82/8D) — для группировки и нумерации';
comment on column meetings.folder_path is 'Относительный путь от BASE_DIR к папке собрания в Obsidian-volt''e (опционально, для совместимости с CLI Skill)';
comment on column meetings.transcription_path is 'Относительный путь от STORAGE_DIR к файлу транскрипции (например Протоколы/{id}/transcript.docx)';
comment on column meetings.status is 'planned → transcript_uploaded → processed → approved → protocoled';

create index meetings_date_idx        on meetings (meeting_date desc);
create index meetings_status_idx      on meetings (status);
create index meetings_contractor_idx  on meetings (contractor_code);

-- updated_at триггер
create or replace function meetings_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger meetings_updated_at
    before update on meetings
    for each row
    execute function meetings_set_updated_at();

-- ─── meeting_participants ─────────────────────────────────────────────────────

create table meeting_participants (
    meeting_id      uuid not null references meetings(id) on delete cascade,
    contact_id      uuid not null references contacts(id) on delete restrict,
    role_at_meeting text,                            -- может отличаться от contacts.job_title
    seq             int,                             -- порядок в таблице (1.1, 2.1, …)
    org_seq         int,                             -- номер организации в нумерации (1, 2, 3)

    primary key (meeting_id, contact_id)
);

comment on table  meeting_participants is 'Связь contact → meeting: кто присутствовал на собрании, в какой роли';
comment on column meeting_participants.role_at_meeting is 'Роль на конкретном собрании. Если NULL — берём contacts.job_title';

create index meeting_participants_meeting_idx on meeting_participants (meeting_id);
create index meeting_participants_contact_idx on meeting_participants (contact_id);

notify pgrst, 'reload schema';
