-- ============================================================
-- Классификатор событий договора (2026-05-18)
-- ============================================================
-- Назначение:
--   Единый справочник типов событий внутри договора («оплата», «аванс»,
--   «подписание акта», «форс-мажор» и т.п.). Заменяет неявный набор значений
--   contract_clauses.category (fin/work/appr/legal) на нормализованную таблицу.
--
-- Правило связей: FK по UUID. text-код `code` — только UNIQUE для seed/LLM,
-- НЕ участвует как FK. Все межсущностные ссылки на этот справочник идут через
-- contract_event_types.id (uuid).
--
-- 7 категорий (расширение текущих 4): fin, work, term, legal, appr, comm, ctrl.
-- ============================================================

create table contract_event_types (
    id              uuid primary key default gen_random_uuid(),
    code            text not null unique,           -- человеческий идентификатор для seed/LLM/импорта
    category        text not null
        check (category in ('fin','work','term','legal','appr','comm','ctrl')),
    label           text not null,
    icon            text,
    sort_order      int not null default 100,
    is_intermediate boolean not null default false,  -- промежуточная веха (для UI-фильтра)
    is_anchor       boolean not null default false,  -- якорный тип (Заключение договора)
    description     text,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now()
);

create index contract_event_types_category_idx on contract_event_types (category);
create index contract_event_types_active_idx   on contract_event_types (is_active);

comment on table contract_event_types is
    'Классификатор событий договора. FK — по id (uuid). code = человеческий ключ для seed/LLM/import.';
comment on column contract_event_types.category is
    '7 категорий: fin (финансовые), work (производственные), term (сроковые), legal (юридические), appr (согласовательные), comm (коммуникационные), ctrl (контрольные/приёмочные).';

-- ─── Seed: 31 тип ─────────────────────────────────────────────────
insert into contract_event_types (code, category, label, icon, sort_order, is_intermediate, is_anchor) values
    -- Юридические
    ('legal_contract_sign',  'legal', 'Заключение договора',        '📋', 100, false, true),
    ('legal_amendment',      'legal', 'Изменения (ДС)',              '📑', 110, false, false),
    ('legal_termination',    'legal', 'Расторжение',                 '❌', 120, false, false),
    ('legal_claim',          'legal', 'Претензия',                   '⚖️', 130, false, false),
    ('legal_force_majeure',  'legal', 'Форс-мажор',                  '⛈️', 140, false, false),

    -- Производственные
    ('work_start',           'work',  'Начало работ',                '▶️', 200, false, false),
    ('work_stage',           'work',  'Этап работ',                  '🔨', 210, false, false),
    ('work_input_handover',  'work',  'Передача исходных данных',    '📥', 220, false, false),
    ('work_result_delivery', 'work',  'Сдача результата',            '📤', 230, false, false),

    -- Финансовые
    ('fin_payment',          'fin',   'Оплата',                      '💵', 300, false, false),
    ('fin_advance',          'fin',   'Аванс',                       '💰', 310, false, false),
    ('fin_withholding',      'fin',   'Удержания',                   '🔒', 320, false, false),
    ('fin_penalty',          'fin',   'Штрафы',                      '⚠️', 330, false, false),
    ('fin_price_change',     'fin',   'Изменение цены',              '💱', 340, false, false),

    -- Сроковые
    ('term_deadline',        'term',  'Дедлайн',                     '📅', 400, false, false),
    ('term_shift',           'term',  'Перенос срока',               '↔️', 410, false, false),
    ('term_suspension',      'term',  'Приостановка',                '⏸️', 420, false, false),
    ('term_overdue',         'term',  'Просрочка',                   '🔴', 430, false, false),

    -- Согласовательные
    ('appr_decision',        'appr',  'Согласование решений',        '✋', 500, false, false),
    ('appr_remarks',         'appr',  'Замечания',                   '✏️', 510, false, false),
    ('appr_approval',        'appr',  'Утверждение документации',    '✅', 520, false, false),
    ('appr_rejection',       'appr',  'Отказ в согласовании',        '⛔', 530, false, false),

    -- Контрольные / приёмочные
    ('ctrl_review',          'ctrl',  'Проверка результата',         '🔍', 600, true,  false),
    ('ctrl_stage_acceptance','ctrl',  'Приёмка этапа',               '🏁', 610, false, false),
    ('ctrl_act_signing',     'ctrl',  'Подписание акта',             '📝', 620, false, false),
    ('ctrl_defects',         'ctrl',  'Выявление недостатков',       '🐛', 630, false, false),

    -- Коммуникационные
    ('comm_notification',    'comm',  'Уведомление',                 '📬', 700, false, false),
    ('comm_request',         'comm',  'Запрос',                      '❓', 710, false, false),
    ('comm_response',        'comm',  'Ответ',                       '💬', 720, false, false),
    ('comm_assignment',      'comm',  'Назначение ответственного',   '👤', 730, false, false),
    ('comm_meeting',         'comm',  'Совещание',                   '🤝', 740, false, false);

-- ─── RLS ──────────────────────────────────────────────────────────
alter table contract_event_types enable row level security;
create policy "cet_select" on contract_event_types for select using (true);
create policy "cet_insert" on contract_event_types for insert
    with check (user_role() in ('admin','service_role'));
create policy "cet_update" on contract_event_types for update
    using (user_role() in ('admin','service_role'));
create policy "cet_delete" on contract_event_types for delete
    using (user_role() in ('admin','service_role'));

notify pgrst, 'reload schema';
