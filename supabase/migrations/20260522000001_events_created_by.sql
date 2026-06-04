-- ============================================================================
-- events.created_by — автор события
-- ============================================================================
-- Заполняется триггером из auth.uid() при INSERT, если не задан явно.
-- Для UI в колонке «Природа» отображается имя автора у manual-событий.
--
-- Также создаём VIEW user_names — публичный справочник «id → имя» для UI,
-- так как auth.users недоступна анон-клиенту по умолчанию.
-- ============================================================================

alter table events add column if not exists created_by uuid;

comment on column events.created_by is
    'auth.users.id автора события. Заполняется триггером events_set_created_by '
    'из auth.uid() при INSERT, если не задан явно. NULL — для системных/импортированных событий.';

-- ─── Триггер: автозаполнение created_by из JWT ────────────────────────────
create or replace function trg_events_set_created_by()
returns trigger language plpgsql as $$
begin
    if new.created_by is null then
        new.created_by := auth.uid();
    end if;
    return new;
end$$;

drop trigger if exists events_set_created_by on events;
create trigger events_set_created_by
    before insert on events
    for each row
    execute function trg_events_set_created_by();

-- ─── VIEW user_names — публичный справочник имён ──────────────────────────
-- security_invoker=false (default): VIEW выполняется с правами owner (postgres),
-- что даёт доступ к auth.users.
create or replace view public.user_names as
    select
        u.id,
        coalesce(
            nullif(trim(u.raw_user_meta_data->>'name'), ''),
            nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
            split_part(u.email, '@', 1)
        ) as name,
        u.email
    from auth.users u;

grant select on public.user_names to anon, authenticated;

comment on view public.user_names is
    'Публичный справочник пользователей для UI (имя/email). Источник — auth.users '
    '(VIEW работает с security_invoker=false, owner = postgres).';

-- ─── Backfill 3 черновых manual-preliminary событий ───────────────────────
-- В системе сейчас 2 пользователя: artem.antipov@gmail.com и s.dolgih@dedalconsul.ru.
-- Привязываем 3 preliminary manual-события к s.dolgih (атрибуция от руки —
-- единственный не-Артём в системе на этот момент).
update events
   set created_by = (select id from auth.users where email='s.dolgih@dedalconsul.ru')
 where is_preliminary = true
   and derived_source = 'manual'
   and created_by is null
   and (select id from auth.users where email='s.dolgih@dedalconsul.ru') is not null;

notify pgrst, 'reload schema';
