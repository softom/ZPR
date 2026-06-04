-- ============================================================================
-- Связь СОБЫТИЕ ↔ TG-сообщение + источник события + типы для классификатора.
-- ============================================================================
-- Зачем:
--   1) events.derived_source — отмечаем откуда пришло событие (manual/tg/...)
--   2) event_tg_messages — N:M связь, событие может опираться на N сообщений,
--      одно сообщение может породить N событий (рассылка в N чатов).
--   3) event_classifier_templates — реестр типов событий, которые автомат
--      ищет в диалогах. Содержит и rule-шаблоны (L1), и LLM-промпты (L2).
-- ============================================================================

-- ── 1. events.derived_source ─────────────────────────────────────────────────

alter table events
    add column derived_source text
        check (derived_source in ('manual','tg','mail','bitrix','contract','protocol'))
        default 'manual';

create index events_derived_source_idx on events (derived_source)
    where derived_source <> 'manual';

-- ── 2. event_tg_messages — связь N:M ─────────────────────────────────────────

create table event_tg_messages (
    event_id      uuid not null references events(id) on delete cascade,
    tg_message_id uuid not null references tg_messages(id) on delete cascade,
    confidence    smallint not null default 50
                  check (confidence between 0 and 100),
    link_kind     text not null default 'source'
                  check (link_kind in ('source','referenced','context')),
    created_at    timestamptz default now(),
    primary key (event_id, tg_message_id)
);

create index event_tg_messages_event_idx on event_tg_messages(event_id);
create index event_tg_messages_msg_idx   on event_tg_messages(tg_message_id);

-- ── 3. event_classifier_templates — типы событий для автомата ────────────────

create table event_classifier_templates (
    id                  uuid primary key default gen_random_uuid(),
    code                text unique not null,
    label               text not null,
    description         text,
    layer               text not null check (layer in ('rule','llm')),

    -- Для layer='rule':
    trigger_media_kinds text[],
    trigger_sender_role text check (trigger_sender_role in ('me','other','any')),
    trigger_text_regex  text,

    -- Для обоих:
    title_template      text not null,
    event_type          text not null default 'project_note',
    priority            int default 50,
    active              boolean default true,
    created_at          timestamptz default now(),
    updated_at          timestamptz default now()
);

create index event_classifier_templates_layer_idx on event_classifier_templates(layer)
    where active = true;

-- ── 4. Seed — стартовый набор типов ──────────────────────────────────────────

insert into event_classifier_templates
    (code, label, layer, trigger_media_kinds, trigger_sender_role, title_template, priority)
values
    -- L1 (правила, без LLM):
    ('doc_received',  'Получен документ от подрядчика',
     'rule', '{document,webpage}'::text[], 'other',
     'Получен документ «{filename}» от {sender}', 10),

    ('doc_sent',  'Направлен документ подрядчику',
     'rule', '{document,webpage}'::text[], 'me',
     'Направлен документ «{filename}»', 20),

    ('material_link',  'Передана ссылка на материал',
     'rule', '{webpage}'::text[], 'any',
     'Передана ссылка: {caption}', 30),

    ('photo_with_caption',  'Фото с комментарием',
     'rule', '{photo}'::text[], 'any',
     'Фото с комментарием: «{caption}»', 40),

    -- L2 (LLM):
    ('meeting_scheduled', 'Назначено собрание / ВКС',
     'llm', null, null,
     'Назначено собрание: {topic} ({when})', 100),

    ('meeting_held', 'Состоялось собрание / ВКС',
     'llm', null, null,
     'Состоялось собрание: {topic}', 110),

    ('term_changed', 'Изменение договорных сроков',
     'llm', null, null,
     'Изменение сроков: {description}', 120),

    ('decision_made', 'Принято решение',
     'llm', null, null,
     'Принято решение: {description}', 130),

    ('correction_received', 'Получены замечания / правки',
     'llm', null, null,
     'Получены замечания: {description}', 140),

    ('protocol_correction', 'Правка протокола',
     'llm', null, null,
     'Правка протокола {meeting_date} от {party}', 150),

    ('request_for_action', 'Поручение / запрос действия',
     'llm', null, null,
     'Поручение: {description}', 160);

-- ── 5. Регистрация в реестре миграций ───────────────────────────────────────

insert into _applied_migrations (filename) values
    ('20260513000001_event_tg_link.sql')
on conflict do nothing;
