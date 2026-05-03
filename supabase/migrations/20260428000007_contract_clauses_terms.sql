-- ====================================================================
-- contract_clauses: относительный срок исполнения пункта
-- ====================================================================
-- Многие пункты договоров имеют не абсолютную дату, а формулу:
--   «15 рабочих дней с даты подписания», «через 5 дней после аванса».
-- Нужно сохранить эту структуру в ПУНКТЕ, иначе при переходе
-- ПУНКТ → СОБЫТИЕ (модуль C) формула будет потеряна.
--
-- Поведение:
--   1. clause_date — абсолютная дата (если LLM смог найти).
--   2. term_days + term_type + term_base — относительный срок.
--   3. Можно заполнить одно или другое (или оба).
--   4. term_text — оригинальная формулировка из текста договора (для аудита и ручной правки).
--
-- При формировании СОБЫТИЯ из ПУНКТА (модуль C):
--   - есть term_*  → событие в режиме relative с date_ref_event_id по term_base
--   - есть только clause_date → событие в absolute режиме с date_end = clause_date

alter table contract_clauses
  add column if not exists term_days smallint,
  add column if not exists term_type text
       check (term_type in ('working','calendar')),
  add column if not exists term_base text
       check (term_base in (
         'contract',     -- от даты подписания договора
         'advance',      -- от даты получения аванса
         'start',        -- от даты начала работ
         'end',          -- от даты завершения базовой вехи (предыдущая «end»)
         'prev',         -- от даты предыдущего ПУНКТА в договоре (по order_index)
         'submission',   -- от даты сдачи документации Заказчику
         'review',       -- от даты получения замечаний от Заказчика
         'act',          -- от даты подписания акта
         'custom'        -- иное — см. term_text
       )),
  add column if not exists term_text text;

create index if not exists contract_clauses_term_base_idx
  on contract_clauses (term_base) where term_base is not null;

comment on column contract_clauses.term_days
  is 'Количество дней относительного срока. Например 15 в формуле «15 рабочих дней с даты подписания»';
comment on column contract_clauses.term_type
  is 'Тип дней: working (рабочие, пн–пт) | calendar (календарные)';
comment on column contract_clauses.term_base
  is 'База отсчёта: contract | advance | start | end | prev | submission | review | act | custom';
comment on column contract_clauses.term_text
  is 'Оригинальная формулировка срока из текста договора, например «15 (Пятнадцать) рабочих дней с даты подписания настоящего Договора»';

notify pgrst, 'reload schema';
