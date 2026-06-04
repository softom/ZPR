-- ============================================================
-- ZPR — plot_polygons (Ф1 миграция 4)
-- ============================================================
-- Физический контур (Polygon в СК-63 z4). Чистая геометрия + автовычисленные
-- area_calc_m2 / perimeter_m / point_count. Без знания, кому принадлежит.
--
-- См. [[29_Сущность_Участок]] раздел `plot_polygons`.
-- ============================================================

create table plot_polygons (
    id              uuid primary key default gen_random_uuid(),
    geom            geometry(Polygon, 970634) not null,
    geom_4326       geometry(Polygon, 4326)
                    generated always as (extensions.ST_Transform(geom, 4326)) stored,
    area_calc_m2    numeric
                    generated always as (extensions.ST_Area(geom)) stored,
    perimeter_m     numeric
                    generated always as (extensions.ST_Perimeter(geom)) stored,
    point_count     smallint
                    generated always as (extensions.ST_NPoints(geom)) stored,
    note            text,
    created_at      timestamptz not null default now(),
    check (extensions.ST_IsValid(geom))
);

create index plot_polygons_geom_gist        on plot_polygons using gist(geom);
create index plot_polygons_geom_4326_gist   on plot_polygons using gist(geom_4326);

comment on table plot_polygons is
  'Физический контур ЗУ. Чистая геометрия в СК-63 z4. Принадлежность к ЗУ определяется через plot_polygon_assignments.';
comment on column plot_polygons.area_calc_m2 is
  'Рассчитанная площадь в кв.м. Для сверки с pmt_zu.area_m2_coords / plots.area_declared_m2.';
