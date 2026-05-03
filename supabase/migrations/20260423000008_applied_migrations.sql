-- Реестр применённых миграций — источник истины для scripts/db-migrate.ps1.
-- До этой миграции миграции применялись вручную через `docker exec < file.sql`,
-- без учёта того, что именно уже в БД. Теперь каждое применение через скрипт
-- регистрируется здесь; повторное применение — идемпотентно (ON CONFLICT).
--
-- Bootstrap: все миграции, созданные ДО этой, помечаются как применённые
-- (они реально уже в БД на момент создания таблицы). Скрипт будет применять
-- только новые файлы, отсутствующие в этом списке.

create table if not exists _applied_migrations (
    filename    text        primary key,
    applied_at  timestamptz not null default now(),
    applied_by  text                 default current_user
);

comment on table _applied_migrations is
    'Реестр применённых миграций. Ведётся скриптом scripts/db-migrate.ps1. Источник истины — имена файлов из supabase/migrations/.';

comment on column _applied_migrations.filename is
    'Имя файла миграции, напр. "20260423000007_search_documents_filters.sql"';

-- Bootstrap: помечаем все существующие на момент создания таблицы миграции
insert into _applied_migrations (filename) values
    ('20260421000001_init.sql'),
    ('20260421000002_contractors.sql'),
    ('20260421000003_comments.sql'),
    ('20260421000004_objects_active.sql'),
    ('20260421000005_roles.sql'),
    ('20260421000006_anon_select.sql'),
    ('20260421000007_objects_admin_only.sql'),
    ('20260422000001_milestone_date_start.sql'),
    ('20260422000002_documents_parties.sql'),
    ('20260422000003_events_table.sql'),
    ('20260422000004_event_date_editions.sql'),
    ('20260422000005_entity_links.sql'),
    ('20260423000001_event_predecessors.sql'),
    ('20260423000002_fact_date_and_reason.sql'),
    ('20260423000003_soft_delete.sql'),
    ('20260423000004_document_chunks.sql'),
    ('20260423000006_events_note.sql'),
    ('20260423000007_search_documents_filters.sql'),
    ('20260423000008_applied_migrations.sql')
on conflict (filename) do nothing;
