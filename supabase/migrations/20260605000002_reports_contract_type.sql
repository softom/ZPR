-- ============================================================
-- Новый тип отчёта: 'contract' — Отчёт по договору ТЗ (услуги ИП)
-- ============================================================
-- Отчёт о проделанной работе Исполнителя (ИП) перед Заказчиком по договору
-- технического заказчика. Проектного уровня (НЕ по объектам): тело документа
-- (markdown) хранится в reports.summary_md, секций object_reports не создаётся.
-- Приложением подшивается выбранный месячный отчёт ЗПР → reports.appendix_report_id.
--
-- Привязка к месяцу (period_start = 1-е число месяца, как 'month').
-- ============================================================

alter table reports drop constraint if exists reports_period_type_check;
alter table reports add constraint reports_period_type_check
    check (period_type in ('week','month','control','short','contract'));

-- Ссылка на отчёт-Приложение (месячный отчёт ЗПР). on delete set null —
-- если приложение удалят, отчёт по договору остаётся, просто без приложения.
alter table reports
    add column if not exists appendix_report_id uuid references reports(id) on delete set null;
