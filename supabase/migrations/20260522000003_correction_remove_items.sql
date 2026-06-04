-- ============================================================
-- apply_correction_batch: kind='remove_topic' / 'remove_task'
-- ============================================================
-- Логическое удаление утверждённого пункта в режиме «правки по замечанию»:
--   meeting_topics: status='approved' → 'removed'
--   tasks:          status='open'/'in_progress'/'done'/'closed' → 'cancelled'
-- Запись остаётся в БД (audit-trail), revisions расширяется снимком
-- {action:'removed_by_correction'}. WORD-протокол фильтрует cancelled/removed
-- автоматически (см. lib/protocol/generateDocx.ts).
--
-- См. WIKI 10_Алгоритм_собрания.md → запись 22.05.2026 (продолжение).

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
    v_n_topics_added int := 0;
    v_n_tasks_added int := 0;
    v_n_topics_removed int := 0;
    v_n_tasks_removed int := 0;
    v_meeting_code text;
    v_new_id uuid;
    v_new_code text;
    v_new_seq int;
    v_object_ids_new uuid[];
begin
    select * into v_meeting from meetings where id = v_meeting_id;
    if not found then
        raise exception 'Meeting not found: %', v_meeting_id;
    end if;

    v_meeting_code := coalesce(v_meeting.code, 'ПРОТ-' || to_char(v_meeting.meeting_date, 'YYYY-MM-DD'));

    if v_by_entity_id is not null then
        select name into v_by_org_name from legal_entities where id = v_by_entity_id;
    end if;

    for v_item in select * from jsonb_array_elements(p_payload->'items')
    loop
        v_kind := v_item->>'kind';
        v_fields := v_item->'fields';

        -- ─── UPDATE темы ──────────────────────────────────
        if v_kind = 'topic' then
            v_target_id := (v_item->>'target_id')::uuid;
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

        -- ─── UPDATE задачи ────────────────────────────────
        elsif v_kind = 'task' then
            v_target_id := (v_item->>'target_id')::uuid;
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

        -- ─── INSERT новой задачи ──────────────────────────
        elsif v_kind = 'add_task' then
            if coalesce(v_fields->>'title','') = '' then
                raise exception 'add_task: title обязателен';
            end if;

            v_object_ids_new := coalesce(
                (select array_agg((x)::uuid)
                   from jsonb_array_elements_text(coalesce(v_fields->'object_ids','[]'::jsonb)) x),
                '{}'::uuid[]
            );

            select coalesce(max(
                (regexp_match(t.code, '-ЗАД-(\d+)$'))[1]::int
            ), 0) + 1
              into v_new_seq
              from tasks t
             where t.code like (v_meeting_code || '-ЗАД-%');

            v_new_code := v_meeting_code || '-ЗАД-' || lpad(v_new_seq::text, 2, '0');

            v_revision := jsonb_build_object(
                'at', v_now,
                'by_entity_id', v_by_entity_id,
                'by_org_name', v_by_org_name,
                'source', v_source,
                'note', v_note,
                'action', 'created_by_correction',
                'after', jsonb_build_object(
                    'title', v_fields->>'title',
                    'explanation', v_fields->>'explanation',
                    'assignee_org', v_fields->>'assignee_org',
                    'due_date', v_fields->>'due_date',
                    'priority', coalesce(v_fields->>'priority','medium'),
                    'object_ids', coalesce(v_fields->'object_ids','[]'::jsonb),
                    'quotes', coalesce(v_fields->'quotes','[]'::jsonb)
                )
            );

            insert into tasks (
                code, meeting_id, title, explanation,
                assignee_org, due_date, priority,
                object_ids, quotes, status,
                source_protocol, source_meeting_date, source_meeting_path,
                tags,
                corrected_at, corrected_by_entity_id,
                correction_source, correction_note,
                revisions
            ) values (
                v_new_code, v_meeting_id,
                v_fields->>'title',
                coalesce(v_fields->>'explanation',''),
                v_fields->>'assignee_org',
                nullif(v_fields->>'due_date','')::date,
                coalesce(v_fields->>'priority','medium'),
                v_object_ids_new,
                coalesce(v_fields->'quotes','[]'::jsonb),
                'open',
                v_meeting_code,
                v_meeting.meeting_date,
                v_meeting.folder_path,
                array['protocol','correction']::text[],
                v_now, v_by_entity_id,
                v_source, v_note,
                jsonb_build_array(v_revision)
            )
            returning id into v_new_id;

            v_affected_task_ids := v_affected_task_ids || v_new_id;
            v_object_ids := v_object_ids || v_object_ids_new;
            v_n_tasks_added := v_n_tasks_added + 1;

        -- ─── INSERT новой темы ────────────────────────────
        elsif v_kind = 'add_topic' then
            if coalesce(v_fields->>'title','') = '' then
                raise exception 'add_topic: title обязателен';
            end if;

            v_object_ids_new := coalesce(
                (select array_agg((x)::uuid)
                   from jsonb_array_elements_text(coalesce(v_fields->'object_ids','[]'::jsonb)) x),
                '{}'::uuid[]
            );

            select coalesce(max(seq), 0) + 1 into v_new_seq
              from meeting_topics
             where meeting_id = v_meeting_id;

            v_new_code := v_meeting_code || '-ОБС-' || lpad(v_new_seq::text, 2, '0');

            v_revision := jsonb_build_object(
                'at', v_now,
                'by_entity_id', v_by_entity_id,
                'by_org_name', v_by_org_name,
                'source', v_source,
                'note', v_note,
                'action', 'created_by_correction',
                'after', jsonb_build_object(
                    'title', v_fields->>'title',
                    'content', v_fields->>'content',
                    'raised_by_org', v_fields->>'raised_by_org',
                    'object_ids', coalesce(v_fields->'object_ids','[]'::jsonb),
                    'quotes', coalesce(v_fields->'quotes','[]'::jsonb)
                )
            );

            insert into meeting_topics (
                meeting_id, code, seq,
                title, content, raised_by_org,
                object_ids, quotes, status,
                corrected_at, corrected_by_entity_id,
                correction_source, correction_note,
                revisions
            ) values (
                v_meeting_id, v_new_code, v_new_seq,
                v_fields->>'title',
                coalesce(v_fields->>'content',''),
                v_fields->>'raised_by_org',
                v_object_ids_new,
                coalesce(v_fields->'quotes','[]'::jsonb),
                'approved',
                v_now, v_by_entity_id,
                v_source, v_note,
                jsonb_build_array(v_revision)
            )
            returning id into v_new_id;

            v_affected_topic_ids := v_affected_topic_ids || v_new_id;
            v_object_ids := v_object_ids || v_object_ids_new;
            v_n_topics_added := v_n_topics_added + 1;

        -- ─── REMOVE темы ──────────────────────────────────
        elsif v_kind = 'remove_topic' then
            v_target_id := (v_item->>'target_id')::uuid;
            select * into v_topic from meeting_topics where id = v_target_id;
            if not found then
                raise exception 'Topic not found: %', v_target_id;
            end if;
            -- Идемпотентность: если уже removed — пропускаем (не считаем)
            if v_topic.status = 'removed' then continue; end if;

            v_revision := jsonb_build_object(
                'at', v_now, 'by_entity_id', v_by_entity_id, 'by_org_name', v_by_org_name,
                'source', v_source, 'note', v_note,
                'action', 'removed_by_correction',
                'before', jsonb_build_object('status', v_topic.status),
                'after',  jsonb_build_object('status', 'removed')
            );

            update meeting_topics set
                status = 'removed',
                corrected_at = v_now,
                corrected_by_entity_id = v_by_entity_id,
                correction_source = v_source,
                correction_note = v_note,
                revisions = revisions || v_revision
            where id = v_target_id;

            v_affected_topic_ids := v_affected_topic_ids || v_target_id;
            v_object_ids := v_object_ids || v_topic.object_ids;
            v_n_topics_removed := v_n_topics_removed + 1;

        -- ─── REMOVE задачи ────────────────────────────────
        elsif v_kind = 'remove_task' then
            v_target_id := (v_item->>'target_id')::uuid;
            select * into v_task from tasks where id = v_target_id;
            if not found then
                raise exception 'Task not found: %', v_target_id;
            end if;
            if v_task.status = 'cancelled' then continue; end if;

            v_revision := jsonb_build_object(
                'at', v_now, 'by_entity_id', v_by_entity_id, 'by_org_name', v_by_org_name,
                'source', v_source, 'note', v_note,
                'action', 'removed_by_correction',
                'before', jsonb_build_object('status', v_task.status),
                'after',  jsonb_build_object('status', 'cancelled')
            );

            update tasks set
                status = 'cancelled',
                corrected_at = v_now,
                corrected_by_entity_id = v_by_entity_id,
                correction_source = v_source,
                correction_note = v_note,
                revisions = revisions || v_revision
            where id = v_target_id;

            v_affected_task_ids := v_affected_task_ids || v_target_id;
            v_object_ids := v_object_ids || v_task.object_ids;
            v_n_tasks_removed := v_n_tasks_removed + 1;

        else
            raise exception 'Unknown correction item kind: %', v_kind;
        end if;
    end loop;

    if v_n_topics + v_n_tasks + v_n_topics_added + v_n_tasks_added
       + v_n_topics_removed + v_n_tasks_removed = 0 then
        raise exception 'Нет применённых правок (все поля совпали с текущими значениями)';
    end if;

    select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_object_ids_dedup
      from unnest(v_object_ids) x where x is not null;

    v_event_title := 'Правки протокола ' || v_meeting_code ||
        case when v_by_org_name is not null then ' (от ' || v_by_org_name || ')' else '' end;

    v_event_note := coalesce(v_note, '') ||
        case when v_source is not null and v_source <> '' then E'\n\nИсточник: ' || v_source else '' end ||
        E'\n\nЗатронуто: ' || v_n_topics || ' правок тем / ' || v_n_tasks || ' правок задач' ||
        case when v_n_topics_added + v_n_tasks_added > 0
             then E'\nДобавлено: ' || v_n_topics_added || ' тем / ' || v_n_tasks_added || ' задач'
             else '' end ||
        case when v_n_topics_removed + v_n_tasks_removed > 0
             then E'\nУдалено: ' || v_n_topics_removed || ' тем / ' || v_n_tasks_removed || ' задач'
             else '' end;

    insert into events (event_type, title, note, date_start, object_ids, derived_source, is_preliminary)
    values ('protocol_correction', v_event_title, v_event_note, current_date,
            v_object_ids_dedup, 'protocol', false)
    returning id into v_event_id;

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
    'Атомарно применяет пакет правок к утверждённому собранию: UPDATE существующих (kind=topic/task), INSERT новых (kind=add_topic/add_task), логическое удаление (kind=remove_topic→status=removed / remove_task→status=cancelled) с revisions/correction_* + INSERT event protocol_correction + entity_links.';

notify pgrst, 'reload schema';
