-- ============================================================
-- object_reports — еженедельные отчёты по объектам (история)
-- ============================================================
-- Каждый клик «Переформировать» создаёт новую строку.
-- View object_reports_latest отдаёт последний отчёт по каждому объекту.

create table object_reports (
    id              uuid primary key default gen_random_uuid(),
    object_code     text not null references objects(code),

    -- Календарная неделя, за которую сделан отчёт
    period_start    date not null,                  -- понедельник
    period_end      date not null,                  -- воскресенье

    -- Три раздела резюме (от LLM, до 60 слов каждый)
    achievements    text,                           -- что сделано на неделе
    weekly_work     text,                           -- что в работе
    problems        text,                           -- проблемы / приоритеты

    -- Метаданные генерации
    generated_at    timestamptz not null default now(),
    generated_by    text,                           -- email (если известен)
    model_used      text                            -- LLM-модель
);

comment on table  object_reports is 'Еженедельные отчёты по объектам — история генераций LLM';
comment on column object_reports.period_start is 'Понедельник недели отчёта (ISO неделя)';
comment on column object_reports.period_end is 'Воскресенье недели отчёта';
comment on column object_reports.achievements is 'Раздел «Достижения» — что сделано за неделю';
comment on column object_reports.weekly_work is 'Раздел «Работы недели» — что в активной работе';
comment on column object_reports.problems is 'Раздел «Проблемы» — приоритеты, риски, просрочки';

create index object_reports_object_idx on object_reports (object_code, generated_at desc);
create index object_reports_period_idx on object_reports (period_start, period_end);

-- View: последний отчёт по каждому объекту
create or replace view object_reports_latest as
select distinct on (object_code) *
from object_reports
order by object_code, generated_at desc;

comment on view object_reports_latest is 'По одной самой свежей записи на object_code';
