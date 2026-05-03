-- Срок исполнения и признак ручного ввода для событий
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS exec_days  smallint,
  ADD COLUMN IF NOT EXISTS exec_type  text DEFAULT 'calendar'
    CHECK (exec_type IN ('working', 'calendar')),
  ADD COLUMN IF NOT EXISTS is_manual  boolean NOT NULL DEFAULT false;

ALTER TABLE event_date_editions
  ADD COLUMN IF NOT EXISTS exec_days  smallint,
  ADD COLUMN IF NOT EXISTS exec_type  text DEFAULT 'calendar'
    CHECK (exec_type IN ('working', 'calendar')),
  ADD COLUMN IF NOT EXISTS is_manual  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN events.exec_days IS 'Срок исполнения (к.д. или р.д.)';
COMMENT ON COLUMN events.exec_type IS 'Тип дней: calendar или working';
COMMENT ON COLUMN events.is_manual IS 'true = дата установлена вручную; false = вычислено по формуле';

COMMENT ON COLUMN event_date_editions.exec_days IS 'Срок исполнения (к.д. или р.д.)';
COMMENT ON COLUMN event_date_editions.exec_type IS 'Тип дней: calendar или working';
COMMENT ON COLUMN event_date_editions.is_manual IS 'true = дата установлена вручную; false = вычислено по формуле';
