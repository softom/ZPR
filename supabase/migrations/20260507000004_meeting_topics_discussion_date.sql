-- ============================================================
-- meeting_topics.discussion_date — собственная дата обсуждения темы
-- ============================================================
-- По умолчанию равна meeting.meeting_date, но при ревью пользователь может
-- сдвинуть её отдельно (например, тема поднималась раньше или позже самого
-- собрания, или собрание перетекало через полночь).

alter table meeting_topics
  add column if not exists discussion_date date null;

comment on column meeting_topics.discussion_date is
  'Дата обсуждения темы. По умолчанию = meeting.meeting_date, может быть сдвинута пользователем при ревью.';

-- Backfill для существующих записей
update meeting_topics t
set discussion_date = m.meeting_date
from meetings m
where t.meeting_id = m.id and t.discussion_date is null;

notify pgrst, 'reload schema';
