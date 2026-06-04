-- ============================================================
-- ZPR — plot_polygon_assignments (Ф1 миграция 5)
-- ============================================================
-- Связь plot ↔ polygon с версионированием. Здесь живёт `valid_from`/`valid_to`,
-- `boundary_type`, `source_document_id`, `sequence_no` для multi-part.
--
-- См. [[29_Сущность_Участок]] раздел `plot_polygon_assignments`.
-- ============================================================

create table plot_polygon_assignments (
    id                   uuid primary key default gen_random_uuid(),
    plot_id              uuid not null references plots(id) on delete cascade,
    polygon_id           uuid not null references plot_polygons(id) on delete restrict,
    boundary_type        text not null references plot_boundary_types(code),
    ring_role            assignment_ring_role not null default 'outer',
    sequence_no          smallint not null default 1,
    version_in_type      smallint not null default 1,
    source_document_id   uuid not null references documents(id),
    valid_from           date not null,
    valid_to             date,
    note                 text,
    created_at           timestamptz not null default now(),
    check (valid_to is null or valid_to >= valid_from)
);

create index plot_polygon_assignments_plot_idx    on plot_polygon_assignments(plot_id);
create index plot_polygon_assignments_poly_idx    on plot_polygon_assignments(polygon_id);
create index plot_polygon_assignments_doc_idx     on plot_polygon_assignments(source_document_id);
create index plot_polygon_assignments_current_idx on plot_polygon_assignments(plot_id, boundary_type)
                                                  where valid_to is null;

-- Partial unique: один polygon в каждый момент времени — у одного plot per boundary_type
create unique index plot_polygon_assignments_active_polygon_unique
    on plot_polygon_assignments(polygon_id, boundary_type)
    where valid_to is null;

-- ============================================================
-- Триггер: закрытие старых версий при появлении новой
-- ============================================================
-- Условие `valid_from < new.valid_from` критично для multi-part импорта:
-- N контуров одной партии с одинаковым valid_from НЕ должны закрывать друг друга.
create or replace function plot_polygon_assignments_close_old() returns trigger
language plpgsql as $$
begin
    if new.valid_to is null then
        update plot_polygon_assignments
           set valid_to = new.valid_from
         where plot_id = new.plot_id
           and boundary_type = new.boundary_type
           and id <> new.id
           and valid_to is null
           and valid_from < new.valid_from;
    end if;
    return new;
end$$;

create trigger tr_plot_polygon_assignments_close_old
    after insert on plot_polygon_assignments
    for each row execute function plot_polygon_assignments_close_old();

comment on table plot_polygon_assignments is
  'Связь plot ↔ polygon с версионированием. valid_to IS NULL = актуальная привязка.';
comment on column plot_polygon_assignments.sequence_no is
  'Порядок контуров в multi-part feature. Для стабильного рендера в ArcGIS/QGIS.';
comment on column plot_polygon_assignments.ring_role is
  'outer (default) / hole (вырез) / servitude (резерв) / overlap. По умолчанию outer.';
