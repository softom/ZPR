-- 20260613000001_mspdi_passthrough.sql
-- Round-trip MSPDI: хранение полного упорядоченного набора неперезаписываемых
-- (passthrough) полей <Task> для восстановления при экспорте. Без этого MS Project
-- достраивает Work/Type/EarlyStart/ConstraintType по-своему и ломает отображение
-- (задачи 0 дней, вехи 1 день).

ALTER TABLE calendar_entries
  ADD COLUMN IF NOT EXISTS mspdi_passthrough jsonb;

COMMENT ON COLUMN calendar_entries.mspdi_passthrough IS
  'Упорядоченный массив прочих (не-owned) полей <Task> из MSPDI: [{"tag","value"} | {"tag","children":[...]}]. '
  'Заполняется только для задач, импортированных из XML (mspdi_uid NOT NULL). '
  'NULL = задача создана в Web UI → сериализатор генерирует поля из шаблона по умолчанию. '
  'Owned-поля (UID,ID,Name,OutlineLevel,OutlineNumber,WBS,Summary,Milestone,Manual,Start,Finish,'
  'Duration,ManualStart,ManualFinish,ManualDuration,ConstraintType,ConstraintDate,PercentComplete,'
  'Notes,ExtendedAttribute(значения),PredecessorLink) здесь НЕ хранятся — их пишет ЗПР из реляционных колонок.';

-- Опционально: GIN-индекс не нужен (passthrough не фильтруется запросами, читается по PK строки).

-- Для UI-задач без оригинала полезно хранить факт «нужен шаблон»:
-- ничего не добавляем — признак = (mspdi_passthrough IS NULL).
