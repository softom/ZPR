-- Время последнего РУЧНОГО изменения диапазона отчёта (period_start / period_end).
-- Ставится в PATCH /api/reports/[id] при смене дат. Используется, чтобы пометить
-- секции, чьи LLM-тексты сгенерированы ДО смены периода (generated_at < period_changed_at)
-- → они могли устареть и требуют перегенерации. См. WIKI 21_Сущность_Отчёт и 39_Регламент_деплоя.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS period_changed_at timestamptz;

COMMENT ON COLUMN reports.period_changed_at IS
  'Время последнего ручного изменения period_start/period_end. Секции с generated_at < этого значения помечаются как «текст мог устареть».';
