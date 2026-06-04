-- ============================================================================
-- event_classifier_feedback — журнал решений оператора (accept/reject) в /events/preliminary
-- ============================================================================
-- Append-only: на каждое нажатие ✅ Принять / 🗑 Отбросить — одна строка.
-- Используется `tg_classifier.py` при формировании LLM-промпта (Уровень 2):
-- последние 5-10 решений по объекту подаются как few-shot examples, чтобы LLM
-- подстраивался под стиль и приоритеты оператора без переобучения модели.
-- ============================================================================

create table event_classifier_feedback (
    id              uuid primary key default gen_random_uuid(),
    template_code   text references event_classifier_templates(code) on delete set null,
    layer           text not null check (layer in ('rule','llm')),
    decision        text not null check (decision in ('accepted','rejected')),

    -- Snapshot заголовка/комментария
    auto_title      text not null,           -- что предложил классификатор
    final_title     text,                    -- финальная версия (для accepted; NULL для rejected)
    auto_note       text,
    final_note      text,
    title_edited    boolean not null default false,

    -- Контекст (поможет LLM понять, почему было такое решение)
    source_quote    text,                    -- цитата из tg-сообщения (file_name или text)
    confidence      smallint,
    object_codes    text[] not null default '{}',

    decided_at      timestamptz not null default now()
);

create index efb_template_idx   on event_classifier_feedback(template_code);
create index efb_decision_idx   on event_classifier_feedback(decision);
create index efb_decided_at_idx on event_classifier_feedback(decided_at desc);
create index efb_objects_idx    on event_classifier_feedback using gin (object_codes);

-- RLS: viewer/anon — SELECT; uploader/admin — INSERT; admin — DELETE
alter table event_classifier_feedback enable row level security;

create policy "efb: anyone read"      on event_classifier_feedback for select using (true);
create policy "efb: uploader insert"  on event_classifier_feedback for insert
    with check (public.user_role() in ('uploader','admin','service_role'));
create policy "efb: admin delete"     on event_classifier_feedback for delete
    using (public.user_role() in ('admin','service_role'));

insert into _applied_migrations (filename) values
    ('20260513000003_classifier_feedback.sql')
on conflict do nothing;
