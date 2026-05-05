-- ============================================================
-- meetings: project → object_codes[] (1:N к объектам)
-- ============================================================
-- Собрание может обсуждать несколько объектов одновременно (например,
-- ХэдсГрупп ведёт 4 объекта — на одном собрании могут затрагиваться все).
-- Заменяем текстовое поле `project` на массив `object_codes` — по аналогии
-- с tasks.object_codes. Связь N:N идёт через массив + entity_links при необходимости.

alter table meetings drop column if exists project;

alter table meetings add column if not exists object_codes text[] not null default '{}';

comment on column meetings.object_codes is 'Массив кодов объектов проекта (объекты, обсуждаемые на собрании). Пример: [''02_FAM_800'',''03_FAM_500'',''04_HLT_260''] для общего собрания ХГ.';

create index if not exists meetings_object_codes_idx on meetings using gin (object_codes);

notify pgrst, 'reload schema';
