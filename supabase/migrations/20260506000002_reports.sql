-- ============================================================
-- Сущность ОТЧЁТ (недельный/месячный) — v1
-- ============================================================
-- См. план wiki-twinkling-moore.md → "Сущность ОТЧЁТ".
--
-- Парадигма:
--   • reports — общий срез на дату (period_type week|month, period_start..end)
--   • object_reports — раздел отчёта по одному объекту, FK report_id
--     + 4-секционная структура (project_movement / achievements
--       / next_period_tasks / risks)
--   • Старые поля weekly_work / problems оставлены для 4 legacy-записей
--     (помечены DEPRECATED в комментариях).
--
-- Период:
--   • week  = 7 дней пн-вс (period_start = понедельник, period_end = воскресенье)
--   • month = календарный (period_start = 1-е, period_end = последнее число)

-- ─── reports ────────────────────────────────────────────────────
create table reports (
    id            uuid primary key default gen_random_uuid(),
    period_type   text not null check (period_type in ('week','month')),
    period_start  date not null,
    period_end    date not null check (period_end >= period_start),
    title         text,
    status        text not null default 'draft' check (status in ('draft','final')),
    created_at    timestamptz not null default now(),
    finalized_at  timestamptz,
    unique (period_type, period_start)
);

create index reports_period_idx on reports (period_type, period_start desc);
create index reports_status_idx on reports (status);

comment on table reports is
    'Общий отчёт-срез (недельный/месячный). Состоит из object_reports — по одному на каждый активный объект.';

-- updated_at-style: триггер на finalized_at не нужен (выставляется явно при finalize)

-- ─── object_reports — расширение ─────────────────────────────────
alter table object_reports
    add column report_id           uuid references reports(id) on delete cascade,
    add column project_movement    text,
    add column next_period_tasks   text,
    add column risks               text;

create index object_reports_report_idx on object_reports (report_id);

comment on column object_reports.report_id is 'FK на общий отчёт. NULL для legacy-записей до 06.05.2026';
comment on column object_reports.project_movement is 'Раздел 1: «Существующее движение проекта»';
comment on column object_reports.achievements is 'Раздел 2: «Достижения за период»';
comment on column object_reports.next_period_tasks is 'Раздел 3: «Задачи наступающего периода»';
comment on column object_reports.risks is 'Раздел 4: «Риски»';
comment on column object_reports.weekly_work is 'DEPRECATED — заменено на 4-секционную структуру (project_movement/achievements/next_period_tasks/risks)';
comment on column object_reports.problems is 'DEPRECATED — заменено на риски';

notify pgrst, 'reload schema';
