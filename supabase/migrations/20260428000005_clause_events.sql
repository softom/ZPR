-- ====================================================================
-- clause_events — связь ПунктДоговора → События проекта (1:N)
-- ====================================================================
-- Один пункт договора может породить несколько событий проекта
-- (например: пункт «Этап 1: сдать форэскиз 15.05.2026» → события
-- «Начало этапа», «Сдача форэскиза», «Подписание акта», «Окончательный платёж»).
--
-- Создание этих связей — модуль C (Этап 3 архитектуры).
-- На Этапе 1 таблица создана и пуста — готова к наполнению.
--
-- Каскадная очистка обеспечена FK ON DELETE CASCADE:
--   - удаление пункта (договора) → clause_events удаляются;
--   - удаление события (через DELETE /api/contracts/v2/[id] или вручную) →
--     clause_events удаляются.

create table if not exists clause_events (
  clause_id  uuid not null references contract_clauses(id) on delete cascade,
  event_id   uuid not null references events(id)            on delete cascade,
  created_at timestamptz not null default now(),
  primary key (clause_id, event_id)
);

create index if not exists clause_events_event_idx  on clause_events (event_id);
create index if not exists clause_events_clause_idx on clause_events (clause_id);

comment on table  clause_events            is 'Связь N:N между пунктами договора (contract_clauses) и событиями (events). Один пункт может порождать несколько событий.';
comment on column clause_events.clause_id  is 'FK → contract_clauses.id (CASCADE при удалении пункта)';
comment on column clause_events.event_id   is 'FK → events.id (CASCADE при удалении события — например, при погашении событий договора)';

alter table clause_events enable row level security;
drop policy if exists ce_select on clause_events;
drop policy if exists ce_insert on clause_events;
drop policy if exists ce_delete on clause_events;

create policy ce_select on clause_events for select using (true);
create policy ce_insert on clause_events for insert
  with check (public.user_role() in ('uploader','admin','service_role'));
create policy ce_delete on clause_events for delete
  using (public.user_role() in ('uploader','admin','service_role'));

-- ─── helper: события одного пункта / пункты одного события ──────────────────

create or replace function clause_events_for_event(p_event_id uuid)
returns table(clause_id uuid, document_id uuid, order_index int, description text, source_page int, source_quote text)
language sql stable as $$
    select cc.id, cc.document_id, cc.order_index, cc.description, cc.source_page, cc.source_quote
      from clause_events ce
      join contract_clauses cc on cc.id = ce.clause_id
     where ce.event_id = p_event_id
     order by cc.order_index;
$$;

comment on function clause_events_for_event(uuid)
  is 'Все пункты договора, из которых произошло событие — для отображения «источника» в UI событий';

create or replace function events_for_clause(p_clause_id uuid)
returns table(event_id uuid, title text, event_type text, date_computed date, fact_date date)
language sql stable as $$
    select e.id, e.title, e.event_type, e.date_computed, e.fact_date
      from clause_events ce
      join events e on e.id = ce.event_id
     where ce.clause_id = p_clause_id
     order by coalesce(e.date_computed, e.date_end);
$$;

comment on function events_for_clause(uuid)
  is 'Все события, порождённые из пункта договора — для отображения связанных событий в редакторе пунктов';

notify pgrst, 'reload schema';
