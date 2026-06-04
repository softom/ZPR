-- ============================================================
-- ZPR — plots (Ф1 миграция 3)
-- ============================================================
-- Логический земельный участок. Стабильный ID. Связь с functional_object
-- (Г-1.5 «Отель 5★») и с бизнес-объектом ЗПР (objects.code = `104_ГОСТИНИЦА_260`).
-- Обе связи nullable — для общей инфраструктуры и до маппинга.
--
-- См. [[29_Сущность_Участок]] раздел `plots`.
-- ============================================================

create table plots (
    id                    uuid primary key default gen_random_uuid(),
    object_id             uuid references objects(id) on delete restrict,
    functional_object_id  uuid references functional_objects(id) on delete set null,
    code                  text not null unique,
    name                  text not null,
    parent_plot_id        uuid references plots(id),
    role                  plot_role not null default 'plot',
    permitted_use         text,
    category              text,
    area_declared_m2      numeric,
    cadastral_number      text,
    source_pmt_zu         text,
    note                  text,
    active                boolean not null default true,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    check (parent_plot_id is null or parent_plot_id <> id)
);

create index plots_object_idx        on plots(object_id) where object_id is not null;
create index plots_unassigned_idx    on plots(id) where object_id is null and active = true;
create index plots_functional_idx    on plots(functional_object_id) where functional_object_id is not null;
create index plots_parent_idx        on plots(parent_plot_id) where parent_plot_id is not null;
create index plots_cadastral_idx     on plots(cadastral_number) where cadastral_number is not null;
create index plots_pmt_zu_idx        on plots(source_pmt_zu) where source_pmt_zu is not null;

comment on table plots is
  'Логический земельный участок. Стабильный ID. Связи с functional_object и бизнес-объектом ЗПР опциональны.';

-- ============================================================
-- Триггер: валидация parent_plot_id (для сервитутов / partial)
-- ============================================================
create or replace function plots_validate_parent() returns trigger
language plpgsql as $$
begin
    if new.parent_plot_id is not null then
        if not exists (
            select 1 from plots
             where id = new.parent_plot_id
               and role in ('plot', 'cadastral')
        ) then
            raise exception 'parent_plot_id must reference plot with role plot/cadastral';
        end if;
        if new.role not in ('servitude', 'partial') then
            raise exception 'plots with parent_plot_id must have role servitude or partial';
        end if;
    end if;
    return new;
end$$;

create trigger tr_plots_validate_parent
    before insert or update on plots
    for each row execute function plots_validate_parent();
