-- Разрешить анонимное чтение всех таблиц.
-- Запись требует аутентификации + роль uploader/admin.

drop policy if exists "contractors_select" on contractors;
drop policy if exists "objects_select"     on objects;
drop policy if exists "folders_select"     on folders;
drop policy if exists "letters_select"     on letters;
drop policy if exists "documents_select"   on documents;
drop policy if exists "milestones_select"  on contract_milestones;

create policy "contractors_select" on contractors  for select using (true);
create policy "objects_select"     on objects      for select using (true);
create policy "folders_select"     on folders      for select using (true);
create policy "letters_select"     on letters      for select using (true);
create policy "documents_select"   on documents    for select using (true);
create policy "milestones_select"  on contract_milestones for select using (true);
