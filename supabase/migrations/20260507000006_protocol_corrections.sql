-- ============================================================
-- Правки утверждённых тем/задач по замечанию организации
-- ============================================================
-- После approve протокол идёт в read-only. Реальный кейс — одна из
-- организаций возвращается с уточнением формулировки. Разрешаем правки
-- утверждённых meeting_topics/tasks с трассой «когда / кто / откуда / что было»
-- и созданием события events.event_type='protocol_correction'.
--
-- См. WIKI 19_Сущность_Задача → раздел «История миграций» (v2.2).

-- ─── Колонки правки на meeting_topics и tasks ─────────────────
alter table meeting_topics
  add column corrected_at timestamptz,
  add column corrected_by_entity_id uuid references legal_entities(id),
  add column correction_source text,
  add column correction_note text,
  add column revisions jsonb not null default '[]';

alter table tasks
  add column corrected_at timestamptz,
  add column corrected_by_entity_id uuid references legal_entities(id),
  add column correction_source text,
  add column correction_note text,
  add column revisions jsonb not null default '[]';

comment on column meeting_topics.corrected_at is
  'Время последней правки по замечанию организации (NULL = не правилось)';
comment on column meeting_topics.corrected_by_entity_id is
  'Юр.лицо, по чьему замечанию внесена правка (FK → legal_entities.id)';
comment on column meeting_topics.correction_source is
  'Канал получения замечания: Telegram, Email, Письмо, Устно, …';
comment on column meeting_topics.correction_note is
  'Свободный комментарий к последней правке';
comment on column meeting_topics.revisions is
  'История правок: jsonb-массив [{at, by_entity_id, by_org_name, source, note, before, after}]. before/after — только изменённые поля.';

comment on column tasks.corrected_at is
  'Время последней правки по замечанию организации';
comment on column tasks.corrected_by_entity_id is
  'Юр.лицо, по чьему замечанию внесена правка';
comment on column tasks.correction_source is
  'Канал получения замечания: Telegram, Email, Письмо, Устно, …';
comment on column tasks.correction_note is
  'Свободный комментарий к последней правке';
comment on column tasks.revisions is
  'История правок: jsonb-массив снимков «было/стало» по изменённым полям';

-- ─── entity_links: разрешить связь от/к meeting_topic ─────────
alter table entity_links drop constraint entity_links_from_type_check;
alter table entity_links add constraint entity_links_from_type_check
  check (from_type = ANY (ARRAY[
    'event','document','letter','object','milestone','contractor',
    'meeting','task','legal_entity','contact','meeting_topic'
  ]));

alter table entity_links drop constraint entity_links_to_type_check;
alter table entity_links add constraint entity_links_to_type_check
  check (to_type = ANY (ARRAY[
    'event','document','letter','object','milestone','contractor',
    'meeting','task','legal_entity','contact','meeting_topic'
  ]));

-- ─── SQL-функция: применить пакет правок одной транзакцией ───
create or replace function apply_correction_batch(p_payload jsonb)
returns uuid
language plpgsql as $$
declare
    v_meeting_id uuid := (p_payload->>'meeting_id')::uuid;
    v_by_entity_id uuid := nullif(p_payload->>'corrected_by_entity_id','')::uuid;
    v_source text := p_payload->>'correction_source';
    v_note text := p_payload->>'correction_note';
    v_meeting record;
    v_by_org_name text;
    v_now timestamptz := now();
    v_item jsonb;
    v_target_id uuid;
    v_kind text;
    v_fields jsonb;
    v_topic record;
    v_task record;
    v_before jsonb;
    v_after jsonb;
    v_revision jsonb;
    v_event_id uuid;
    v_object_ids uuid[] := '{}'::uuid[];
    v_object_ids_dedup uuid[];
    v_affected_topic_ids uuid[] := '{}'::uuid[];
    v_affected_task_ids uuid[] := '{}'::uuid[];
    v_event_title text;
    v_event_note text;
    v_n_topics int := 0;
    v_n_tasks int := 0;
begin
    select * into v_meeting from meetings where id = v_meeting_id;
    if not found then
        raise exception 'Meeting not found: %', v_meeting_id;
    end if;

    if v_by_entity_id is not null then
        select name into v_by_org_name from legal_entities where id = v_by_entity_id;
    end if;

    -- Применяем каждый item
    for v_item in select * from jsonb_array_elements(p_payload->'items')
    loop
        v_kind := v_item->>'kind';
        v_target_id := (v_item->>'target_id')::uuid;
        v_fields := v_item->'fields';

        if v_kind = 'topic' then
            select * into v_topic from meeting_topics where id = v_target_id;
            if not found then
                raise exception 'Topic not found: %', v_target_id;
            end if;
            v_before := jsonb_build_object();
            v_after := jsonb_build_object();
            if v_fields ? 'title' and v_fields->>'title' is distinct from v_topic.title then
                v_before := v_before || jsonb_build_object('title', v_topic.title);
                v_after  := v_after  || jsonb_build_object('title', v_fields->>'title');
            end if;
            if v_fields ? 'content' and v_fields->>'content' is distinct from v_topic.content then
                v_before := v_before || jsonb_build_object('content', v_topic.content);
                v_after  := v_after  || jsonb_build_object('content', v_fields->>'content');
            end if;
            if v_fields ? 'raised_by_org' and v_fields->>'raised_by_org' is distinct from v_topic.raised_by_org then
                v_before := v_before || jsonb_build_object('raised_by_org', v_topic.raised_by_org);
                v_after  := v_after  || jsonb_build_object('raised_by_org', v_fields->>'raised_by_org');
            end if;
            -- Если ничего не изменилось — пропускаем
            if v_before = '{}'::jsonb then continue; end if;

            v_revision := jsonb_build_object(
                'at', v_now, 'by_entity_id', v_by_entity_id, 'by_org_name', v_by_org_name,
                'source', v_source, 'note', v_note,
                'before', v_before, 'after', v_after
            );

            update meeting_topics set
                title = coalesce(v_fields->>'title', title),
                content = coalesce(v_fields->>'content', content),
                raised_by_org = coalesce(v_fields->>'raised_by_org', raised_by_org),
                corrected_at = v_now,
                corrected_by_entity_id = v_by_entity_id,
                correction_source = v_source,
                correction_note = v_note,
                revisions = revisions || v_revision
            where id = v_target_id;

            v_affected_topic_ids := v_affected_topic_ids || v_target_id;
            v_object_ids := v_object_ids || v_topic.object_ids;
            v_n_topics := v_n_topics + 1;

        elsif v_kind = 'task' then
            select * into v_task from tasks where id = v_target_id;
            if not found then
                raise exception 'Task not found: %', v_target_id;
            end if;
            v_before := jsonb_build_object();
            v_after := jsonb_build_object();
            if v_fields ? 'title' and v_fields->>'title' is distinct from v_task.title then
                v_before := v_before || jsonb_build_object('title', v_task.title);
                v_after  := v_after  || jsonb_build_object('title', v_fields->>'title');
            end if;
            if v_fields ? 'explanation' and v_fields->>'explanation' is distinct from coalesce(v_task.explanation,'') then
                v_before := v_before || jsonb_build_object('explanation', v_task.explanation);
                v_after  := v_after  || jsonb_build_object('explanation', v_fields->>'explanation');
            end if;
            if v_fields ? 'assignee_org' and v_fields->>'assignee_org' is distinct from v_task.assignee_org then
                v_before := v_before || jsonb_build_object('assignee_org', v_task.assignee_org);
                v_after  := v_after  || jsonb_build_object('assignee_org', v_fields->>'assignee_org');
            end if;
            if v_fields ? 'due_date' and (nullif(v_fields->>'due_date','')::date) is distinct from v_task.due_date then
                v_before := v_before || jsonb_build_object('due_date', v_task.due_date);
                v_after  := v_after  || jsonb_build_object('due_date', v_fields->>'due_date');
            end if;
            if v_before = '{}'::jsonb then continue; end if;

            v_revision := jsonb_build_object(
                'at', v_now, 'by_entity_id', v_by_entity_id, 'by_org_name', v_by_org_name,
                'source', v_source, 'note', v_note,
                'before', v_before, 'after', v_after
            );

            update tasks set
                title = coalesce(v_fields->>'title', title),
                explanation = coalesce(v_fields->>'explanation', explanation),
                assignee_org = coalesce(v_fields->>'assignee_org', assignee_org),
                due_date = case
                    when v_fields ? 'due_date'
                    then nullif(v_fields->>'due_date','')::date
                    else due_date
                end,
                corrected_at = v_now,
                corrected_by_entity_id = v_by_entity_id,
                correction_source = v_source,
                correction_note = v_note,
                revisions = revisions || v_revision
            where id = v_target_id;

            v_affected_task_ids := v_affected_task_ids || v_target_id;
            v_object_ids := v_object_ids || v_task.object_ids;
            v_n_tasks := v_n_tasks + 1;
        else
            raise exception 'Unknown correction item kind: %', v_kind;
        end if;
    end loop;

    if v_n_topics + v_n_tasks = 0 then
        raise exception 'Нет применённых правок (все поля совпали с текущими значениями)';
    end if;

    -- Дедуп объектов
    select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_object_ids_dedup
      from unnest(v_object_ids) x where x is not null;

    -- ─── Создаём событие ─────────────────────────────────
    v_event_title := 'Правки протокола ' ||
        coalesce(v_meeting.code, to_char(v_meeting.meeting_date, 'DD.MM.YYYY')) ||
        case when v_by_org_name is not null then ' (от ' || v_by_org_name || ')' else '' end;

    v_event_note := coalesce(v_note, '') ||
        case when v_source is not null and v_source <> '' then E'\n\nИсточник: ' || v_source else '' end ||
        E'\n\nЗатронуто: ' || v_n_topics || ' тем / ' || v_n_tasks || ' задач';

    insert into events (event_type, title, note, is_planned, fact_date, object_ids, is_manual)
    values ('protocol_correction', v_event_title, v_event_note, false, current_date,
            v_object_ids_dedup, true)
    returning id into v_event_id;

    -- ─── entity_links для события ────────────────────────
    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    values ('event', v_event_id::text, 'meeting', v_meeting_id::text, 'references')
    on conflict do nothing;

    if v_by_entity_id is not null then
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('event', v_event_id::text, 'legal_entity', v_by_entity_id::text, 'belongs_to')
        on conflict do nothing;
    end if;

    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    select 'event', v_event_id::text, 'meeting_topic', tid::text, 'references'
      from unnest(v_affected_topic_ids) tid
    on conflict do nothing;

    insert into entity_links (from_type, from_id, to_type, to_id, link_type)
    select 'event', v_event_id::text, 'task', tid::text, 'references'
      from unnest(v_affected_task_ids) tid
    on conflict do nothing;

    return v_event_id;
end$$;

comment on function apply_correction_batch(jsonb) is
    'Атомарно применяет пакет правок к темам/задачам утверждённого собрания: UPDATE + revisions append + events INSERT (event_type=protocol_correction) + entity_links (event→meeting/legal_entity/topic/task).';

notify pgrst, 'reload schema';
