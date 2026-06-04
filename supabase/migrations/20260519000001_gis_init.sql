-- ============================================================
-- ZPR — GIS-инициализация (этап 1)
-- ============================================================
-- 1. PostGIS в схему extensions
-- 2. SRID 970634 = Pulkovo 1942 / СК-63 zone X4 (Саки)
-- 3. ENUM geometry_kind
-- 4. object_geometries (источник истины — СК-63; geom_4326 — generated для web)
-- 5. object_geometry_revisions + триггер аудита
-- 6. utility_loads — нагрузки сетей
-- 7. raster_layers, mesh_assets — заделы под GeoTIFF и Mesh
-- 8. Роль arcgis_writer (BYPASSRLS, прямое подключение из ArcGIS Pro)
-- 9. RLS-политики на новые таблицы в стиле проекта
--
-- ВАЖНО: пользователи ЗПР живут в auth.users (Supabase Auth) — не дублируется здесь.
-- Имена авторов правок (created_by, changed_by) хранятся как email (text).
-- ============================================================

-- Сброс (для повторного применения).
-- Триггер удаляется каскадно вместе с таблицей object_geometries.
drop function if exists fn_object_geometries_audit() cascade;
drop table    if exists utility_loads             cascade;
drop table    if exists object_geometry_revisions cascade;
drop table    if exists object_geometries         cascade;
drop table    if exists raster_layers             cascade;
drop table    if exists mesh_assets               cascade;
drop type     if exists geometry_kind             cascade;

-- ============================================================
-- 1. PostGIS extension
-- ============================================================
create extension if not exists postgis with schema extensions;

-- ============================================================
-- 2. SRID 970634 — Pulkovo 1942 / СК-63 zone X4 (Саки)
-- ============================================================
-- Параметры взяты из ArcGIS Pro Coordinate System Details:
--   Projection: Transverse Mercator
--   Central Meridian: 32.5°, Latitude Of Origin: 0°
--   False Easting: 4 300 000, False Northing: -9 214.69
--   Scale Factor: 1.0
--   GCS: Pulkovo 1942 (Krassowsky 1940, a=6378245, 1/f=298.3)
-- towgs84 — ГОСТ 32453-2017 (Pulkovo 1942 → WGS84, точность ~2 м)
insert into spatial_ref_sys (srid, auth_name, auth_srid, proj4text, srtext) values (
  970634, 'ZPR', 970634,
  '+proj=tmerc +lat_0=0 +lon_0=32.5 +k=1 +x_0=4300000 +y_0=-9214.69 '
  '+ellps=krass +towgs84=23.92,-141.27,-80.9,0,0.35,0.82,-0.12 +units=m +no_defs',
  'PROJCS["Pulkovo_1942_CS63_zone_X4_RUS",'
   'GEOGCS["GCS_Pulkovo_1942",'
     'DATUM["D_Pulkovo_1942",SPHEROID["Krassowsky_1940",6378245.0,298.3]],'
     'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
   'PROJECTION["Transverse_Mercator"],'
   'PARAMETER["False_Easting",4300000.0],'
   'PARAMETER["False_Northing",-9214.69],'
   'PARAMETER["Central_Meridian",32.5],'
   'PARAMETER["Scale_Factor",1.0],'
   'PARAMETER["Latitude_Of_Origin",0.0],'
   'UNIT["Meter",1.0]]'
) on conflict (srid) do nothing;

-- ============================================================
-- 3. ENUM geometry_kind
-- ============================================================
create type geometry_kind as enum (
    'plot',          -- межевой участок
    'building',      -- контур здания (проектное пятно)
    'road',          -- ось дороги
    'utility_line',  -- инженерная сеть (линия)
    'utility_node',  -- узел сети (КТП, колодец, скважина)
    'zone',          -- функциональная / охранная зона
    'point',         -- репер, контрольная точка
    'other'
);

-- ============================================================
-- 4. object_geometries — источник истины геометрии в СК-63 z4
-- ============================================================
create table object_geometries (
    id           uuid primary key default gen_random_uuid(),
    object_id    uuid not null references objects(id) on delete cascade,
    kind         geometry_kind not null,
    name         text,
    geom         geometry(Geometry, 970634) not null
                 check (ST_IsValid(geom)),
    geom_4326    geometry(Geometry, 4326)
                 generated always as (ST_Transform(geom, 4326)) stored,
    properties   jsonb not null default '{}',
    source       text not null default 'arcgis'
                 check (source in ('arcgis', 'tabular_import', 'manual', 'seed')),
    valid_from   timestamptz not null default now(),
    valid_to     timestamptz,
    created_by   text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index on object_geometries using gist (geom);
create index on object_geometries using gist (geom_4326);
create index on object_geometries (object_id);
create index on object_geometries (object_id) where valid_to is null;
create index on object_geometries using gin (properties jsonb_path_ops);
create index on object_geometries using brin (valid_from);

comment on table  object_geometries is 'Геометрия объектов ЗПР. Источник истины — geom в СК-63 z4 (SRID 970634).';
comment on column object_geometries.geom is 'Геометрия в исходной СК-63 zone X4 (SRID 970634). Источник истины.';
comment on column object_geometries.geom_4326 is 'Автогенерируемая копия в WGS84 для веб-карты. Не редактировать.';
comment on column object_geometries.kind is 'Тип геометрии (см. ENUM geometry_kind).';
comment on column object_geometries.properties is 'Произвольные атрибуты per kind (кадастровый номер, материал, мощность и т.п.).';
comment on column object_geometries.source is 'Откуда пришла геометрия: arcgis (правка), tabular_import (CSV/XLSX), manual, seed.';
comment on column object_geometries.valid_to is 'Если NULL — запись актуальна. Иначе — заменена новой версией.';

-- ============================================================
-- 6. object_geometry_revisions — audit log с подписанием reason
-- ============================================================
create table object_geometry_revisions (
    id              uuid primary key default gen_random_uuid(),
    geometry_id     uuid not null,
    object_id       uuid not null,
    kind            geometry_kind not null,
    name            text,
    geom            geometry(Geometry, 970634) not null,
    properties      jsonb not null,
    operation       text not null check (operation in ('insert', 'update', 'delete')),
    reason          text,
    signed_by       text,
    signed_at       timestamptz,
    changed_by      text not null,
    changed_at      timestamptz not null default now()
);

create index on object_geometry_revisions (geometry_id, changed_at desc);
create index on object_geometry_revisions (object_id, changed_at desc);
create index on object_geometry_revisions (changed_at desc) where reason is null;

comment on table object_geometry_revisions is
  'История правок геометрии. Заполняется триггером. Reason подписывается оператором через UI.';
comment on column object_geometry_revisions.changed_by is
  'session_user БД на момент правки (admin / arcgis_writer / service_role).';
comment on column object_geometry_revisions.reason is
  'Причина правки. Заполняется ретроспективно через /admin/geometry-pending-reasons.';

-- ============================================================
-- 7. Триггер аудита (SECURITY DEFINER, без рекурсии)
-- ============================================================
create or replace function fn_object_geometries_audit() returns trigger
language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    insert into object_geometry_revisions
      (geometry_id, object_id, kind, name, geom, properties, operation, changed_by)
    values (new.id, new.object_id, new.kind, new.name, new.geom, new.properties,
            'insert', session_user);
    return new;
  elsif tg_op = 'UPDATE' then
    if old.geom is distinct from new.geom
       or old.properties is distinct from new.properties
       or old.kind <> new.kind
       or old.name is distinct from new.name then
      insert into object_geometry_revisions
        (geometry_id, object_id, kind, name, geom, properties, operation, changed_by)
      values (old.id, old.object_id, old.kind, old.name, old.geom, old.properties,
              'update', session_user);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    insert into object_geometry_revisions
      (geometry_id, object_id, kind, name, geom, properties, operation, changed_by)
    values (old.id, old.object_id, old.kind, old.name, old.geom, old.properties,
            'delete', session_user);
    return old;
  end if;
  return null;
end$$;

create trigger tr_object_geometries_audit
  after insert or update or delete on object_geometries
  for each row execute function fn_object_geometries_audit();

-- ============================================================
-- 8. utility_loads — нагрузки сетей (для utility_line / utility_node)
-- ============================================================
create table utility_loads (
    id           uuid primary key default gen_random_uuid(),
    geometry_id  uuid not null references object_geometries(id) on delete cascade,
    consumer     text not null,
    network      text not null check (network in
                   ('power', 'water', 'sewer', 'gas', 'heat', 'telecom', 'storm')),
    load_value   numeric not null,
    load_unit    text not null,
    peak_factor  numeric,
    note         text,
    source_doc   text,
    created_at   timestamptz not null default now()
);

create index on utility_loads (geometry_id);

comment on table  utility_loads is 'Нагрузки инженерных сетей (мощности, расходы).';
comment on column utility_loads.consumer is 'Объект-потребитель: здание, участок, иной потребитель.';
comment on column utility_loads.load_unit is 'kW, m3_day, Gcal_h, Mbit_s, m3_h …';

-- ============================================================
-- 9. raster_layers — метаданные растровых слоёв (GeoTIFF)
-- ============================================================
create table raster_layers (
    id            uuid primary key default gen_random_uuid(),
    object_id     uuid references objects(id) on delete set null,
    title         text not null,
    kind          text not null default 'aerial'
                  check (kind in ('aerial', 'dem', 'bathymetry', 'plan_scan', 'other')),
    storage_url   text not null,
    bbox          geometry(Polygon, 970634),
    bbox_wgs84    geometry(Polygon, 4326)
                  generated always as (ST_Transform(bbox, 4326)) stored,
    z_min         numeric,
    z_max         numeric,
    z_unit        text default 'm',
    colormap      text default 'terrain',
    resolution_m  numeric,
    captured_at   date,
    created_at    timestamptz not null default now()
);

create index on raster_layers using gist (bbox_wgs84);

comment on table  raster_layers is 'Метаданные GeoTIFF (DEM, батиметрия, ортофото). Сами файлы — вне БД.';
comment on column raster_layers.storage_url is 'Путь к COG (Cloud Optimized GeoTIFF) в Storage / на диске.';

-- ============================================================
-- 10. mesh_assets — заделы под Mesh-данные (этап 2)
-- ============================================================
create table mesh_assets (
    id           uuid primary key default gen_random_uuid(),
    object_id    uuid references objects(id) on delete set null,
    title        text not null,
    storage_url  text not null,
    format       text not null,
    bbox         geometry(Polygon, 970634),
    point_count  bigint,
    captured_at  date,
    note         text,
    created_at   timestamptz not null default now()
);

comment on table mesh_assets is 'Placeholder для Mesh-моделей подрядчиков (OBJ, PLY, LAS, E57). Реализация — этап 2.';

-- ============================================================
-- 11. Postgres-роль arcgis_writer (прямое подключение из ArcGIS Pro)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'arcgis_writer') then
    create role arcgis_writer login password 'arcgis_dev_pass' bypassrls;
  end if;
end$$;

grant usage on schema public, extensions to arcgis_writer;
grant select on objects, contractors, contract_milestones, documents, letters,
                folders, utility_loads, raster_layers, mesh_assets to arcgis_writer;
grant select, insert, update, delete on object_geometries to arcgis_writer;
grant select, insert on object_geometry_revisions to arcgis_writer;

comment on role arcgis_writer is
  'Технический пользователь для ArcGIS Pro. BYPASSRLS — прямое подключение по TCP, не через REST.';

-- ============================================================
-- 12. RLS — Row Level Security
-- ============================================================
alter table object_geometries         enable row level security;
alter table object_geometry_revisions enable row level security;
alter table utility_loads             enable row level security;
alter table raster_layers             enable row level security;
alter table mesh_assets               enable row level security;

-- object_geometries: всем чтение, INSERT/UPDATE — admin
create policy "og_select"           on object_geometries for select using (true);
create policy "og_admin_insert"     on object_geometries for insert
  with check (public.user_role() = 'admin');
create policy "og_admin_update"     on object_geometries for update
  using (public.user_role() = 'admin');

-- object_geometry_revisions: всем чтение, UPDATE (подписание reason) — admin.
-- INSERT идёт только через триггер (SECURITY DEFINER обходит RLS).
create policy "ogr_select"          on object_geometry_revisions for select using (true);
create policy "ogr_admin_sign"      on object_geometry_revisions for update
  using (public.user_role() = 'admin');

-- utility_loads: чтение всем, правка — admin
create policy "ul_select"           on utility_loads for select using (true);
create policy "ul_admin_write"      on utility_loads for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- raster_layers
create policy "rl_select"           on raster_layers for select using (true);
create policy "rl_admin_write"      on raster_layers for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- mesh_assets
create policy "ma_select"           on mesh_assets for select using (true);
create policy "ma_admin_write"      on mesh_assets for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');
