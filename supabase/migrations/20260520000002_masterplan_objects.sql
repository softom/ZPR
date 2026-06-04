-- ============================================================
-- ZPR — masterplan_objects (паспорт перспективного объекта)
-- ============================================================
-- Перспективные объекты из мастерплана и таблицы ТЭП, ещё не
-- дошедшие до проектирования (нет полноценного `objects`).
-- Симметрия с `objects` в связях: M:N с участками, зонами, нагрузками.
--
-- См. WIKI 33_Сущность_Объект_Мастерплана.md
-- ============================================================

create table masterplan_objects (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique not null,
  name_ppt            text not null,
  name_contract       text,
  queue               text,
  source_document_id  uuid references documents(id),
  source_pmt_oks_id   bigint references pmt_oks(id),
  note                text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index masterplan_objects_code_idx   on masterplan_objects(code);
create index masterplan_objects_queue_idx  on masterplan_objects(queue) where queue is not null;
create index masterplan_objects_active_idx on masterplan_objects(active) where active = true;

comment on table masterplan_objects is
  'Паспорт перспективного объекта (мастерплан / ПМТ-ТЭП). Преддверие activeбизнес-объекта. См. WIKI 33_Сущность_Объект_Мастерплана.md';
comment on column masterplan_objects.code is
  'Код объекта из таблицы ТЭП: <префикс_зоны>_<номер>. Пример: Г_101, К_103, Х_101, ТИ_101.';
comment on column masterplan_objects.name_ppt is
  'Наименование по ППТ: «Отель 4*», «Апарт-отель 3*».';
comment on column masterplan_objects.name_contract is
  'Наименование по договорам (если есть): «Отель 4* Select», «Отель 5* Emerald».';
comment on column masterplan_objects.queue is
  'Очередь реализации: ''1'' / ''2'' / ''1-2''.';
comment on column masterplan_objects.source_pmt_oks_id is
  'Ссылка на строку стейджинга pmt_oks, из которой первоначально импортирован объект.';
