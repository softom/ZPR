-- ============================================================
-- zpr_gis: ОБЫЧНЫЕ ТАБЛИЦЫ в public для FDO PostGIS Provider (Map 3D)
-- ============================================================
-- FDO в Map 3D показывает только relkind='r' (обычные таблицы), не views и не
-- materialized views. И требует ОДНУ геометрическую колонку на таблицу —
-- иначе теряется автоопределение SRID (Coordinate System приходит пустой).
--
-- Делаем по 2 таблицы на каждую сущность: *_wgs (EPSG:4326) и *_sk63 (970634).
-- Map 3D надёжно подхватит обе, пользователь выберет ту что совпадает с
-- координатной системой его DWG.
--
-- Обновление: SELECT public.gis_refresh();  (TRUNCATE + INSERT)
-- ============================================================

drop table if exists public.gis_plots                cascade;
drop table if exists public.gis_functional_zones     cascade;
drop table if exists public.gis_objects              cascade;
drop table if exists public.gis_plots_sk63           cascade;
drop table if exists public.gis_functional_zones_sk63 cascade;
drop table if exists public.gis_objects_sk63         cascade;
drop table if exists public.gis_cadastrals           cascade;
drop table if exists public.gis_cadastrals_sk63      cascade;
drop table if exists public.gis_object_polygons      cascade;
drop table if exists public.gis_object_polygons_sk63 cascade;
drop table if exists public.gis_object_lines         cascade;
drop table if exists public.gis_object_lines_sk63    cascade;
drop table if exists public.gis_object_points        cascade;
drop table if exists public.gis_object_points_sk63   cascade;
drop table if exists public.gis_raster_footprints       cascade;
drop table if exists public.gis_raster_footprints_sk63  cascade;
drop function if exists public.gis_refresh();

-- ── gis_plots (WGS84 — EPSG:4326) ────────────────────────────────────────────
create table public.gis_plots (
    objectid              serial      primary key,
    id                    uuid        not null unique,
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
    load_water            numeric,
    load_sewer            numeric,
    load_storm            numeric,
    load_heat             numeric,
    load_gas              numeric,
    load_power            numeric,
    load_telecom          numeric,
    loads_summary         text,
    load_water_plot       numeric,
    load_sewer_plot       numeric,
    load_storm_plot       numeric,
    load_heat_plot        numeric,
    load_gas_plot         numeric,
    load_power_plot       numeric,
    geom                  extensions.geometry(MultiPolygon, 4326)
);
create index gis_plots_geom_idx on public.gis_plots using gist (geom);

-- ── gis_plots_sk63 (СК-63 zone X4 — EPSG:970634) ─────────────────────────────
create table public.gis_plots_sk63 (
    objectid              serial      primary key,
    id                    uuid        not null unique,
    code                  text,
    name                  text,
    functional_zone_code  text,
    objects_csv           text,
    area_m2               numeric,
    load_water            numeric,
    load_sewer            numeric,
    load_storm            numeric,
    load_heat             numeric,
    load_gas              numeric,
    load_power            numeric,
    loads_summary         text,
    geom                  extensions.geometry(MultiPolygon, 970634)
);
create index gis_plots_sk63_geom_idx on public.gis_plots_sk63 using gist (geom);

-- ── gis_functional_zones (WGS84) ─────────────────────────────────────────────
create table public.gis_functional_zones (
    objectid       serial primary key,
    id             uuid   not null unique,
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
    geom           extensions.geometry(MultiPolygon, 4326)
);
create index gis_functional_zones_geom_idx on public.gis_functional_zones using gist (geom);

create table public.gis_functional_zones_sk63 (
    objectid       serial primary key,
    id             uuid   not null unique,
    zone_code      text,
    zone_name      text,
    kind           text,
    objects_csv    text,
    loads_summary  text,
    area_m2        numeric,
    geom           extensions.geometry(MultiPolygon, 970634)
);
create index gis_functional_zones_sk63_geom_idx on public.gis_functional_zones_sk63 using gist (geom);

-- ── gis_objects (WGS84) ──────────────────────────────────────────────────────
create table public.gis_objects (
    objectid     serial primary key,
    id           uuid   not null unique,
    code         text,
    name         text,
    contractor   text,
    color        text,
    plots_count  integer,
    area_m2      numeric,
    geom         extensions.geometry(MultiPolygon, 4326)
);
create index gis_objects_geom_idx on public.gis_objects using gist (geom);

create table public.gis_objects_sk63 (
    objectid     serial primary key,
    id           uuid   not null unique,
    code         text,
    name         text,
    contractor   text,
    color        text,
    plots_count  integer,
    area_m2      numeric,
    geom         extensions.geometry(MultiPolygon, 970634)
);
create index gis_objects_sk63_geom_idx on public.gis_objects_sk63 using gist (geom);

-- ── gis_cadastrals (WGS84) ───────────────────────────────────────────────────
create table public.gis_cadastrals (
    objectid          serial primary key,
    id                uuid   not null unique,
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
    geom              extensions.geometry(MultiPolygon, 4326)
);
create index gis_cadastrals_geom_idx on public.gis_cadastrals using gist (geom);

create table public.gis_cadastrals_sk63 (
    objectid          serial primary key,
    id                uuid   not null unique,
    cadastral_number  text,
    ownership         text,
    is_seizure        boolean,
    area_declared_m2  numeric,
    geom              extensions.geometry(MultiPolygon, 970634)
);
create index gis_cadastrals_sk63_geom_idx on public.gis_cadastrals_sk63 using gist (geom);

-- ── gis_object_polygons (здания / зоны / прочие полигоны) ────────────────────
create table public.gis_object_polygons (
    objectid     serial primary key,
    id           uuid   not null unique,
    object_id    uuid,
    object_code  text,
    object_name  text,
    kind         text,
    name         text,
    source       text,
    valid_from   timestamptz,
    geom         extensions.geometry(MultiPolygon, 4326)
);
create index gis_object_polygons_geom_idx on public.gis_object_polygons using gist (geom);

create table public.gis_object_polygons_sk63 (
    objectid     serial primary key,
    id           uuid   not null unique,
    object_code  text,
    kind         text,
    name         text,
    geom         extensions.geometry(MultiPolygon, 970634)
);
create index gis_object_polygons_sk63_geom_idx on public.gis_object_polygons_sk63 using gist (geom);

-- ── gis_object_lines (дороги / линии инженерных сетей) ───────────────────────
create table public.gis_object_lines (
    objectid     serial primary key,
    id           uuid   not null unique,
    object_id    uuid,
    object_code  text,
    object_name  text,
    kind         text,
    name         text,
    source       text,
    valid_from   timestamptz,
    geom         extensions.geometry(MultiLineString, 4326)
);
create index gis_object_lines_geom_idx on public.gis_object_lines using gist (geom);

create table public.gis_object_lines_sk63 (
    objectid     serial primary key,
    id           uuid   not null unique,
    object_code  text,
    kind         text,
    name         text,
    geom         extensions.geometry(MultiLineString, 970634)
);
create index gis_object_lines_sk63_geom_idx on public.gis_object_lines_sk63 using gist (geom);

-- ── gis_object_points (узлы инженерных сетей / точки) ────────────────────────
create table public.gis_object_points (
    objectid     serial primary key,
    id           uuid   not null unique,
    object_id    uuid,
    object_code  text,
    object_name  text,
    kind         text,
    name         text,
    source       text,
    valid_from   timestamptz,
    geom         extensions.geometry(MultiPoint, 4326)
);
create index gis_object_points_geom_idx on public.gis_object_points using gist (geom);

create table public.gis_object_points_sk63 (
    objectid     serial primary key,
    id           uuid   not null unique,
    object_code  text,
    kind         text,
    name         text,
    geom         extensions.geometry(MultiPoint, 970634)
);
create index gis_object_points_sk63_geom_idx on public.gis_object_points_sk63 using gist (geom);

-- ── gis_raster_footprints (bbox ортофото / DEM) ──────────────────────────────
create table public.gis_raster_footprints (
    objectid       serial primary key,
    id             uuid   not null unique,
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
    geom           extensions.geometry(MultiPolygon, 4326)
);
create index gis_raster_footprints_geom_idx on public.gis_raster_footprints using gist (geom);

create table public.gis_raster_footprints_sk63 (
    objectid       serial primary key,
    id             uuid   not null unique,
    object_code    text,
    title          text,
    kind           text,
    storage_url    text,
    captured_at    date,
    geom           extensions.geometry(MultiPolygon, 970634)
);
create index gis_raster_footprints_sk63_geom_idx on public.gis_raster_footprints_sk63 using gist (geom);

-- ── Refresh-функция ──────────────────────────────────────────────────────────
create or replace function public.gis_refresh() returns void
language plpgsql
as $$
begin
  truncate public.gis_plots, public.gis_plots_sk63 restart identity;
  truncate public.gis_functional_zones, public.gis_functional_zones_sk63 restart identity;
  truncate public.gis_objects, public.gis_objects_sk63 restart identity;

  -- plots (WGS84 + SK63)
  insert into public.gis_plots (
    id, code, name, role, cadastral_number, permitted_use,
    functional_zone_code, functional_name, functional_kind,
    objects_csv, objects_count, current_boundary_type, current_version,
    area_m2, polygon_count,
    load_water, load_sewer, load_storm, load_heat, load_gas, load_power, load_telecom,
    loads_summary,
    load_water_plot, load_sewer_plot, load_storm_plot, load_heat_plot, load_gas_plot, load_power_plot,
    geom
  )
  select id, code, name, role, cadastral_number, permitted_use,
    functional_zone_code, functional_name, functional_kind,
    objects_csv, objects_count, current_boundary_type, current_version,
    area_m2, polygon_count,
    load_water, load_sewer, load_storm, load_heat, load_gas, load_power, load_telecom,
    loads_summary,
    load_water_plot, load_sewer_plot, load_storm_plot, load_heat_plot, load_gas_plot, load_power_plot,
    geom_4326
  from _remote.gis_plots;

  insert into public.gis_plots_sk63 (
    id, code, name, functional_zone_code, objects_csv, area_m2,
    load_water, load_sewer, load_storm, load_heat, load_gas, load_power, loads_summary,
    geom
  )
  select id, code, name, functional_zone_code, objects_csv, area_m2,
    load_water, load_sewer, load_storm, load_heat, load_gas, load_power, loads_summary,
    geom_sk63
  from _remote.gis_plots;

  -- zones
  insert into public.gis_functional_zones (
    id, zone_code, zone_name, kind, queue, objects_csv, objects_count,
    load_water, load_sewer, load_storm, load_heat, load_gas, load_power, load_telecom,
    loads_summary, area_m2, plots_count, geom
  )
  select id, zone_code, zone_name, kind, queue, objects_csv, objects_count,
    load_water, load_sewer, load_storm, load_heat, load_gas, load_power, load_telecom,
    loads_summary, area_m2, plots_count, geom_4326
  from _remote.gis_functional_zones;

  insert into public.gis_functional_zones_sk63 (
    id, zone_code, zone_name, kind, objects_csv, loads_summary, area_m2, geom
  )
  select id, zone_code, zone_name, kind, objects_csv, loads_summary, area_m2, geom_sk63
  from _remote.gis_functional_zones;

  -- objects
  insert into public.gis_objects (
    id, code, name, contractor, color, plots_count, area_m2, geom
  )
  select id, code, name, contractor, color, plots_count, area_m2, geom_4326
  from _remote.gis_objects;

  insert into public.gis_objects_sk63 (
    id, code, name, contractor, color, plots_count, area_m2, geom
  )
  select id, code, name, contractor, color, plots_count, area_m2, geom_sk63
  from _remote.gis_objects;

  -- cadastrals
  truncate public.gis_cadastrals, public.gis_cadastrals_sk63 restart identity;
  insert into public.gis_cadastrals (
    id, cadastral_number, address, category, category_code, vri,
    ownership, ownership_raw, source, is_seizure, seizure_area_m2,
    area_declared_m2, cadastral_cost, status, active, geom
  )
  select id, cadastral_number, address, category, category_code, vri,
    ownership, ownership_raw, source, is_seizure, seizure_area_m2,
    area_declared_m2, cadastral_cost, status, active, geom_4326
  from _remote.gis_cadastrals;

  insert into public.gis_cadastrals_sk63 (
    id, cadastral_number, ownership, is_seizure, area_declared_m2, geom
  )
  select id, cadastral_number, ownership, is_seizure, area_declared_m2, geom_sk63
  from _remote.gis_cadastrals;

  -- object features: polygons / lines / points
  truncate public.gis_object_polygons, public.gis_object_polygons_sk63 restart identity;
  insert into public.gis_object_polygons (
    id, object_id, object_code, object_name, kind, name, source, valid_from, geom
  )
  select id, object_id, object_code, object_name, kind, name, source, valid_from, geom_4326
  from _remote.gis_object_polygons;

  insert into public.gis_object_polygons_sk63 (id, object_code, kind, name, geom)
  select id, object_code, kind, name, geom_sk63
  from _remote.gis_object_polygons;

  truncate public.gis_object_lines, public.gis_object_lines_sk63 restart identity;
  insert into public.gis_object_lines (
    id, object_id, object_code, object_name, kind, name, source, valid_from, geom
  )
  select id, object_id, object_code, object_name, kind, name, source, valid_from, geom_4326
  from _remote.gis_object_lines;

  insert into public.gis_object_lines_sk63 (id, object_code, kind, name, geom)
  select id, object_code, kind, name, geom_sk63
  from _remote.gis_object_lines;

  truncate public.gis_object_points, public.gis_object_points_sk63 restart identity;
  insert into public.gis_object_points (
    id, object_id, object_code, object_name, kind, name, source, valid_from, geom
  )
  select id, object_id, object_code, object_name, kind, name, source, valid_from, geom_4326
  from _remote.gis_object_points;

  insert into public.gis_object_points_sk63 (id, object_code, kind, name, geom)
  select id, object_code, kind, name, geom_sk63
  from _remote.gis_object_points;

  -- raster footprints
  truncate public.gis_raster_footprints, public.gis_raster_footprints_sk63 restart identity;
  insert into public.gis_raster_footprints (
    id, object_id, object_code, title, kind, storage_url, resolution_m,
    captured_at, z_min, z_max, z_unit, colormap, geom
  )
  select id, object_id, object_code, title, kind, storage_url, resolution_m,
    captured_at, z_min, z_max, z_unit, colormap, geom_4326
  from _remote.gis_raster_footprints;

  insert into public.gis_raster_footprints_sk63 (
    id, object_code, title, kind, storage_url, captured_at, geom
  )
  select id, object_code, title, kind, storage_url, captured_at, geom_sk63
  from _remote.gis_raster_footprints;
end;
$$;

comment on function public.gis_refresh() is
  'TRUNCATE + INSERT всех gis_* таблиц (plots/zones/objects/cadastrals/object_*/raster_*) из _remote.gis_* (через postgres_fdw).';

-- ── Гранты ───────────────────────────────────────────────────────────────────
grant select, insert, update, delete on
  public.gis_plots, public.gis_plots_sk63,
  public.gis_functional_zones, public.gis_functional_zones_sk63,
  public.gis_objects, public.gis_objects_sk63,
  public.gis_cadastrals, public.gis_cadastrals_sk63,
  public.gis_object_polygons, public.gis_object_polygons_sk63,
  public.gis_object_lines, public.gis_object_lines_sk63,
  public.gis_object_points, public.gis_object_points_sk63,
  public.gis_raster_footprints, public.gis_raster_footprints_sk63
  to arcgis_writer;
grant usage, select on all sequences in schema public to arcgis_writer;
grant execute on function public.gis_refresh() to arcgis_writer;

-- ── Заливка ──────────────────────────────────────────────────────────────────
select public.gis_refresh();
