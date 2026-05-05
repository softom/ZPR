-- Флаг: включать ли финансовые события и связанные с ними риски/задачи в отчёт.
-- По умолчанию — false (финансы не показываются). Для финансовых отчётов
-- руководству пользователь явно включает галочку.

alter table reports add column if not exists include_financials boolean not null default false;

comment on column reports.include_financials is
    'Включать ли финансовые события (платежи, бюджеты, контракты в части денег) в LLM-генерацию. По умолчанию false.';

notify pgrst, 'reload schema';
