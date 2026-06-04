-- ============================================================================
-- strategic_topics — каркас стратегических управленческих тем
-- ============================================================================
-- См. WIKI 24_Стратегические_темы.md
--
-- Темы заполняются вручную из аналитических отчётов ТЗ-ЮГ
-- (раздел «Риски и решения»). Ежемесячный отчёт не обновляет темы
-- автоматически — только ручная правка.
--
-- topic_focus (проекция темы на сечения графика) — отдельной миграцией
-- ПОСЛЕ завершения переработки импорта ГПР в calendar_entries.
-- ============================================================================

-- ─── Таблица strategic_topics ─────────────────────────────────────────────
create table strategic_topics (
    id                  uuid primary key default gen_random_uuid(),
    code                text unique,
    title               text not null,

    category            text not null
                        check (category in ('environment','engineering',
                                            'land_legal','organization',
                                            'personnel','contracting')),

    synopsis            text not null,
    description         text not null,
    threats             text not null,
    solutions           text,
    deadlines           text,

    status              text not null default 'open'
                        check (status in ('open','in_progress','mitigated',
                                          'resolved','cancelled')),

    owner_entity_id     uuid references legal_entities(id) on delete set null,

    source_document_id  uuid references documents(id) on delete set null,
    source_quote        text,

    notes               text,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index strategic_topics_status_idx   on strategic_topics (status);
create index strategic_topics_category_idx on strategic_topics (category);
create index strategic_topics_owner_idx    on strategic_topics (owner_entity_id)
    where owner_entity_id is not null;
create index strategic_topics_source_idx   on strategic_topics (source_document_id)
    where source_document_id is not null;

-- ─── updated_at trigger ───────────────────────────────────────────────────
create or replace function strategic_topics_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger strategic_topics_updated_at
    before update on strategic_topics
    for each row execute function strategic_topics_set_updated_at();

-- ─── Расширение entity_links: тип 'strategic_topic' ───────────────────────
-- Добавляем strategic_topic в from_type/to_type, и новые link_type:
--   supports   — task → strategic_topic (задача работает на закрытие темы)
--   mitigates  — event → strategic_topic (событие сняло часть угрозы)
--   addresses  — calendar_entry → strategic_topic (плановая веха адресует тему)
--   discusses  — meeting_topic → strategic_topic (тема собрания касается стратегической)
-- (link_type 'from_document' уже существует — переиспользуем для documents → strategic_topic)

alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links drop constraint entity_links_to_type_check;
alter table entity_links drop constraint entity_links_link_type_check;

alter table entity_links add constraint entity_links_from_type_check
    check (from_type in ('event','calendar_entry','document','letter','object',
                         'milestone','contractor','meeting','task','legal_entity',
                         'contact','meeting_topic','strategic_topic'));

alter table entity_links add constraint entity_links_to_type_check
    check (to_type in ('event','calendar_entry','document','letter','object',
                       'milestone','contractor','meeting','task','legal_entity',
                       'contact','meeting_topic','strategic_topic'));

alter table entity_links add constraint entity_links_link_type_check
    check (link_type in ('belongs_to','from_document','from_letter','references',
                         'implements','from_meeting','from_protocol','assigned_to',
                         'blocks','blocked_by',
                         'fulfills',
                         'supports','mitigates','addresses','discusses'));

-- ─── RLS ──────────────────────────────────────────────────────────────────
alter table strategic_topics enable row level security;

create policy strategic_topics_select on strategic_topics for select using (true);
create policy strategic_topics_insert on strategic_topics for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy strategic_topics_update on strategic_topics for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy strategic_topics_delete on strategic_topics for delete
    using (user_role() = any(array['admin','service_role']));

-- ─── Комментарии ──────────────────────────────────────────────────────────
comment on table strategic_topics is
    'Стратегические управленческие темы (горизонт 6-18 мес.). Заполняются вручную из аналитических отчётов. См. WIKI 24.';

comment on column strategic_topics.id is 'PK';
comment on column strategic_topics.code is
    'Опциональный короткий код для URL/ссылок: KADRY, MAGISTRAL_NETS, ROAD_TRANSFER';
comment on column strategic_topics.title is
    'Короткое название (действие или предмет)';
comment on column strategic_topics.category is
    'Категория: environment | engineering | land_legal | organization | personnel | contracting';
comment on column strategic_topics.synopsis is
    '1-2 предложения. Что это и почему важно. Читается отдельно — на доске тем и в индексе';
comment on column strategic_topics.description is
    'Развёрнутый контекст: что есть сейчас, как сложилось. Прошлое и настоящее, без действий';
comment on column strategic_topics.threats is
    'Что произойдёт если не реагировать или поздно. Будущее время, привязка к срокам/этапам';
comment on column strategic_topics.solutions is
    'Что предлагается делать. Уровень намерения, без сроков и исполнителей';
comment on column strategic_topics.deadlines is
    'Свободный текст: критические даты, окна, контрольные точки';
comment on column strategic_topics.status is
    'Статус: open | in_progress | mitigated | resolved | cancelled. Default open';
comment on column strategic_topics.owner_entity_id is
    'FK → legal_entities.id (SET NULL при удалении). Кто ведёт тему';
comment on column strategic_topics.source_document_id is
    'FK → documents.id (SET NULL при удалении). Документ-источник темы (аналитический отчёт)';
comment on column strategic_topics.source_quote is
    'Точная цитата из источника для аудита';
comment on column strategic_topics.notes is
    'Свободные заметки оператора';
comment on column strategic_topics.created_at is 'Дата создания (auto)';
comment on column strategic_topics.updated_at is 'Дата последнего изменения (auto через триггер)';

-- ─── PostgREST schema reload ──────────────────────────────────────────────
notify pgrst, 'reload schema';
