-- ============================================================
-- meeting_topics + meetings: связь с объектами по UUID
-- ============================================================
-- Доводим до конца переход с object_codes (text) на object_ids (uuid),
-- начатый в 20260504000001_tasks_object_ids.sql. См. WIKI 09_Правило_связей.

-- ─── meeting_topics.object_ids ──────────────────────────────────────────
alter table meeting_topics
  add column if not exists object_ids uuid[] not null default '{}';

create index if not exists meeting_topics_object_ids_idx
  on meeting_topics using gin (object_ids);

update meeting_topics t
set object_ids = (
  select coalesce(array_agg(o.id) filter (where o.id is not null), '{}'::uuid[])
  from unnest(t.object_codes) as oc
  left join objects o on o.code = oc or o.aliases ? oc
)
where object_ids = '{}'::uuid[] and array_length(object_codes, 1) > 0;

comment on column meeting_topics.object_ids is 'UUID объектов из objects.id. Источник истины для связи topic→object';
comment on column meeting_topics.object_codes is 'DEPRECATED — используй object_ids';

-- ─── meetings.object_ids ────────────────────────────────────────────────
alter table meetings
  add column if not exists object_ids uuid[] not null default '{}';

create index if not exists meetings_object_ids_idx
  on meetings using gin (object_ids);

update meetings m
set object_ids = (
  select coalesce(array_agg(o.id) filter (where o.id is not null), '{}'::uuid[])
  from unnest(m.object_codes) as oc
  left join objects o on o.code = oc or o.aliases ? oc
)
where object_ids = '{}'::uuid[] and array_length(object_codes, 1) > 0;

comment on column meetings.object_ids is 'UUID объектов из objects.id, обсуждаемых на собрании. Источник истины для связи meeting→object';
comment on column meetings.object_codes is 'DEPRECATED — используй object_ids';

-- ─── Backfill tasks с пустым object_ids ────────────────────────────────
-- Задачи, созданные через /api/protocols/[id]/process до этого hotfix'а,
-- имеют object_codes от LLM, но object_ids пустые. Резолвим.
update tasks t
set object_ids = (
  select coalesce(array_agg(o.id) filter (where o.id is not null), '{}'::uuid[])
  from unnest(t.object_codes) as oc
  left join objects o on o.code = oc or o.aliases ? oc
)
where object_ids = '{}'::uuid[] and array_length(object_codes, 1) > 0;

notify pgrst, 'reload schema';
