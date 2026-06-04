-- ============================================================
-- contacts.user_id — мост contact ↔ auth.users
-- ============================================================
-- Дизайн: contact — универсальная сущность «человек проекта» (партнёр или
-- сотрудник ТЗ-ЮГ). У контакта может быть привязка к системному
-- пользователю UI через nullable FK `user_id`.
--
-- Зачем: задачи могут быть назначены как контактам-партнёрам, так и
-- сотрудникам ТЗ-ЮГ (системным пользователям). Чтобы не дублировать
-- ту же личность дважды (contact и user), вводим один-в-один-mapping.
--
-- Связь по-прежнему через `entity_links(assigned_to → contact)` —
-- `auth.user` НЕ становится отдельным `to_type`. См. WIKI 19 v2.5+.
-- ============================================================

begin;

-- 1. Колонка + unique constraint
alter table contacts
    add column if not exists user_id uuid
        references auth.users(id) on delete set null;

create unique index if not exists contacts_user_id_unique
    on contacts(user_id) where user_id is not null;

comment on column contacts.user_id is
    'FK на auth.users.id. NULL для контактов-не-пользователей системы. UNIQUE: один user — один contact.';

-- 2. Backfill email из auth.users (для 3 матчей по ФИО)
update contacts c
   set email = u.email
  from auth.users u
 where c.email is null
   and (
     (lower(c.last_name) = 'антипов'  and lower(c.first_name) = 'артемий' and u.email = 'artem.antipov@gmail.com')
     or (lower(c.last_name) = 'долгих'   and lower(c.first_name) = 'сергей'  and u.email = 's.dolgih@dedalconsul.ru')
     or (lower(c.last_name) = 'шержуков' and lower(c.first_name) = 'юрий'    and u.email = 'y.l.sherzhukov@dedalconsul.ru')
   );

-- 3. Backfill user_id для тех же 3 пар
update contacts c
   set user_id = u.id
  from auth.users u
 where c.user_id is null
   and (
     (lower(c.last_name) = 'антипов'  and u.email = 'artem.antipov@gmail.com')
     or (lower(c.last_name) = 'долгих'   and u.email = 's.dolgih@dedalconsul.ru')
     or (lower(c.last_name) = 'шержуков' and u.email = 'y.l.sherzhukov@dedalconsul.ru')
   );

-- 4. Аудит
do $$
declare
    v_contacts_total int;
    v_linked         int;
    v_users_unlinked int;
begin
    select count(*) into v_contacts_total from contacts;
    select count(*) into v_linked         from contacts where user_id is not null;
    select count(*) into v_users_unlinked
      from auth.users u
     where not exists (select 1 from contacts c where c.user_id = u.id);
    raise notice '── contacts: total=%, with user_id=%, unlinked auth.users=%',
                 v_contacts_total, v_linked, v_users_unlinked;
end $$;

notify pgrst, 'reload schema';

commit;
