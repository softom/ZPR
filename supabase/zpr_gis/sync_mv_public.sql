-- ============================================================
-- zpr_gis: материализованные views в public, видимые в Map 3D / ArcGIS Pro
-- ============================================================
-- FDO PostgreSQL Provider в Map 3D не показывает foreign tables (relkind='f')
-- из схемы _remote. Создаём MV в схеме public — Map 3D их увидит как обычные
-- таблицы. Они физически хранят копию данных, синхронизируются через REFRESH.
--
-- Запуск: docker exec -e PGPASSWORD=postgres supabase_db_zpr_code \
--   psql -U supabase_admin -h localhost -d zpr_gis -f /path/sync_mv_public.sql
-- ============================================================

drop materialized view if exists public.gis_plots             cascade;
drop materialized view if exists public.gis_functional_zones  cascade;
drop materialized view if exists public.gis_objects           cascade;

-- ── gis_plots ────────────────────────────────────────────────────────────────
create materialized view public.gis_plots as
select
    objectid,
    id,
    code,
    name,
    role,
    cadastral_number,
    permitted_use,
    functional_zone_code,
    functional_name,
    functional_kind,
    objects_csv,
    objects_count,
    current_boundary_type,
    current_version,
    area_m2,
    polygon_count,
    load_water,
    load_sewer,
    load_storm,
    load_heat,
    load_gas,
    load_power,
    load_telecom,
    loads_summary,
    load_water_plot,
    load_sewer_plot,
    load_storm_plot,
    load_heat_plot,
    load_gas_plot,
    load_power_plot,
    geom_4326::extensions.geometry(MultiPolygon, 4326)   as geom_4326,
    geom_sk63::extensions.geometry(MultiPolygon, 970634) as geom_sk63
from _remote.gis_plots;

create unique index gis_plots_pk on public.gis_plots (id);
create index gis_plots_geom_4326_idx on public.gis_plots using gist (geom_4326);
create index gis_plots_geom_sk63_idx on public.gis_plots using gist (geom_sk63);

comment on materialized view public.gis_plots is
  'Атомарные участки + multipart-геометрия + нагрузки по сетям. REFRESH при изменениях.';

-- ── gis_functional_zones ─────────────────────────────────────────────────────
create materialized view public.gis_functional_zones as
select
    objectid,
    id,
    zone_code,
    zone_name,
    kind,
    queue,
    objects_csv,
    objects_count,
    load_water,
    load_sewer,
    load_storm,
    load_heat,
    load_gas,
    load_power,
    load_telecom,
    loads_summary,
    area_m2,
    plots_count,
    geom_4326::extensions.geometry(MultiPolygon, 4326)   as geom_4326,
    geom_sk63::extensions.geometry(MultiPolygon, 970634) as geom_sk63
from _remote.gis_functional_zones;

create unique index gis_functional_zones_pk on public.gis_functional_zones (id);
create index gis_functional_zones_geom_4326_idx on public.gis_functional_zones using gist (geom_4326);
create index gis_functional_zones_geom_sk63_idx on public.gis_functional_zones using gist (geom_sk63);

comment on materialized view public.gis_functional_zones is
  'Функциональные зоны ППТ + агрегированная геометрия + нагрузки. REFRESH при изменениях.';

-- ── gis_objects ──────────────────────────────────────────────────────────────
create materialized view public.gis_objects as
select
    objectid,
    id,
    code,
    name,
    contractor,
    color,
    plots_count,
    area_m2,
    geom_4326::extensions.geometry(MultiPolygon, 4326)   as geom_4326,
    geom_sk63::extensions.geometry(MultiPolygon, 970634) as geom_sk63
from _remote.gis_objects;

create unique index gis_objects_pk on public.gis_objects (id);
create index gis_objects_geom_4326_idx on public.gis_objects using gist (geom_4326);
create index gis_objects_geom_sk63_idx on public.gis_objects using gist (geom_sk63);

comment on materialized view public.gis_objects is
  'Бизнес-объекты ЗПР + агрегированная геометрия (M:N через junction). REFRESH при изменениях.';

-- ── Гранты для arcgis_writer ─────────────────────────────────────────────────
grant select on public.gis_plots, public.gis_functional_zones, public.gis_objects to arcgis_writer;

-- ── Удобный helper для REFRESH ───────────────────────────────────────────────
create or replace function public.gis_refresh() returns void
language plpgsql
as $$
begin
  refresh materialized view concurrently public.gis_plots;
  refresh materialized view concurrently public.gis_functional_zones;
  refresh materialized view concurrently public.gis_objects;
end;
$$;

grant execute on function public.gis_refresh() to arcgis_writer;

comment on function public.gis_refresh() is
  'Обновить материализованные views (gis_plots/zones/objects). Запускать после изменений в основной БД. CONCURRENTLY — без блокировки читателей.';
