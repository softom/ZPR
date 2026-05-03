-- ====================================================================
-- Этап 1.1 — Ветка «Договор»
-- Дополняет legal_entities, создаёт document_objects + contract_clauses,
-- добавляет в documents FK на ЮЛ, мигрирует parties JSONB → FK + snapshot,
-- разворачивает object_codes JSONB → document_objects.
-- См. 17_Сущность_Договор_и_ЮрЛицо.md, 18_Архитектура_модулей.md, 19_…
-- ====================================================================

-- ─── 1. Дополнить legal_entities новыми полями ──────────────────────────────

alter table legal_entities
  add column if not exists short_name       text,
  add column if not exists entity_type      text not null default 'legal'
              check (entity_type in ('legal','individual','physical')),
  add column if not exists address_legal    text,
  add column if not exists address_postal   text,
  add column if not exists signatory_basis  text,
  add column if not exists bank_details     jsonb,
  add column if not exists email            text,
  add column if not exists phone            text,
  add column if not exists website          text,
  add column if not exists notes            text,
  add column if not exists is_active        boolean not null default true;

-- legacy address (из миграции 20260424000003) → address_legal
update legal_entities
   set address_legal = address
 where address is not null
   and address_legal is null;

alter table legal_entities drop column if exists address;

-- entity_type для ИП (12-значный ИНН) — установить из дефолта 'legal'
update legal_entities
   set entity_type = 'individual'
 where length(inn) = 12
   and entity_type = 'legal';

-- ─── 2. RLS-политики для legal_entities ─────────────────────────────────────

alter table legal_entities enable row level security;
drop policy if exists le_select on legal_entities;
drop policy if exists le_insert on legal_entities;
drop policy if exists le_update on legal_entities;

create policy le_select on legal_entities for select using (true);
create policy le_insert on legal_entities for insert
  with check (public.user_role() in ('uploader','admin','service_role'));
create policy le_update on legal_entities for update
  using (public.user_role() in ('uploader','admin','service_role'));

-- ─── 3. document_objects — N:N договор↔объект ───────────────────────────────

create table if not exists document_objects (
  document_id uuid not null references documents(id) on delete cascade,
  object_code text not null references objects(code),
  primary key (document_id, object_code)
);

create index if not exists document_objects_object_idx on document_objects (object_code);

alter table document_objects enable row level security;
drop policy if exists do_select on document_objects;
drop policy if exists do_insert on document_objects;
drop policy if exists do_delete on document_objects;

create policy do_select on document_objects for select using (true);
create policy do_insert on document_objects for insert
  with check (public.user_role() in ('uploader','admin','service_role'));
create policy do_delete on document_objects for delete
  using (public.user_role() in ('uploader','admin','service_role'));

-- ─── 4. contract_clauses — пункты договора ──────────────────────────────────

create table if not exists contract_clauses (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents(id) on delete cascade,
  order_index  int  not null,
  clause_date  date,
  description  text not null,
  note         text,
  source_page  int,
  source_quote text,
  created_at   timestamptz not null default now(),
  unique (document_id, order_index)
);

create index if not exists contract_clauses_document_idx
  on contract_clauses (document_id, order_index);

alter table contract_clauses enable row level security;
drop policy if exists cc_select on contract_clauses;
drop policy if exists cc_insert on contract_clauses;
drop policy if exists cc_update on contract_clauses;
drop policy if exists cc_delete on contract_clauses;

create policy cc_select on contract_clauses for select using (true);
create policy cc_insert on contract_clauses for insert
  with check (public.user_role() in ('uploader','admin','service_role'));
create policy cc_update on contract_clauses for update
  using (public.user_role() in ('uploader','admin','service_role'));
create policy cc_delete on contract_clauses for delete
  using (public.user_role() in ('uploader','admin','service_role'));

-- ─── 5. documents: FK на ЮЛ ──────────────────────────────────────────────────

alter table documents
  add column if not exists customer_entity_id   uuid references legal_entities(id),
  add column if not exists contractor_entity_id uuid references legal_entities(id);

create index if not exists documents_customer_idx
  on documents (customer_entity_id) where customer_entity_id is not null;
create index if not exists documents_contractor_idx
  on documents (contractor_entity_id) where contractor_entity_id is not null;

-- ─── 6. Миграция данных: parties JSONB → legal_entities + FK ────────────────

-- 6a. Создать ЮЛ из parties.customer (ИНН, которых нет в legal_entities)
insert into legal_entities (name, inn, kpp, address_legal, signatory_name, signatory_position, entity_type)
select distinct on (parties->'customer'->>'inn')
       parties->'customer'->>'name',
       parties->'customer'->>'inn',
       nullif(parties->'customer'->>'kpp',''),
       nullif(parties->'customer'->>'address',''),
       trim(split_part(coalesce(parties->'customer'->>'signatory',''), ',', 1)),
       trim(split_part(coalesce(parties->'customer'->>'signatory',''), ',', 2)),
       case when length(parties->'customer'->>'inn') = 12 then 'individual' else 'legal' end
  from documents
 where parties->'customer'->>'inn' is not null
   and parties->'customer'->>'inn' <> ''
on conflict (inn) do nothing;

-- 6b. То же для contractor
insert into legal_entities (name, inn, kpp, address_legal, signatory_name, signatory_position, entity_type)
select distinct on (parties->'contractor'->>'inn')
       parties->'contractor'->>'name',
       parties->'contractor'->>'inn',
       nullif(parties->'contractor'->>'kpp',''),
       nullif(parties->'contractor'->>'address',''),
       trim(split_part(coalesce(parties->'contractor'->>'signatory',''), ',', 1)),
       trim(split_part(coalesce(parties->'contractor'->>'signatory',''), ',', 2)),
       case when length(parties->'contractor'->>'inn') = 12 then 'individual' else 'legal' end
  from documents
 where parties->'contractor'->>'inn' is not null
   and parties->'contractor'->>'inn' <> ''
on conflict (inn) do nothing;

-- 6c. Проставить customer_entity_id
update documents d
   set customer_entity_id = le.id
  from legal_entities le
 where le.inn = d.parties->'customer'->>'inn'
   and d.customer_entity_id is null
   and d.parties->'customer'->>'inn' is not null;

-- 6d. Проставить contractor_entity_id
update documents d
   set contractor_entity_id = le.id
  from legal_entities le
 where le.inn = d.parties->'contractor'->>'inn'
   and d.contractor_entity_id is null
   and d.parties->'contractor'->>'inn' is not null;

-- 6e. Переименовать parties → parties_snapshot
alter table documents rename column parties to parties_snapshot;

-- ─── 7. Развернуть object_codes JSONB → document_objects ────────────────────

insert into document_objects (document_id, object_code)
select d.id, jsonb_array_elements_text(d.object_codes)
  from documents d
 where d.object_codes is not null
   and jsonb_array_length(d.object_codes) > 0
on conflict do nothing;

alter table documents drop column if exists object_codes;

-- ─── 8. Перезагрузка PostgREST для подхвата схемы ───────────────────────────
notify pgrst, 'reload schema';
