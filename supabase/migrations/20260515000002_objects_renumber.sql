-- ============================================================
-- Перенумерация кодов объектов: 001..008 → 101..108
-- (2026-05-15)
-- ============================================================
-- Цель: ввести префикс "1" — обозначение 1-й очереди строительства.
-- 000_МАСТЕРПЛАН остаётся как есть (общий для всех очередей).
--
-- Затронуто:
--   • objects.code                          (9 строк, изменятся 8)
--   • document_objects.object_code          (text FK, NO ACTION → менять на CASCADE)
--   • contract_milestones.object_code       (text без FK)
--   • meetings.object_codes                 (text[])
--   • meeting_topics.object_codes           (text[])
--   • tasks.object_codes                    (text[])
--   • event_classifier_feedback.{object_codes, auto_object_codes} (text[])
--
-- НЕ затронуто:
--   • objects.id (uuid) — стабилен, все 6 FK по object_id остаются валидны
--   • файловая система (папки используют legacy-имена в Obsidian)
--   • objects.aliases — там legacy-коды (01_APT_375 и т.п.), не меняем
--
-- Backup: _archive/backup_pre_objects_renumber_20260515_121740.sql
-- ============================================================

begin;

-- ─── 1) Перевод FK на CASCADE для безопасного UPDATE ────────────
alter table document_objects
    drop constraint document_objects_object_code_fkey;
alter table document_objects
    add constraint document_objects_object_code_fkey
        foreign key (object_code) references objects(code)
        on update cascade on delete no action;

-- ─── 2) UPDATE кодов в objects ───────────────────────────────────
-- 001..008 → 101..108. ON UPDATE CASCADE автоматически обновит document_objects.
update objects
   set code = '1' || substr(code, 2)
 where code ~ '^00[1-8]_';

-- ─── 3) UPDATE text-полей без FK ─────────────────────────────────
update contract_milestones
   set object_code = '1' || substr(object_code, 2)
 where object_code ~ '^00[1-8]_';

-- ─── 4) UPDATE text[]-полей — заменяем элементы массива ──────────
-- Помощник: для каждой строки из массива применяем regex-замену 00X→10X для X∈[1..8].
-- Используем array_agg внутри подзапроса с unnest.

update meetings
   set object_codes = (
       select array_agg(
           case when c ~ '^00[1-8]_'
                then '1' || substr(c, 2)
                else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where object_codes::text ~ '00[1-8]_';

update meeting_topics
   set object_codes = (
       select array_agg(
           case when c ~ '^00[1-8]_'
                then '1' || substr(c, 2)
                else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where object_codes::text ~ '00[1-8]_';

update tasks
   set object_codes = (
       select array_agg(
           case when c ~ '^00[1-8]_'
                then '1' || substr(c, 2)
                else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where object_codes::text ~ '00[1-8]_';

update event_classifier_feedback
   set object_codes = (
       select array_agg(
           case when c ~ '^00[1-8]_'
                then '1' || substr(c, 2)
                else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where object_codes::text ~ '00[1-8]_';

update event_classifier_feedback
   set auto_object_codes = (
       select array_agg(
           case when c ~ '^00[1-8]_'
                then '1' || substr(c, 2)
                else c
           end order by ord
       )
         from unnest(auto_object_codes) with ordinality as t(c, ord)
   )
 where auto_object_codes::text ~ '00[1-8]_';

-- ─── 5) Verification: должно быть 0 строк со старыми кодами ──────
do $$
declare
    leaked int;
begin
    select count(*) into leaked from objects where code ~ '^00[1-8]_';
    if leaked > 0 then
        raise exception 'objects: % строк со старыми кодами остались', leaked;
    end if;

    select count(*) into leaked from document_objects where object_code ~ '^00[1-8]_';
    if leaked > 0 then
        raise exception 'document_objects: % строк со старыми кодами', leaked;
    end if;

    select count(*) into leaked from contract_milestones where object_code ~ '^00[1-8]_';
    if leaked > 0 then
        raise exception 'contract_milestones: % строк со старыми кодами', leaked;
    end if;
end$$;

commit;

notify pgrst, 'reload schema';
