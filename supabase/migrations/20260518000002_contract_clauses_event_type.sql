-- ============================================================
-- contract_clauses: event_type_id + date_source + date_change_event_id
-- (2026-05-18)
-- ============================================================
-- 1. Привязка к классификатору (FK по UUID, не text).
-- 2. Статус даты: договорная / изменённая (со ссылкой на событие) / расчётная.
-- 3. Backfill: маппинг старого category → event_type_id.
-- 4. Триггеры: при смене event_type_id — синк category (denorm).
-- 5. Снять старый CHECK на category (заменён на 7 категорий по классификатору).
-- ============================================================

-- ─── 1) Новые поля ───────────────────────────────────────────────
alter table contract_clauses
    add column event_type_id        uuid references contract_event_types(id) on delete set null,
    add column date_source          text not null default 'contract'
        check (date_source in ('contract','edited','computed')),
    add column date_change_event_id uuid references events(id) on delete set null;

create index contract_clauses_event_type_idx on contract_clauses (event_type_id);
create index contract_clauses_date_change_event_idx
    on contract_clauses (date_change_event_id)
    where date_change_event_id is not null;

comment on column contract_clauses.event_type_id is
    'FK на classifier contract_event_types. Поле category (denorm) синкается триггером из event_type.category.';
comment on column contract_clauses.date_source is
    'Статус даты: contract (договорная, как в тексте), edited (изменена — см. date_change_event_id), computed (вычислена из формулы term_*).';
comment on column contract_clauses.date_change_event_id is
    'FK на events.id — событие-причина изменения даты (письмо, протокол). NULL если date_source != edited или причина не указана.';

-- ─── 2) Снять старый CHECK на category ───────────────────────────
-- Старый: ('fin','work','appr','legal'). Новый: 7 категорий.
-- Источник правды — contract_event_types; category в clauses остаётся как denorm.
alter table contract_clauses
    drop constraint if exists contract_clauses_category_check;
alter table contract_clauses
    add constraint contract_clauses_category_check
        check (category is null or category in ('fin','work','term','legal','appr','comm','ctrl'));

-- ─── 3) Backfill: маппинг старого category → event_type_id ──────
-- Якорный пункт (is_anchor=true) → legal_contract_sign.
-- Остальные по category: fin→fin_payment, work→work_stage, appr→appr_approval, legal→legal_amendment.
update contract_clauses cc
   set event_type_id = cet.id
  from contract_event_types cet
 where (cc.is_anchor = true  and cet.code = 'legal_contract_sign')
    or (cc.is_anchor = false and cc.category = 'fin'   and cet.code = 'fin_payment')
    or (cc.is_anchor = false and cc.category = 'work'  and cet.code = 'work_stage')
    or (cc.is_anchor = false and cc.category = 'appr'  and cet.code = 'appr_approval')
    or (cc.is_anchor = false and cc.category = 'legal' and cet.code = 'legal_amendment');

-- ─── 4) Триггеры синка category ──────────────────────────────────
-- При INSERT/UPDATE event_type_id — копируем category из classifier.
-- category остаётся в БД как denorm для быстрых фильтров без join'ов.
create or replace function trg_contract_clauses_sync_category() returns trigger
language plpgsql as $$
begin
    if new.event_type_id is not null then
        select category into new.category
          from contract_event_types
         where id = new.event_type_id;
    end if;
    return new;
end$$;

drop trigger if exists contract_clauses_sync_category_ins on contract_clauses;
create trigger contract_clauses_sync_category_ins
    before insert on contract_clauses
    for each row execute function trg_contract_clauses_sync_category();

drop trigger if exists contract_clauses_sync_category_upd on contract_clauses;
create trigger contract_clauses_sync_category_upd
    before update of event_type_id on contract_clauses
    for each row execute function trg_contract_clauses_sync_category();

-- ─── 5) Verification ─────────────────────────────────────────────
do $$
declare orphans int; anchors_typed int; anchors_total int;
begin
    select count(*) into orphans
      from contract_clauses
     where event_type_id is null and category is not null;
    if orphans > 0 then
        raise warning 'Backfill: % пунктов с category не получили event_type_id — нужно ручное связывание', orphans;
    end if;

    select count(*) into anchors_typed
      from contract_clauses
     where is_anchor = true and event_type_id is not null;
    select count(*) into anchors_total
      from contract_clauses
     where is_anchor = true;
    if anchors_typed != anchors_total then
        raise exception 'Якорных пунктов: %, типизировано: % — все якорные должны получить event_type_id', anchors_total, anchors_typed;
    end if;
end$$;

notify pgrst, 'reload schema';
