-- ============================================================
-- Новый тип отчёта: 'control' — Справка ТЗ (для руководства/акционеров)
-- ============================================================
-- Аудитория: руководство, акционеры.
-- Парадигма: НЕ периодический срез (как week/month), а ИНТЕГРАЛЬНЫЙ снимок
-- состояния проекта на дату формирования. На каждом объекте — нарратив
-- (по образцу "Справки по отчёту технического заказчика"):
--   - текущее состояние и сроки ТЭП
--   - этапы договора (Массинг / ОПР / МОП), фактические и плановые даты
--   - ключевые решения и поручения
--   - изменения функционального задания
--
-- Группировка объектов — по priority_group:
--   priority  — первоочередные (ТЭП в ближайшее время)
--   secondary — прочие
--   null      — не классифицирован
--
-- Поля object_reports под control (в дополнение к существующим week/month-полям):
--   narrative          — основной текстовый блок (3-5 абзацев)
--   contract_summary   — этапы договора со сроками (Markdown-список)
--   decisions          — ключевые решения и поручения (Markdown-список)
--   priority_group     — 'priority' | 'secondary' | null
--   tep_deadline       — конкретный срок ТЭП для этого объекта (date)
--
-- Поле reports под control:
--   preamble — преамбула отчёта (общее описание проекта, перечень объектов)
-- ============================================================

-- ─── 1) расширить period_type ────────────────────────────────────
alter table reports drop constraint if exists reports_period_type_check;
alter table reports add constraint reports_period_type_check
    check (period_type in ('week','month','control'));

-- Уникальность (period_type, period_start) — оставляем для week/month,
-- но для control разрешаем несколько снимков на одну дату (partial index).
alter table reports drop constraint if exists reports_period_type_period_start_key;
drop index if exists reports_period_type_period_start_key;

-- Заново создаём partial unique только для week/month
create unique index if not exists reports_period_unique_week_month
    on reports (period_type, period_start)
    where period_type in ('week','month');

-- ─── 2) preamble в reports ───────────────────────────────────────
alter table reports
    add column if not exists preamble text;
comment on column reports.preamble is
    'Преамбула отчёта (общее описание, перечень объектов и сроков). Используется в control-отчётах.';

-- ─── 3) поля для control в object_reports ────────────────────────
alter table object_reports
    add column if not exists narrative        text,
    add column if not exists contract_summary text,
    add column if not exists decisions        text,
    add column if not exists priority_group   text,
    add column if not exists tep_deadline     date;

-- CHECK на priority_group
alter table object_reports drop constraint if exists object_reports_priority_group_check;
alter table object_reports add constraint object_reports_priority_group_check
    check (priority_group is null or priority_group in ('priority','secondary'));

create index if not exists object_reports_priority_group_idx
    on object_reports (priority_group)
    where priority_group is not null;

comment on column object_reports.narrative is
    'control: основной текстовый блок раздела (3-5 абзацев).';
comment on column object_reports.contract_summary is
    'control: этапы договора (Массинг/ОПР/МОП) со сроками. Markdown-список.';
comment on column object_reports.decisions is
    'control: ключевые решения и поручения. Markdown-список.';
comment on column object_reports.priority_group is
    'control: ''priority'' (первоочередной) или ''secondary'' (прочий). null = не классифицирован.';
comment on column object_reports.tep_deadline is
    'control: конкретный срок ТЭП этого объекта (для шапки раздела).';

notify pgrst, 'reload schema';
