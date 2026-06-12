-- ============================================================
-- Новый тип отчёта: 'short' — Короткая справка
-- ============================================================
-- Назначение: перечислить, какие ВАРИАНТЫ заказчик УТВЕРДИЛ в дальнейшую
-- работу. Источник — события + протоколы (meeting_topics status='approved').
-- Парадигма — снимок на дату (как 'control'), накопительно: все варианты,
-- утверждённые ДО даты справки. Разрез — по объектам.
--
-- Поля object_reports переиспользуются (без новых колонок), т.к. тип отчёта
-- взаимоисключающий с week/month/control:
--   narrative  — короткое вступление (1 абзац)
--   decisions  — список утверждённых вариантов (Markdown)
--
-- Уникальность (period_type, period_start) для short НЕ требуется — partial
-- unique index reports_period_unique_week_month покрывает только week/month,
-- поэтому несколько коротких справок на одну дату допустимы (как у control).
-- ============================================================

alter table reports drop constraint if exists reports_period_type_check;
alter table reports add constraint reports_period_type_check
    check (period_type in ('week','month','control','short'));
