-- ============================================================================
-- events.importance — шкала важности событий
-- ============================================================================
-- 4 уровня:
--   low      — низкая (технические записи, авто-импорт)
--   normal   — обычная (по умолчанию)
--   high     — важная (попадает в quick-отчёты)
--   critical — критическая (топ-секция отчёта, выделяется красным)
--
-- Зачем: формирование быстрых отчётов «важные события за период»
-- через простой фильтр events.importance IN ('high','critical').
-- ============================================================================

alter table events
    add column importance text not null default 'normal'
        check (importance in ('low','normal','high','critical'));

-- Partial index — только важные (для отчётов; малая доля от всех событий)
create index events_importance_high_idx
    on events (importance, date_computed desc)
    where importance in ('high','critical');

comment on column events.importance is
    'Шкала важности события (low/normal/high/critical). По умолчанию normal. '
    'Используется для быстрых отчётов и визуальной выделки в UI. '
    'Partial-индекс events_importance_high_idx ускоряет фильтры «топ-важное».';

notify pgrst, 'reload schema';
