-- ====================================================================
-- Расширяемый справочник типов событий
-- ====================================================================

create table if not exists event_subtypes (
    code        text primary key,
    category    text not null check (category in ('fin','work','appr','exec','system')),
    label       text not null,
    icon        text not null default '◆',
    sort_order  int  not null default 0,
    created_at  timestamptz not null default now()
);

comment on table event_subtypes
  is 'Расширяемый справочник типов событий — добавлять строки по мере работы';

alter table event_subtypes enable row level security;
drop policy if exists es_select on event_subtypes;
drop policy if exists es_insert on event_subtypes;
drop policy if exists es_update on event_subtypes;

create policy es_select on event_subtypes for select using (true);
create policy es_insert on event_subtypes for insert
  with check (public.user_role() in ('uploader','admin','service_role'));
create policy es_update on event_subtypes for update
  using (public.user_role() in ('uploader','admin','service_role'));

-- ─── Seed ────────────────────────────────────────────────────────────────────

insert into event_subtypes (code, category, label, icon, sort_order) values
  -- fin
  ('fin_advance',        'fin',    'Аванс',                   '💰', 10),
  ('fin_interim',        'fin',    'Промежуточный платёж',    '💸', 20),
  ('fin_final',          'fin',    'Окончательный расчёт',    '✅', 30),
  -- work
  ('work_start',         'work',   'Начало работ',            '▶',  10),
  ('work_end',           'work',   'Завершение работ',        '⬛', 20),
  ('work_stage',         'work',   'Этап работ',              '◆',  30),
  ('work_event',         'work',   'Рабочее событие',         '◇',  40),
  -- appr
  ('appr_submission',    'appr',   'Сдача на согласование',   '📤', 10),
  ('appr_review',        'appr',   'Проверка',                '🔍', 20),
  ('appr_sign',          'appr',   'Подписание',              '📝', 30),
  -- exec
  ('exec_report',        'exec',   'Отчёт подрядчика',        '📊', 10),
  ('exec_issue',         'exec',   'Проблема / замечание',    '⚠️', 20),
  ('exec_start',         'exec',   'Начало исполнения',       '🟢', 30),
  ('exec_end',           'exec',   'Завершение исполнения',   '🏁', 40),
  ('exec_work',          'exec',   'Ход работ',               '🔨', 50),
  -- system
  ('contract_signed',    'system', 'Договор подписан',        '📋', 10),
  ('contract_loaded',    'system', 'Договор загружен в БД',   '📂', 20),
  ('meeting',            'system', 'Совещание',               '🤝', 30),
  ('protocol_published', 'system', 'Протокол опубликован',    '📄', 40)
on conflict (code) do nothing;

notify pgrst, 'reload schema';
