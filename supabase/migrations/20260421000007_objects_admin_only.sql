-- Создание и редактирование объектов — только admin
drop policy if exists "objects_insert" on objects;
drop policy if exists "objects_update" on objects;
drop policy if exists "folders_write"  on folders;

create policy "objects_insert" on objects
  for insert with check (public.user_role() = 'admin');

create policy "objects_update" on objects
  for update using (public.user_role() = 'admin');

-- Папки объектов тоже только admin (folders_write использовался для объектов)
create policy "folders_write" on folders
  for all using (public.user_role() = 'admin');
