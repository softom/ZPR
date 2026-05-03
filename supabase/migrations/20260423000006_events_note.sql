-- Примечание к событию (выписка из договора или свободный текст)
ALTER TABLE events ADD COLUMN IF NOT EXISTS note text;
COMMENT ON COLUMN events.note IS 'Примечание к событию: выписка из договора или свободный текст';
