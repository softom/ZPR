-- ============================================================
-- events.contract_stage_id — общая привязка события к этапу договора
-- (2026-05-18)
-- ============================================================
-- Контекст:
--   Раньше у событий была только узкая привязка `to_stage_id` (для
--   contract_stage_change-событий — целевой этап перехода). Этого мало:
--   обычные события (project_note, meeting) тоже бывают «про этап»:
--     • «Аванс по этапу 2 поступил» → contract_stage_id=stage_2
--     • «Совещание про задержки этапа 3» → contract_stage_id=stage_3
--
--   Поле необязательное. Если у события нет stage-контекста — NULL.
--
-- Для contract_stage_change-событий допустимо иметь оба:
--   to_stage_id        = X (целевой этап перехода)
--   contract_stage_id  = X (этот event и есть переход в X — тот же UUID)
-- ============================================================

alter table events
    add column contract_stage_id uuid references contract_stages(id) on delete set null;

create index events_contract_stage_idx on events (contract_stage_id)
    where contract_stage_id is not null;

comment on column events.contract_stage_id is
    'FK на contract_stages — этап договора, к которому относится событие (общее, для любого event_type). Не путать с to_stage_id (целевой этап для contract_stage_change-перехода).';

-- При создании contract_stage_change-события через /transition будем заодно
-- проставлять contract_stage_id = to_stage_id — это даёт единое поле для
-- фильтрации/отображения по этапу во всём UI.

notify pgrst, 'reload schema';
