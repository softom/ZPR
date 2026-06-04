-- ============================================================================
-- Стратегические темы — ревизии (правки) + комментарии + публикация
-- ============================================================================
-- Реализует workflow вариант B (см. WIKI 24):
--   1. Пользователь uploader создаёт topic_revision (draft → pending_review)
--   2. Админ принимает → значения копируются в strategic_topics, status=approved
--   3. Админ ЯВНО фиксирует ревизию как «финальный документ»:
--      strategic_topics.published_revision_id = revision.id
--   4. .docx-рендер берёт поля из published_revision (а не из strategic_topics) —
--      «документ» = снапшот, «рабочее состояние» = strategic_topics
-- ============================================================================

-- ─── topic_revisions ─────────────────────────────────────────────────────
create table topic_revisions (
    id                  uuid primary key default gen_random_uuid(),
    topic_id            uuid not null references strategic_topics(id) on delete cascade,
    author_user_id      uuid,    -- auth.users.id, nullable (для service-role операций)

    status              text not null default 'draft'
                        check (status in (
                            'draft',              -- черновик автора, видит только он
                            'pending_review',     -- отправлено админу на согласование
                            'approved',           -- админ принял (значения уже в strategic_topics)
                            'rejected',           -- админ отклонил
                            'changes_requested'   -- админ запросил доработки
                        )),

    -- Полный снапшот редактируемых полей. NULL = автор не предлагает менять.
    proposed_seq        smallint,
    proposed_title      text,
    proposed_category   text,
    proposed_synopsis   text,
    proposed_threats    text,
    proposed_solutions  text,
    proposed_deadlines  text,

    -- Снапшот текущих значений темы на момент создания ревизии — для diff
    -- (защищает от рассинхрона, если тема была изменена другим автором).
    base_snapshot       jsonb,

    -- Review
    review_comment      text,
    reviewer_user_id    uuid,    -- auth.users.id
    reviewed_at         timestamptz,

    submitted_at        timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index topic_revisions_topic_status_idx on topic_revisions (topic_id, status);
create index topic_revisions_author_idx       on topic_revisions (author_user_id) where author_user_id is not null;
create index topic_revisions_status_idx       on topic_revisions (status);
create index topic_revisions_created_idx      on topic_revisions (created_at desc);

-- updated_at trigger
create or replace function topic_revisions_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end$$;

create trigger topic_revisions_updated_at
    before update on topic_revisions
    for each row execute function topic_revisions_set_updated_at();

-- ─── topic_comments ──────────────────────────────────────────────────────
create table topic_comments (
    id                  uuid primary key default gen_random_uuid(),
    topic_id            uuid not null references strategic_topics(id) on delete cascade,
    revision_id         uuid references topic_revisions(id) on delete cascade,
    field_name          text check (field_name is null or field_name in (
                            'title','synopsis','threats','solutions','deadlines','category','seq'
                        )),
    author_user_id      uuid,
    author_name         text,    -- кеш для отображения (email/имя на момент создания)
    body                text not null,
    created_at          timestamptz not null default now()
);

create index topic_comments_topic_idx    on topic_comments (topic_id, created_at desc);
create index topic_comments_revision_idx on topic_comments (revision_id) where revision_id is not null;
create index topic_comments_author_idx   on topic_comments (author_user_id) where author_user_id is not null;

-- ─── strategic_topics: published_revision_id ─────────────────────────────
alter table strategic_topics
    add column published_revision_id   uuid references topic_revisions(id) on delete set null,
    add column published_at             timestamptz,
    add column published_by_user_id     uuid;

create index strategic_topics_published_idx on strategic_topics (published_revision_id)
    where published_revision_id is not null;

-- ─── RLS: topic_revisions ────────────────────────────────────────────────
alter table topic_revisions enable row level security;

-- Чтение: draft видит только его автор; всё остальное видят все.
create policy topic_revisions_select on topic_revisions for select
    using (status <> 'draft' OR author_user_id = auth.uid());

-- Создание: только uploader+
create policy topic_revisions_insert on topic_revisions for insert
    with check (user_role() = any(array['uploader','admin','service_role']));

-- Обновление: автор может править свой draft и отправлять на review;
-- админ может менять статус (approve/reject) и review_comment.
create policy topic_revisions_update on topic_revisions for update
    using (
        (status = 'draft' AND author_user_id = auth.uid())
        OR user_role() = any(array['admin','service_role'])
    );

-- Удаление: автор может удалить свой draft; админ — любую ревизию.
create policy topic_revisions_delete on topic_revisions for delete
    using (
        (status = 'draft' AND author_user_id = auth.uid())
        OR user_role() = any(array['admin','service_role'])
    );

-- ─── RLS: topic_comments ─────────────────────────────────────────────────
alter table topic_comments enable row level security;

-- Чтение: все, включая анона.
create policy topic_comments_select on topic_comments for select using (true);

-- Создание: uploader+
create policy topic_comments_insert on topic_comments for insert
    with check (user_role() = any(array['uploader','admin','service_role']));

-- Обновление / удаление: автор или админ
create policy topic_comments_update on topic_comments for update
    using (author_user_id = auth.uid() OR user_role() = any(array['admin','service_role']));

create policy topic_comments_delete on topic_comments for delete
    using (author_user_id = auth.uid() OR user_role() = any(array['admin','service_role']));

-- ─── Комментарии (на полях) ──────────────────────────────────────────────
comment on table topic_revisions is
    'Ревизии (предложенные правки) стратегических тем. Workflow: draft → pending_review → approved/rejected. Approve копирует proposed_* в strategic_topics. Публикация revision как финального документа — через strategic_topics.published_revision_id';
comment on column topic_revisions.id is 'PK';
comment on column topic_revisions.topic_id is 'FK → strategic_topics.id (CASCADE)';
comment on column topic_revisions.author_user_id is 'auth.users.id автора ревизии';
comment on column topic_revisions.status is
    'Статус: draft (видит только автор) | pending_review | approved | rejected | changes_requested';
comment on column topic_revisions.proposed_seq is 'Предложенный seq (NULL = не меняем)';
comment on column topic_revisions.proposed_title is 'Предложенное название (NULL = не меняем)';
comment on column topic_revisions.proposed_category is 'Предложенная категория (NULL = не меняем)';
comment on column topic_revisions.proposed_synopsis is 'Предложенный синопсис (NULL = не меняем)';
comment on column topic_revisions.proposed_threats is 'Предложенные угрозы (NULL = не меняем)';
comment on column topic_revisions.proposed_solutions is 'Предложенные решения (NULL = не меняем)';
comment on column topic_revisions.proposed_deadlines is 'Предложенные сроки (NULL = не меняем)';
comment on column topic_revisions.base_snapshot is
    'JSONB-снапшот текущих значений strategic_topics на момент создания ревизии. Структура: {seq, title, category, synopsis, threats, solutions, deadlines}. Используется для diff';
comment on column topic_revisions.review_comment is 'Комментарий рецензента (админа) при approve/reject/changes_requested';
comment on column topic_revisions.reviewer_user_id is 'auth.users.id рецензента (админа)';

comment on table topic_comments is
    'Комментарии к темам и/или ревизиям. Плоские, без тредов. Можно комментировать тему целиком, конкретную ревизию или конкретное поле';
comment on column topic_comments.topic_id is 'FK → strategic_topics.id (CASCADE)';
comment on column topic_comments.revision_id is 'FK → topic_revisions.id (CASCADE). NULL = комментарий к теме целиком, не к конкретной ревизии';
comment on column topic_comments.field_name is
    'Опциональная привязка к полю темы: title|synopsis|threats|solutions|deadlines|category|seq. NULL = к теме/ревизии целиком';
comment on column topic_comments.author_user_id is 'auth.users.id автора';
comment on column topic_comments.author_name is 'Кеш email/имени автора для отображения в UI';

comment on column strategic_topics.published_revision_id is
    'FK → topic_revisions.id (SET NULL при удалении ревизии). Указатель на ревизию, зафиксированную админом как «финальный документ». Используется при генерации .docx';
comment on column strategic_topics.published_at is 'Когда админ зафиксировал текущую published_revision_id';
comment on column strategic_topics.published_by_user_id is 'auth.users.id админа, зафиксировавшего финальный документ';

-- ─── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';
