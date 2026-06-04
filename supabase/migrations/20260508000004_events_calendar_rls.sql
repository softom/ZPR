-- ============================================================================
-- RLS политики для events / calendar_* / event_*
-- ============================================================================
-- Контекст: после сплита 20260508000001-3 у events/calendar_entries остались
-- только anon-select + service-all политики. UI работает под anon JWT, поэтому
-- UPDATE/INSERT/DELETE через клиентский supabase падал по RLS.
-- Используем тот же паттерн, что в contract_clauses: role-based через
-- user_role() (uploader/admin/service_role).
-- ============================================================================

-- ─── events: дополняем 2 политики до 4 ─────────────────────────────────────
drop policy if exists "anon select" on events;
drop policy if exists "service all" on events;

create policy events_select on events for select using (true);
create policy events_insert on events for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy events_update on events for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy events_delete on events for delete
    using (user_role() = any(array['uploader','admin','service_role']));

-- ─── event_object_status ──────────────────────────────────────────────────
alter table event_object_status enable row level security;

create policy eos_select on event_object_status for select using (true);
create policy eos_insert on event_object_status for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy eos_update on event_object_status for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy eos_delete on event_object_status for delete
    using (user_role() = any(array['uploader','admin','service_role']));

-- ─── event_attachments ────────────────────────────────────────────────────
alter table event_attachments enable row level security;

create policy ea_select on event_attachments for select using (true);
create policy ea_insert on event_attachments for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy ea_update on event_attachments for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy ea_delete on event_attachments for delete
    using (user_role() = any(array['uploader','admin','service_role']));

-- ─── calendar_entries: дополняем 2 политики до 4 ──────────────────────────
drop policy if exists "anon select" on calendar_entries;
drop policy if exists "service all" on calendar_entries;

create policy ce_select on calendar_entries for select using (true);
create policy ce_insert on calendar_entries for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy ce_update on calendar_entries for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy ce_delete on calendar_entries for delete
    using (user_role() = any(array['uploader','admin','service_role']));

-- ─── calendar_object_status ───────────────────────────────────────────────
drop policy if exists "anon select" on calendar_object_status;
drop policy if exists "service all" on calendar_object_status;

create policy cos_select on calendar_object_status for select using (true);
create policy cos_insert on calendar_object_status for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy cos_update on calendar_object_status for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy cos_delete on calendar_object_status for delete
    using (user_role() = any(array['uploader','admin','service_role']));

-- ─── calendar_date_editions ───────────────────────────────────────────────
drop policy if exists "anon select" on calendar_date_editions;
drop policy if exists "service all" on calendar_date_editions;

create policy cde_select on calendar_date_editions for select using (true);
create policy cde_insert on calendar_date_editions for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy cde_update on calendar_date_editions for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy cde_delete on calendar_date_editions for delete
    using (user_role() = any(array['uploader','admin','service_role']));

-- ─── calendar_predecessors ────────────────────────────────────────────────
drop policy if exists "anon select" on calendar_predecessors;
drop policy if exists "service all" on calendar_predecessors;

create policy cp_select on calendar_predecessors for select using (true);
create policy cp_insert on calendar_predecessors for insert
    with check (user_role() = any(array['uploader','admin','service_role']));
create policy cp_update on calendar_predecessors for update
    using (user_role() = any(array['uploader','admin','service_role']));
create policy cp_delete on calendar_predecessors for delete
    using (user_role() = any(array['uploader','admin','service_role']));

notify pgrst, 'reload schema';
