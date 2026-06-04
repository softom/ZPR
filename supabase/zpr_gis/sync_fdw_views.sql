-- ============================================================
-- zpr_gis — синхронизация foreign tables на gis_* views
-- ============================================================
-- ArcGIS Pro подключается к БД zpr_gis (порт 54322, user arcgis_writer).
-- Эта БД проксирует через postgres_fdw к основной `postgres` БД через схему
-- _remote. Здесь регистрируем foreign tables на ArcGIS-friendly views
-- gis_plots / gis_functional_zones / gis_objects из основной БД, с явной
-- типизацией geometry(MultiPolygon, SRID), чтобы ArcGIS подхватил СК.
--
-- Запуск (от имени supabase_admin — он owner foreign tables в _remote):
--   docker exec -e PGPASSWORD=postgres supabase_db_zpr_code \
--     psql -U supabase_admin -h localhost -d zpr_gis \
--     -f /path/to/sync_fdw_views.sql
--
-- Сами views определены в основной БД миграцией 20260521010001_gis_arcgis_views.sql.
-- ============================================================

-- 0. Локальный ENUM-зеркало (нужен для импорта engineering_loads, если будем)
do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                 where n.nspname='public' and t.typname='engineering_network') then
    create type public.engineering_network as enum
      ('water','sewer','storm','heat','gas','power','telecom');
  end if;
end $$;

-- 1. Пересоздаём foreign tables на gis_* views
drop foreign table if exists _remote.gis_plots               cascade;
drop foreign table if exists _remote.gis_functional_zones    cascade;
drop foreign table if exists _remote.gis_objects             cascade;
drop foreign table if exists _remote.gis_cadastrals          cascade;
drop foreign table if exists _remote.gis_object_polygons     cascade;
drop foreign table if exists _remote.gis_object_lines        cascade;
drop foreign table if exists _remote.gis_object_points       cascade;
drop foreign table if exists _remote.gis_raster_footprints   cascade;

create foreign table _remote.gis_plots (
    objectid              integer            not null,
    id                    uuid               not null,
    code                  text,
    name                  text,
    role                  text,
    cadastral_number      text,
    permitted_use         text,
    functional_zone_code  text,
    functional_name       text,
    functional_kind       text,
    objects_csv           text,
    objects_count         integer,
    current_boundary_type text,
    current_version       smallint,
    area_m2               numeric,
    polygon_count         integer,
    -- Нагрузки зоны (через functional_object_id)
    load_water            numeric,
    load_sewer            numeric,
    load_storm            numeric,
    load_heat             numeric,
    load_gas              numeric,
    load_power            numeric,
    load_telecom          numeric,
    loads_summary         text,
    -- Прямые нагрузки на сам участок (engineering_loads.plot_id)
    load_water_plot       numeric,
    load_sewer_plot       numeric,
    load_storm_plot       numeric,
    load_heat_plot        numeric,
    load_gas_plot         numeric,
    load_power_plot       numeric,
    geom_4326             extensions.geometry(MultiPolygon, 4326),
    geom_sk63             extensions.geometry(MultiPolygon, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_plots');

create foreign table _remote.gis_functional_zones (
    objectid       integer            not null,
    id             uuid               not null,
    zone_code      text,
    zone_name      text,
    kind           text,
    queue          text,
    objects_csv    text,
    objects_count  integer,
    load_water     numeric,
    load_sewer     numeric,
    load_storm     numeric,
    load_heat      numeric,
    load_gas       numeric,
    load_power     numeric,
    load_telecom   numeric,
    loads_summary  text,
    area_m2        numeric,
    plots_count    integer,
    geom_4326      extensions.geometry(MultiPolygon, 4326),
    geom_sk63      extensions.geometry(MultiPolygon, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_functional_zones');

create foreign table _remote.gis_objects (
    objectid      integer  not null,
    id            uuid     not null,
    code          text,
    name          text,
    contractor    text,
    color         text,
    plots_count   integer,
    area_m2       numeric,
    geom_4326     extensions.geometry(MultiPolygon, 4326),
    geom_sk63     extensions.geometry(MultiPolygon, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_objects');

create foreign table _remote.gis_cadastrals (
    objectid          integer  not null,
    id                uuid     not null,
    cadastral_number  text,
    address           text,
    category          text,
    category_code     text,
    vri               text,
    ownership         text,
    ownership_raw     text,
    source            text,
    is_seizure        boolean,
    seizure_area_m2   numeric,
    area_declared_m2  numeric,
    cadastral_cost    numeric,
    status            text,
    active            boolean,
    geom_4326         extensions.geometry(MultiPolygon, 4326),
    geom_sk63         extensions.geometry(MultiPolygon, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_cadastrals');

create foreign table _remote.gis_object_polygons (
    objectid     integer  not null,
    id           uuid     not null,
    object_id    uuid,
    object_code  text,
    object_name  text,
    kind         text,
    name         text,
    source       text,
    properties   jsonb,
    valid_from   timestamptz,
    geom_4326    extensions.geometry(MultiPolygon, 4326),
    geom_sk63    extensions.geometry(MultiPolygon, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_object_polygons');

create foreign table _remote.gis_object_lines (
    objectid     integer  not null,
    id           uuid     not null,
    object_id    uuid,
    object_code  text,
    object_name  text,
    kind         text,
    name         text,
    source       text,
    properties   jsonb,
    valid_from   timestamptz,
    geom_4326    extensions.geometry(MultiLineString, 4326),
    geom_sk63    extensions.geometry(MultiLineString, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_object_lines');

create foreign table _remote.gis_object_points (
    objectid     integer  not null,
    id           uuid     not null,
    object_id    uuid,
    object_code  text,
    object_name  text,
    kind         text,
    name         text,
    source       text,
    properties   jsonb,
    valid_from   timestamptz,
    geom_4326    extensions.geometry(MultiPoint, 4326),
    geom_sk63    extensions.geometry(MultiPoint, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_object_points');

create foreign table _remote.gis_raster_footprints (
    objectid       integer  not null,
    id             uuid     not null,
    object_id      uuid,
    object_code    text,
    title          text,
    kind           text,
    storage_url    text,
    resolution_m   numeric,
    captured_at    date,
    z_min          numeric,
    z_max          numeric,
    z_unit         text,
    colormap       text,
    geom_4326      extensions.geometry(MultiPolygon, 4326),
    geom_sk63      extensions.geometry(MultiPolygon, 970634)
) server zpr_main options (schema_name 'public', table_name 'gis_raster_footprints');

-- 2. Гранты для arcgis_writer (он подключается извне через порт 54322)
grant connect on database zpr_gis to arcgis_writer;
grant usage on schema _remote, extensions, public to arcgis_writer;
grant select on
    _remote.gis_plots,
    _remote.gis_functional_zones,
    _remote.gis_objects,
    _remote.gis_cadastrals,
    _remote.gis_object_polygons,
    _remote.gis_object_lines,
    _remote.gis_object_points,
    _remote.gis_raster_footprints
    to arcgis_writer;
grant select on extensions.geometry_columns to arcgis_writer;
grant select on extensions.spatial_ref_sys  to arcgis_writer;
