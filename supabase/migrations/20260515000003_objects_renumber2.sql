-- ============================================================
-- Точечная перенумерация двух кодов объектов (2026-05-15, ч. 2)
-- ============================================================
-- 1. 000_МАСТЕРПЛАН    → 001_МАСТЕРПЛАН (мастерплан как «объект 01 общего реестра»).
-- 2. 108_ОБЩЕЖИТИЕ_450 → 301_ОБЩЕЖИТИЕ_450 (отель 3* «Остров» — третья очередь).
--
-- FK document_objects.object_code уже на ON UPDATE CASCADE (миграция _0002),
-- поэтому ссылка в document_objects подтянется автоматически.
--
-- Backup: _archive/backup_pre_renumber2_20260515_130227.sql
-- ============================================================

begin;

-- ─── objects: PK обновление ───────────────────────────────────────
update objects set code = '001_МАСТЕРПЛАН'    where code = '000_МАСТЕРПЛАН';
update objects set code = '301_ОБЩЕЖИТИЕ_450' where code = '108_ОБЩЕЖИТИЕ_450';

-- ─── text[]-поля: array_agg-замена ────────────────────────────────
update meeting_topics
   set object_codes = (
       select array_agg(
           case
               when c = '000_МАСТЕРПЛАН'    then '001_МАСТЕРПЛАН'
               when c = '108_ОБЩЕЖИТИЕ_450' then '301_ОБЩЕЖИТИЕ_450'
               else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where '000_МАСТЕРПЛАН' = any(object_codes)
    or '108_ОБЩЕЖИТИЕ_450' = any(object_codes);

update tasks
   set object_codes = (
       select array_agg(
           case
               when c = '000_МАСТЕРПЛАН'    then '001_МАСТЕРПЛАН'
               when c = '108_ОБЩЕЖИТИЕ_450' then '301_ОБЩЕЖИТИЕ_450'
               else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where '000_МАСТЕРПЛАН' = any(object_codes)
    or '108_ОБЩЕЖИТИЕ_450' = any(object_codes);

update meetings
   set object_codes = (
       select array_agg(
           case
               when c = '000_МАСТЕРПЛАН'    then '001_МАСТЕРПЛАН'
               when c = '108_ОБЩЕЖИТИЕ_450' then '301_ОБЩЕЖИТИЕ_450'
               else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where '000_МАСТЕРПЛАН' = any(object_codes)
    or '108_ОБЩЕЖИТИЕ_450' = any(object_codes);

update event_classifier_feedback
   set object_codes = (
       select array_agg(
           case
               when c = '000_МАСТЕРПЛАН'    then '001_МАСТЕРПЛАН'
               when c = '108_ОБЩЕЖИТИЕ_450' then '301_ОБЩЕЖИТИЕ_450'
               else c
           end order by ord
       )
         from unnest(object_codes) with ordinality as t(c, ord)
   )
 where '000_МАСТЕРПЛАН' = any(object_codes)
    or '108_ОБЩЕЖИТИЕ_450' = any(object_codes);

update event_classifier_feedback
   set auto_object_codes = (
       select array_agg(
           case
               when c = '000_МАСТЕРПЛАН'    then '001_МАСТЕРПЛАН'
               when c = '108_ОБЩЕЖИТИЕ_450' then '301_ОБЩЕЖИТИЕ_450'
               else c
           end order by ord
       )
         from unnest(auto_object_codes) with ordinality as t(c, ord)
   )
 where '000_МАСТЕРПЛАН' = any(auto_object_codes)
    or '108_ОБЩЕЖИТИЕ_450' = any(auto_object_codes);

-- ─── contract_milestones: text без FK ────────────────────────────
update contract_milestones set object_code = '001_МАСТЕРПЛАН'    where object_code = '000_МАСТЕРПЛАН';
update contract_milestones set object_code = '301_ОБЩЕЖИТИЕ_450' where object_code = '108_ОБЩЕЖИТИЕ_450';

-- ─── Verification: старых кодов не осталось ──────────────────────
do $$
declare leaked int;
begin
    select count(*) into leaked from objects
        where code in ('000_МАСТЕРПЛАН', '108_ОБЩЕЖИТИЕ_450');
    if leaked > 0 then raise exception 'objects: остались старые коды (%)', leaked; end if;

    select count(*) into leaked from document_objects
        where object_code in ('000_МАСТЕРПЛАН', '108_ОБЩЕЖИТИЕ_450');
    if leaked > 0 then raise exception 'document_objects: остались старые коды (%)', leaked; end if;
end$$;

commit;

notify pgrst, 'reload schema';
