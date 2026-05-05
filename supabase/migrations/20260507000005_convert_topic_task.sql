-- ============================================================
-- Атомарная конверсия Topic ↔ Task
-- ============================================================
-- Используется UI-эндпоинтами /api/topics/[id]/convert-to-task
-- и /api/tasks/[id]/convert-to-topic. Внутри одной транзакции:
--   - читаем исходную запись и meeting
--   - генерируем новый код в рамках meeting
--   - вставляем новый рекорд (status='preliminary')
--   - помечаем/удаляем исходный (тема → soft-delete, задача → hard-delete)

-- ─── topic → task ────────────────────────────────────────────────────────
-- p_payload (jsonb): { title, explanation, assignee_org, priority, due_date,
--                      object_ids (uuid[] в виде массива строк), quotes (jsonb) }
-- Возвращает id новой задачи.

create or replace function convert_topic_to_task(
    p_topic_id uuid,
    p_payload  jsonb
) returns uuid
language plpgsql as $$
declare
    v_topic       record;
    v_meeting     record;
    v_source     text;
    v_base       text;
    v_seq        int;
    v_code       text;
    v_new_id     uuid;
    v_object_ids uuid[];
    v_assignee_org text;
    v_assignee_id  uuid;
begin
    -- Топик и собрание
    select * into v_topic from meeting_topics where id = p_topic_id;
    if not found then
        raise exception 'Topic not found: %', p_topic_id;
    end if;
    select * into v_meeting from meetings where id = v_topic.meeting_id;
    if not found then
        raise exception 'Meeting not found for topic %', p_topic_id;
    end if;

    -- source_protocol и базовый префикс кода задачи
    v_source := coalesce(v_meeting.code, 'ПРОТ-' || to_char(v_meeting.meeting_date, 'YYYY-MM-DD'));
    v_base   := v_source || '-ЗАД';

    -- Следующий sequence в рамках собрания (а не глобально)
    select coalesce(
        max((regexp_match(t.code, '^' || replace(v_base, '+', '\+') || '-(\d+)$'))[1]::int),
        0
    ) + 1
      into v_seq
      from tasks t
     where t.meeting_id = v_topic.meeting_id;

    v_code := v_base || '-' || lpad(v_seq::text, 2, '0');

    -- object_ids: либо переданные пользователем, либо унаследованные от темы
    v_object_ids := coalesce(
        (select array_agg(value::uuid) from jsonb_array_elements_text(p_payload->'object_ids')),
        v_topic.object_ids
    );

    v_assignee_org := nullif(p_payload->>'assignee_org', '');
    if v_assignee_org is not null then
        v_assignee_id := find_legal_entity_by_alias(v_assignee_org);
    end if;

    insert into tasks (
        code, meeting_id, title, explanation, status, priority,
        assignee_org, assignee_entity_id,
        object_ids, due_date, quotes,
        source_protocol, source_meeting_date, source_meeting_path,
        tags
    ) values (
        v_code,
        v_topic.meeting_id,
        coalesce(p_payload->>'title', v_topic.title),
        coalesce(p_payload->>'explanation', v_topic.content),
        'preliminary',
        coalesce(p_payload->>'priority', 'medium'),
        v_assignee_org,
        v_assignee_id,
        v_object_ids,
        nullif(p_payload->>'due_date', '')::date,
        coalesce(p_payload->'quotes', v_topic.quotes),
        v_source,
        v_meeting.meeting_date,
        v_meeting.folder_path,
        array['protocol']
    ) returning id into v_new_id;

    update meeting_topics set status = 'removed' where id = p_topic_id;

    return v_new_id;
end$$;

comment on function convert_topic_to_task(uuid, jsonb) is
    'Атомарный перенос темы в задачу: INSERT preliminary task + UPDATE topic.status=removed.';

-- ─── task → topic ────────────────────────────────────────────────────────
-- p_payload (jsonb): { title, content, raised_by_org, object_ids, quotes,
--                      discussion_date }
-- Возвращает id новой темы.

create or replace function convert_task_to_topic(
    p_task_id uuid,
    p_payload jsonb
) returns uuid
language plpgsql as $$
declare
    v_task        record;
    v_meeting     record;
    v_source      text;
    v_base        text;
    v_seq         int;
    v_code        text;
    v_new_id      uuid;
    v_object_ids  uuid[];
    v_raised_by_org text;
    v_raised_by_id  uuid;
    v_topic_seq   int;
begin
    select * into v_task from tasks where id = p_task_id;
    if not found then
        raise exception 'Task not found: %', p_task_id;
    end if;
    if v_task.meeting_id is null then
        raise exception 'Task % has no meeting_id — нельзя конвертировать в topic', p_task_id;
    end if;
    select * into v_meeting from meetings where id = v_task.meeting_id;

    v_source := coalesce(v_meeting.code, 'ПРОТ-' || to_char(v_meeting.meeting_date, 'YYYY-MM-DD'));
    v_base   := v_source || '-ОБС';

    select coalesce(
        max((regexp_match(t.code, '^' || replace(v_base, '+', '\+') || '-(\d+)$'))[1]::int),
        0
    ) + 1
      into v_seq
      from meeting_topics t
     where t.meeting_id = v_task.meeting_id;

    v_code := v_base || '-' || lpad(v_seq::text, 2, '0');

    -- seq в рамках meeting_topics (порядковый номер для отображения)
    select coalesce(max(seq), 0) + 1 into v_topic_seq
      from meeting_topics where meeting_id = v_task.meeting_id;

    v_object_ids := coalesce(
        (select array_agg(value::uuid) from jsonb_array_elements_text(p_payload->'object_ids')),
        v_task.object_ids
    );

    v_raised_by_org := nullif(p_payload->>'raised_by_org', '');
    if v_raised_by_org is null then
        v_raised_by_org := v_task.assignee_org;
    end if;
    if v_raised_by_org is not null then
        v_raised_by_id := find_legal_entity_by_alias(v_raised_by_org);
    end if;

    insert into meeting_topics (
        meeting_id, code, seq, title, content,
        raised_by_org, raised_by_entity_id,
        object_ids, quotes, status, discussion_date
    ) values (
        v_task.meeting_id,
        v_code,
        v_topic_seq,
        coalesce(p_payload->>'title', v_task.title),
        coalesce(p_payload->>'content', coalesce(v_task.explanation, v_task.title)),
        v_raised_by_org,
        v_raised_by_id,
        v_object_ids,
        coalesce(p_payload->'quotes', v_task.quotes),
        'preliminary',
        coalesce(nullif(p_payload->>'discussion_date', '')::date, v_meeting.meeting_date)
    ) returning id into v_new_id;

    delete from tasks where id = p_task_id;

    return v_new_id;
end$$;

comment on function convert_task_to_topic(uuid, jsonb) is
    'Атомарный перенос задачи в тему: INSERT preliminary meeting_topic + DELETE task.';

notify pgrst, 'reload schema';
