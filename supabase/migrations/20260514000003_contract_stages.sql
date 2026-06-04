-- ============================================================
-- Этапы договоров как сущности первого класса (2026-05-14)
-- ============================================================
-- Контекст: в договорах прописаны ЭТАПЫ работ (АГК/Массинг → ОПР → МОП → ТЭП).
-- До этой миграции этапы были «теговыми» полями в calendar_entries
-- (stage_number, stage_name), что вело к рассыпухе: 22 calendar_entries
-- у одного stage_number=1 без структуры.
--
-- Новая модель — двухпроходный пайплайн обработки договора:
--   1. extractContractStages: LLM выделяет ЭТАПЫ → contract_stages
--   2. extractClauses: каждый clause получает FK → contract_stages.id
--   3. calendar_entries.contract_stage_id := derived из clauses.stage_id
--
-- Источник истины «Текущий этап» — events типа 'contract_stage_change'.
-- documents.current_stage_id — денорм для быстрого чтения, обновляется
-- триггером AFTER INSERT ON events.
-- ============================================================

-- ─── 1) contract_stages: этапы как сущности ─────────────────────
create table contract_stages (
    id              uuid primary key default gen_random_uuid(),
    document_id     uuid not null references documents(id) on delete cascade,
    stage_number    int not null,                  -- 1, 2, 3...
    stage_name      text not null,                 -- "АГК / Массинг", "ОПР", "МОП", "ТЭП"
    description     text,                          -- что в этапе
    sort_order      int not null,
    source_page     int,
    source_quote    text,
    is_default      boolean default false,         -- первый этап договора (для init current_stage)
    created_at      timestamptz not null default now(),
    unique (document_id, stage_number)
);

create index contract_stages_document_idx on contract_stages (document_id, sort_order);

comment on table contract_stages is
    'Этапы договора как сущности первого класса. Извлекаются первым проходом LLM-парсера.';
comment on column contract_stages.stage_number is
    'Номер этапа в договоре (1, 2, 3). Уникален в рамках одного документа.';
comment on column contract_stages.is_default is
    'TRUE для первого этапа договора — используется при инициализации documents.current_stage_id.';

-- ─── 2) FK в contract_clauses ────────────────────────────────────
alter table contract_clauses
    add column stage_id uuid references contract_stages(id) on delete set null;
create index contract_clauses_stage_idx on contract_clauses (stage_id);
comment on column contract_clauses.stage_id is
    'FK на contract_stages — к какому этапу относится пункт. Заполняется проходом 2 парсера.';

-- ─── 3) FK в calendar_entries (заменяет текстовые stage_number/stage_name) ──
alter table calendar_entries
    add column contract_stage_id uuid references contract_stages(id) on delete set null;
create index calendar_entries_stage_idx on calendar_entries (contract_stage_id);
comment on column calendar_entries.contract_stage_id is
    'FK на contract_stages. Текстовые stage_number/stage_name оставлены как denorm для скорости/совместимости.';

-- ─── 4) Текущий этап договора (денорм) ───────────────────────────
alter table documents
    add column current_stage_id uuid references contract_stages(id);
create index documents_current_stage_idx on documents (current_stage_id);
comment on column documents.current_stage_id is
    'Денорм текущего этапа договора. Источник истины — события contract_stage_change. Обновляется триггером.';

-- ─── 5) Расширить event_type ─────────────────────────────────────
alter table events drop constraint if exists events_event_type_check;
alter table events add constraint events_event_type_check
    check (event_type = any (array['project_note', 'meeting', 'protocol_correction', 'contract_stage_change']));

-- ─── 6) Поля для contract_stage_change событий ───────────────────
alter table events
    add column if not exists subject_document_id uuid references documents(id) on delete cascade,
    add column if not exists from_stage_id       uuid references contract_stages(id) on delete set null,
    add column if not exists to_stage_id         uuid references contract_stages(id) on delete set null;

create index events_subject_document_idx on events (subject_document_id)
    where subject_document_id is not null;
create index events_stage_change_idx on events (to_stage_id, subject_document_id)
    where event_type = 'contract_stage_change';

comment on column events.subject_document_id is
    'Для contract_stage_change: договор, для которого меняется этап.';
comment on column events.from_stage_id is
    'Для contract_stage_change: предыдущий этап (опционально, для аудита).';
comment on column events.to_stage_id is
    'Для contract_stage_change: новый этап договора. Триггер записывает в documents.current_stage_id.';

-- ─── 7) Триггер: при добавлении события смены этапа — обновить документ ──
create or replace function trg_events_apply_stage_change() returns trigger
language plpgsql as $$
begin
    if new.event_type = 'contract_stage_change'
       and new.to_stage_id is not null
       and new.subject_document_id is not null
    then
        update documents
        set current_stage_id = new.to_stage_id
        where id = new.subject_document_id;
    end if;
    return new;
end$$;

drop trigger if exists events_apply_stage_change on events;
create trigger events_apply_stage_change
    after insert on events
    for each row execute function trg_events_apply_stage_change();

-- ─── 8) Init helper: установка current_stage_id на первый этап ───
-- Когда парсер создаёт contract_stages, должен:
--   1. Вставить все stages
--   2. Пометить первый (sort_order=min) как is_default=true
--   3. Если у documents.current_stage_id is null — выставить на этот первый
-- Делается на уровне приложения, не триггером — потому что парсер может
-- создавать этапы пачкой и нам нужен предсказуемый порядок.

-- ─── 9) View: contract_stages_with_progress (для отчётов и UI) ───
-- Подсчёт сколько clauses в этапе, сколько имеют дату, сколько завершены (если есть).
create or replace view contract_stages_with_progress as
select
    cs.id,
    cs.document_id,
    cs.stage_number,
    cs.stage_name,
    cs.description,
    cs.sort_order,
    cs.is_default,
    (select count(*) from contract_clauses cc where cc.stage_id = cs.id) as clauses_count,
    (select count(*) from contract_clauses cc where cc.stage_id = cs.id and cc.clause_date is not null) as clauses_with_date,
    (cs.id = (select current_stage_id from documents d where d.id = cs.document_id)) as is_current
from contract_stages cs;

notify pgrst, 'reload schema';
