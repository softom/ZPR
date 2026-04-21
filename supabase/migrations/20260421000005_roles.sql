-- ============================================================
-- Ролевая модель ЗПР
-- ============================================================
-- Три роли:
--   service_role  — Python-скрипты, обходит RLS автоматически
--   uploader      — Оператор: чтение + создание + редактирование
--   viewer        — Руководитель: только чтение
--
-- Роль хранится в user_metadata Supabase Auth:
--   { "role": "uploader" } или { "role": "viewer" }
-- ============================================================

-- Вспомогательная функция в public схеме
create or replace function public.user_role()
returns text
language sql stable security definer
as $$
  select coalesce(
    (auth.jwt() -> 'user_metadata' ->> 'role'),
    'viewer'
  )
$$;

-- ============================================================
-- Убрать оставшиеся временные открытые политики
-- ============================================================
drop policy if exists "dev_all" on contractors;
drop policy if exists "dev_all" on objects;
drop policy if exists "dev_all" on folders;
drop policy if exists "dev_all" on letters;
drop policy if exists "dev_all" on documents;
drop policy if exists "dev_all" on contract_milestones;

-- Убрать уже созданные частичные политики (если есть)
drop policy if exists "contractors_select" on contractors;
drop policy if exists "contractors_insert" on contractors;
drop policy if exists "contractors_update" on contractors;
drop policy if exists "contractors_delete" on contractors;
drop policy if exists "objects_select"     on objects;
drop policy if exists "objects_insert"     on objects;
drop policy if exists "objects_update"     on objects;
drop policy if exists "folders_select"     on folders;
drop policy if exists "folders_write"      on folders;
drop policy if exists "letters_select"     on letters;
drop policy if exists "letters_insert"     on letters;
drop policy if exists "letters_update"     on letters;
drop policy if exists "documents_select"   on documents;
drop policy if exists "documents_insert"   on documents;
drop policy if exists "documents_update"   on documents;
drop policy if exists "milestones_select"  on contract_milestones;
drop policy if exists "milestones_write"   on contract_milestones;

-- ============================================================
-- contractors
-- ============================================================
create policy "contractors_select" on contractors
  for select using (auth.role() = 'authenticated');

create policy "contractors_insert" on contractors
  for insert with check (public.user_role() in ('uploader', 'admin'));

create policy "contractors_update" on contractors
  for update using (public.user_role() in ('uploader', 'admin'));

create policy "contractors_delete" on contractors
  for delete using (public.user_role() = 'admin');

-- ============================================================
-- objects
-- ============================================================
create policy "objects_select" on objects
  for select using (auth.role() = 'authenticated');

create policy "objects_insert" on objects
  for insert with check (public.user_role() in ('uploader', 'admin'));

create policy "objects_update" on objects
  for update using (public.user_role() in ('uploader', 'admin'));

-- DELETE намеренно отсутствует — только деактивация через active=false

-- ============================================================
-- folders
-- ============================================================
create policy "folders_select" on folders
  for select using (auth.role() = 'authenticated');

create policy "folders_write" on folders
  for all using (public.user_role() in ('uploader', 'admin'));

-- ============================================================
-- letters
-- ============================================================
create policy "letters_select" on letters
  for select using (auth.role() = 'authenticated');

create policy "letters_insert" on letters
  for insert with check (public.user_role() in ('uploader', 'admin'));

create policy "letters_update" on letters
  for update using (public.user_role() in ('uploader', 'admin'));

-- ============================================================
-- documents
-- ============================================================
create policy "documents_select" on documents
  for select using (auth.role() = 'authenticated');

create policy "documents_insert" on documents
  for insert with check (public.user_role() in ('uploader', 'admin'));

create policy "documents_update" on documents
  for update using (public.user_role() in ('uploader', 'admin'));

-- ============================================================
-- contract_milestones
-- ============================================================
create policy "milestones_select" on contract_milestones
  for select using (auth.role() = 'authenticated');

create policy "milestones_write" on contract_milestones
  for all using (public.user_role() in ('uploader', 'admin'));
