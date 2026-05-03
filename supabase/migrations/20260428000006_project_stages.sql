-- ====================================================================
-- project_stages — справочник стадий проекта
-- documents.project_stage — стадия договора (одна), расширяемый список.
-- ====================================================================
-- Стандартные стадии: Фор-Эскиз → Концепция → Проект → Рабочая документация → Экспертиза.
-- Расширяется через UI/админку или прямой INSERT.

create table if not exists project_stages (
    code        text primary key,
    label       text not null,
    sort_order  int  not null default 0,
    created_at  timestamptz not null default now()
);

comment on table  project_stages is 'Справочник стадий проекта — расширяется по мере необходимости';
comment on column project_stages.code is 'Машинный код, используется в FK (например documents.project_stage)';
comment on column project_stages.label is 'Отображаемое имя в UI: «Фор-Эскиз», «Рабочая документация»';
comment on column project_stages.sort_order is 'Порядок отображения в списках/селектах';

alter table project_stages enable row level security;
drop policy if exists ps_select on project_stages;
drop policy if exists ps_insert on project_stages;
drop policy if exists ps_update on project_stages;

create policy ps_select on project_stages for select using (true);
create policy ps_insert on project_stages for insert
  with check (public.user_role() in ('uploader','admin','service_role'));
create policy ps_update on project_stages for update
  using (public.user_role() in ('uploader','admin','service_role'));

-- ─── Seed ────────────────────────────────────────────────────────────────────
insert into project_stages (code, label, sort_order) values
  ('foresketch',   'Фор-Эскиз',            10),
  ('concept',      'Концепция',            20),
  ('project',      'Проект',               30),
  ('working_docs', 'Рабочая документация', 40),
  ('expertise',    'Экспертиза',           50)
on conflict (code) do nothing;

-- ─── Поле в documents ───────────────────────────────────────────────────────
alter table documents
  add column if not exists project_stage text
       references project_stages(code) on update cascade on delete set null;

create index if not exists documents_project_stage_idx
  on documents (project_stage) where project_stage is not null;

comment on column documents.project_stage
  is 'FK → project_stages.code — стадия проекта (foresketch / concept / project / working_docs / expertise / ...)';

notify pgrst, 'reload schema';
