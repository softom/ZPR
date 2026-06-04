-- ============================================================================
-- Публикации протокола в Telegram-чаты, привязанные к объектам собрания.
-- ============================================================================
-- Кнопка «📤 Опубликовать» в Секции 9 (после approve протокола) шлёт .docx
-- с преамбулой в каждый чат `tg_chats.object_id IN meeting.object_ids`.
-- Эта таблица — журнал того, кому и когда отправили; служит для:
--   1. Защиты от двойной публикации в один чат (unique meeting_id × chat_id).
--   2. Аудита кто опубликовал и когда.
--   3. Возможности «дослать в новый чат» если объект добавлен после публикации.
--
-- См. WIKI 10_Алгоритм_собрания.md → 26.05.2026 «Публикация протокола в TG».
-- ============================================================================

create table meeting_publications (
    id            uuid primary key default gen_random_uuid(),
    meeting_id    uuid not null references meetings(id) on delete cascade,
    chat_id       bigint not null references tg_chats(chat_id) on delete restrict,
    message_id    bigint,                                -- ID отправленного сообщения в Telegram
    sent_at       timestamptz not null default now(),
    status        text not null check (status in ('ok','fail')),
    error_text    text,                                  -- если status='fail'
    sent_by       uuid references auth.users(id) on delete set null,

    unique (meeting_id, chat_id)
);

create index meeting_publications_meeting_idx on meeting_publications (meeting_id);
create index meeting_publications_chat_idx    on meeting_publications (chat_id);

comment on table  meeting_publications is
    'Журнал публикаций протокола собрания в Telegram-чаты, привязанные к объектам. Уникально по (meeting_id, chat_id) — защита от дублей.';
comment on column meeting_publications.message_id is
    'ID сообщения в Telegram, возвращённый Telethon после успешной отправки. NULL если status=fail.';
comment on column meeting_publications.status is
    'ok = сообщение и файл доставлены; fail = ошибка отправки (см. error_text).';

-- ── meetings.published_at — для быстрого фильтра «опубликовано / не опубликовано»
alter table meetings
    add column published_at timestamptz;

comment on column meetings.published_at is
    'Первая успешная публикация протокола в любой Telegram-чат. NULL = ещё не публиковали. Обновляется автоматически триггером ниже.';

-- ── триггер: meeting.published_at = min(sent_at) при INSERT ok-публикации
create or replace function meeting_publications_sync_meeting()
returns trigger language plpgsql as $$
begin
    if new.status = 'ok' then
        update meetings
           set published_at = least(coalesce(published_at, new.sent_at), new.sent_at)
         where id = new.meeting_id;
    end if;
    return new;
end$$;

create trigger meeting_publications_sync_meeting_trg
    after insert on meeting_publications
    for each row
    execute function meeting_publications_sync_meeting();

notify pgrst, 'reload schema';
