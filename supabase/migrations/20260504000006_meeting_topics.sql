-- ============================================================
-- meeting_topics + tasks.meeting_id FK
-- ============================================================
-- Темы «Обсудили (без задач)» — пункты протокола, не приводящие к поручениям:
-- констатации, решения, обмен мнениями. Извлекаются LLM наряду с задачами.
-- Жизненный цикл: preliminary → approved → removed (нет 'done' — у тем нет
-- статуса исполнения).

create table meeting_topics (
    id              uuid primary key default gen_random_uuid(),
    meeting_id      uuid not null references meetings(id) on delete cascade,
    code            text unique not null,                  -- ПРОТ-{дата}-{код}-ОБС-NN
    seq             int not null,                          -- порядок в протоколе

    title           text not null,                          -- короткий заголовок темы
    content         text not null,                          -- 1-3 предложения

    raised_by_org   text,                                   -- кто поднял вопрос
    raised_by_entity_id uuid references legal_entities(id),

    object_codes    text[] not null default '{}',
    quotes          jsonb not null default '[]',

    status          text not null default 'preliminary'
                    check (status in ('preliminary','approved','removed')),

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table  meeting_topics is 'Темы «Обсудили» — пункты протокола без действия (констатации, решения, обмен мнениями)';
comment on column meeting_topics.code is 'Уникальный код: ПРОТ-{дата}-{подрядчик}-ОБС-{NN}';
comment on column meeting_topics.status is 'preliminary (LLM извлекла) → approved (после ревью) → removed (отмечена лишней)';

create index meeting_topics_meeting_idx  on meeting_topics (meeting_id, seq);
create index meeting_topics_status_idx   on meeting_topics (status);

create or replace function meeting_topics_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger meeting_topics_updated_at
    before update on meeting_topics
    for each row
    execute function meeting_topics_set_updated_at();

-- ─── FK tasks.meeting_id ──────────────────────────────────────────────────────
-- Связь существующих задач с собраниями БД. После миграции backfill можно сделать
-- по совпадению source_meeting_path = meetings.folder_path (отдельной командой).

alter table tasks add column if not exists meeting_id uuid references meetings(id) on delete set null;
create index if not exists tasks_meeting_idx on tasks (meeting_id);

comment on column tasks.meeting_id is 'FK на meetings — собрание-источник задачи (заменяет source_meeting_path для нового workflow)';

-- ─── tasks.status расширяется (добавляем preliminary, если ещё нет) ───────────
-- В миграции 20260424000002_tasks_preliminary.sql уже добавлено, но проверим.
-- (no-op если ограничение уже принимает 'preliminary')

notify pgrst, 'reload schema';
