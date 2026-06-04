-- ============================================================
-- ZPR — M:N между functional_objects (зоны ППТ) и objects (бизнес-объекты ЗПР)
-- ============================================================
--
-- ДО:  functional_objects.object_id (1:1) — у зоны только один бизнес-объект.
-- ПОСЛЕ: junction table `functional_object_objects` (M:N) — в одной зоне ППТ
--        может быть несколько объектов ЗПР (например, отель + ресторан + СПА).
--
-- Колонка `functional_objects.object_id` УДАЛЯЕТСЯ. Зависимые views и RPC
-- пересоздаются с массивами:
--   - v_plots_current.effective_object_ids uuid[]   (вместо effective_object_id uuid)
--   - v_functional_objects_full.object_ids uuid[], object_codes text[], object_names text[]
--   - RPC plots_geojson, functional_objects_geojson — массивы в properties
--
-- v_object_current_plots остаётся скаляром object_id, но через unnest junction —
-- один и тот же plot может появиться многократно (по разу на каждый связанный объект).
--
-- См. WIKI 29_Сущность_Участок.md
-- ============================================================

-- ── 1. Junction table ─────────────────────────────────────────────────────────
create table functional_object_objects (
    functional_object_id uuid not null references functional_objects(id) on delete cascade,
    object_id            uuid not null references objects(id)            on delete cascade,
    created_at           timestamptz not null default now(),
    primary key (functional_object_id, object_id)
);
create index foo_object_idx on functional_object_objects (object_id);
create index foo_fo_idx     on functional_object_objects (functional_object_id);

comment on table functional_object_objects is
  'Many-to-many связь функциональной зоны ППТ (functional_objects) с бизнес-объектами ЗПР (objects). В одной зоне может быть несколько объектов — например, отель + ресторан + СПА.';

-- ── 2. Перенос данных из старого 1:1 в M:N ───────────────────────────────────
-- На момент миграции 0 строк имеют object_id IS NOT NULL, но код безопасен.
insert into functional_object_objects (functional_object_id, object_id)
select id, object_id
  from functional_objects
 where object_id is not null
on conflict do nothing;

-- ── 3. Дропаем зависимые объекты ──────────────────────────────────────────────
drop view if exists v_object_current_plots    cascade;
drop view if exists v_functional_objects_full cascade;
drop view if exists v_plots_history           cascade;
drop view if exists v_plots_current           cascade;
drop index if exists functional_objects_object_idx;
drop index if exists functional_objects_unmapped_idx;

-- ── 4. Удаляем колонку ────────────────────────────────────────────────────────
alter table functional_objects drop column object_id;

-- ── 5. v_plots_current — effective_object_ids[] ──────────────────────────────
create view v_plots_current as
with current_assignment as (
    select distinct on (plot_id)
        plot_id,
        boundary_type      as current_boundary_type,
        version_in_type    as current_version,
        valid_from         as current_valid_from,
        source_document_id as current_source_document_id
      from plot_polygon_assignments
     where valid_to is null
     order by plot_id, valid_from desc, boundary_type desc
),
zone_objects as (
    -- список бизнес-объектов на каждую функциональную зону
    select functional_object_id, array_agg(object_id) as object_ids
      from functional_object_objects
     group by functional_object_id
)
select
    p.id                          as plot_id,
    p.object_id,
    p.functional_object_id,
    p.code,
    p.name,
    p.role,
    p.parent_plot_id,
    p.permitted_use,
    p.category,
    p.area_declared_m2,
    p.cadastral_number,
    p.source_pmt_zu,
    fo.zone_code                  as functional_zone_code,
    fo.queue                      as functional_queue,
    fo.kind                       as functional_kind,
    fo.name                       as functional_name,
    -- эффективные бизнес-объекты участка:
    --   * override через plots.object_id — если задан, имеет приоритет (массив из 1 элемента)
    --   * иначе все объекты зоны через junction
    case
      when p.object_id is not null then array[p.object_id]
      else coalesce(zo.object_ids, array[]::uuid[])
    end                           as effective_object_ids,
    ca.current_boundary_type,
    ca.current_version,
    ca.current_valid_from,
    ca.current_source_document_id,
    extensions.ST_Multi(
        extensions.ST_Collect(pp.geom_4326 order by ppa.sequence_no)
            filter (where ppa.valid_to is null)
    ) as geom_4326_multi,
    extensions.ST_Multi(
        extensions.ST_Collect(pp.geom order by ppa.sequence_no)
            filter (where ppa.valid_to is null)
    ) as geom_sk63_multi,
    sum(pp.area_calc_m2) filter (where ppa.valid_to is null)           as area_calc_m2,
    count(pp.id) filter (where ppa.valid_to is null)                   as polygon_count
from plots p
left join functional_objects fo on fo.id = p.functional_object_id
left join zone_objects zo       on zo.functional_object_id = p.functional_object_id
left join current_assignment ca on ca.plot_id = p.id
left join plot_polygon_assignments ppa on ppa.plot_id = p.id
left join plot_polygons pp on pp.id = ppa.polygon_id
where p.active = true
group by p.id, fo.zone_code, fo.queue, fo.kind, fo.name, zo.object_ids,
         ca.current_boundary_type, ca.current_version, ca.current_valid_from, ca.current_source_document_id;

comment on view v_plots_current is
  'Актуальные участки с multi-part геометрией. effective_object_ids — массив бизнес-объектов ЗПР (через plots.object_id override или через зону, M:N).';

-- ── 6. v_plots_history (без изменений в логике, просто пересоздаём после drop) ──
create view v_plots_history as
select
    p.id as plot_id, p.code, p.name,
    ppa.boundary_type, ppa.version_in_type,
    ppa.source_document_id, d.title as document_title, d.version as document_version,
    ppa.valid_from, ppa.valid_to,
    ppa.ring_role, ppa.sequence_no,
    pp.id as polygon_id,
    pp.area_calc_m2, pp.point_count,
    ppa.note
from plots p
join plot_polygon_assignments ppa on ppa.plot_id = p.id
join plot_polygons pp on pp.id = ppa.polygon_id
left join documents d on d.id = ppa.source_document_id
order by p.code, ppa.boundary_type, ppa.valid_from desc;

comment on view v_plots_history is
  'Таймлайн всех версий границ участков.';

-- ── 7. v_functional_objects_full — массивы object_ids/codes/names ─────────────
create view v_functional_objects_full as
with bound_objects as (
    select
      foo.functional_object_id,
      array_agg(o.id    order by o.code) as object_ids,
      array_agg(o.code  order by o.code) as object_codes,
      array_agg(o.current_name order by o.code) as object_names
    from functional_object_objects foo
    join objects o on o.id = foo.object_id
    group by foo.functional_object_id
)
select
    fo.id                       as functional_object_id,
    fo.zone_code,
    fo.queue,
    fo.kind,
    fo.name                     as functional_name,
    coalesce(bo.object_ids,   array[]::uuid[]) as object_ids,
    coalesce(bo.object_codes, array[]::text[]) as object_codes,
    coalesce(bo.object_names, array[]::text[]) as object_names,
    fo.source_pmt_object_name,
    count(p.id)                 as plot_count,
    array_agg(p.code order by p.code) filter (where p.id is not null) as plot_codes,
    sum(p.area_declared_m2)     as total_area_declared_m2,
    fo.source_document_id,
    fo.active
from functional_objects fo
left join bound_objects bo on bo.functional_object_id = fo.id
left join plots p on p.functional_object_id = fo.id and p.active = true
where fo.active = true
group by fo.id, bo.object_ids, bo.object_codes, bo.object_names;

comment on view v_functional_objects_full is
  'Функциональные объекты ППТ + сводка по plots + массивы бизнес-объектов ЗПР (M:N через functional_object_objects).';

-- ── 8. v_object_current_plots — JOIN через unnest, плот может повторяться ─────
create view v_object_current_plots as
select
    o.id          as object_id,
    o.code        as object_code,
    o.current_name as object_name,
    vpc.plot_id,
    vpc.code      as plot_code,
    vpc.name      as plot_name,
    vpc.functional_zone_code, vpc.functional_kind, vpc.functional_name,
    vpc.current_boundary_type, vpc.current_version, vpc.current_valid_from,
    vpc.area_declared_m2, vpc.area_calc_m2, vpc.polygon_count,
    vpc.geom_4326_multi
from objects o
join v_plots_current vpc on o.id = any(vpc.effective_object_ids)
where o.active = true;

comment on view v_object_current_plots is
  'Все участки бизнес-объекта ЗПР (через plots.object_id override или через зоны ППТ M:N). Один plot может появиться для нескольких объектов одной зоны.';

-- ── 9. Пересоздаём RPC plots_geojson с массивами в properties ─────────────────
create or replace function public.plots_geojson(p_role text default 'all')
returns jsonb
language sql
stable
as $$
  with oks_per_zone as (
    select
      zone_code,
      jsonb_agg(
        jsonb_build_object(
          'name',       object_name,
          'etazh_max',  etazh_max,
          'queue',      queue,
          'status',     status_code,
          'value',      value_code
        )
        order by id
      ) as oks_list
    from pmt_oks
    where zone_code is not null
    group by zone_code
  ),
  enriched as (
    select
      v.plot_id,
      v.code               as plot_code,
      v.name               as plot_name,
      v.role,
      v.permitted_use,
      v.category,
      v.area_declared_m2,
      v.area_calc_m2,
      v.polygon_count,
      v.functional_zone_code,
      v.functional_queue,
      v.functional_kind,
      v.functional_name,
      v.effective_object_ids,
      -- Список объектов как JSONB-массив со всеми их атрибутами для UI
      (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id',           o.id,
            'code',         o.code,
            'name',         o.current_name,
            'color',        o.color,
            'icon',         o.icon
          ) order by o.code
        ), '[]'::jsonb)
        from unnest(v.effective_object_ids) as oid
        join objects o on o.id = oid
      ) as objects,
      oks.oks_list,
      v.geom_4326_multi    as geom
    from v_plots_current v
    left join oks_per_zone oks on oks.zone_code = v.functional_zone_code
    where v.geom_4326_multi is not null
      and (p_role = 'all' or v.role::text = p_role)
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature',
      'id', plot_code,
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'plot_id',                plot_id,
        'plot_code',              plot_code,
        'plot_name',              plot_name,
        'role',                   role,
        'permitted_use',          permitted_use,
        'category',               category,
        'area_declared_m2',       area_declared_m2,
        'area_calc_m2',           area_calc_m2,
        'polygon_count',          polygon_count,
        'functional_zone_code',   functional_zone_code,
        'functional_queue',       functional_queue,
        'functional_kind',        functional_kind,
        'functional_name',        functional_name,
        'effective_object_ids',   to_jsonb(effective_object_ids),
        'objects',                coalesce(objects, '[]'::jsonb),
        'oks',                    coalesce(oks_list, '[]'::jsonb)
      )
    ) as feature
    from enriched
    where ST_IsValid(geom)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb)
  )
  from features;
$$;

comment on function public.plots_geojson(text)
  is 'GeoJSON FeatureCollection земельных участков из v_plots_current с обогащением. properties.objects — массив {id,code,name,color,icon} бизнес-объектов ЗПР (M:N через functional_object_objects + plots.object_id override). EPSG:4326.';

grant execute on function public.plots_geojson(text) to anon, authenticated, service_role;

-- ── 10. RPC functional_objects_geojson — массив objects ───────────────────────
create or replace function public.functional_objects_geojson(p_kind text default 'all')
returns jsonb
language sql
stable
as $$
  with zone_params as (
    select
      zone_code,
      jsonb_build_object(
        'area_m2',     area_m2,
        'k_otn',       k_otn,
        'k_isp',       k_isp,
        'k_oz_pct',    k_oz_pct,
        'k_det_pct',   k_det_pct,
        'k_vzr_pct',   k_vzr_pct,
        'k_mm',        k_mm,
        'etazh_max',   etazh_max
      ) as params
    from pmt_zone_params
  ),
  oks_per_zone as (
    select
      zone_code,
      jsonb_agg(
        jsonb_build_object(
          'name',       object_name,
          'etazh_max',  etazh_max,
          'queue',      queue,
          'status',     status_code,
          'value',      value_code
        )
        order by id
      ) as oks_list
    from pmt_oks
    where zone_code is not null
    group by zone_code
  ),
  zone_objects as (
    select
      foo.functional_object_id,
      jsonb_agg(
        jsonb_build_object(
          'id',    o.id,
          'code',  o.code,
          'name',  o.current_name,
          'color', o.color,
          'icon',  o.icon
        ) order by o.code
      ) as objects
    from functional_object_objects foo
    join objects o on o.id = foo.object_id
    group by foo.functional_object_id
  ),
  zone_geom as (
    select
      fo.id                                   as functional_object_id,
      fo.zone_code,
      fo.queue,
      fo.kind,
      fo.name                                 as zone_name,
      ST_Multi(ST_Union(pp.geom_4326))        as geom,
      sum(pp.area_calc_m2)                    as area_calc_m2,
      count(distinct p.id)                    as plots_count,
      array_agg(distinct p.code order by p.code) as plot_codes
    from functional_objects fo
    join plots p                              on p.functional_object_id = fo.id and p.active = true
    join plot_polygon_assignments ppa         on ppa.plot_id = p.id and ppa.valid_to is null
    join plot_polygons pp                     on pp.id = ppa.polygon_id
    where fo.active = true
      and (p_kind = 'all' or fo.kind::text = p_kind)
    group by fo.id
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature',
      'id', zg.zone_code,
      'geometry', ST_AsGeoJSON(zg.geom)::jsonb,
      'properties', jsonb_build_object(
        'functional_object_id', zg.functional_object_id,
        'zone_code',            zg.zone_code,
        'zone_name',            zg.zone_name,
        'queue',                zg.queue,
        'kind',                 zg.kind,
        'objects',              coalesce(zo.objects, '[]'::jsonb),
        'plots_count',          zg.plots_count,
        'plot_codes',           to_jsonb(zg.plot_codes),
        'area_calc_m2',         zg.area_calc_m2,
        'zone_params',          zp.params,
        'oks',                  coalesce(oks.oks_list, '[]'::jsonb)
      )
    ) as feature
    from zone_geom zg
    left join zone_objects zo  on zo.functional_object_id = zg.functional_object_id
    left join zone_params zp   on zp.zone_code = zg.zone_code
    left join oks_per_zone oks on oks.zone_code = zg.zone_code
    where zg.geom is not null and ST_IsValid(zg.geom)
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb)
  )
  from features;
$$;

comment on function public.functional_objects_geojson(text)
  is 'GeoJSON FeatureCollection функциональных зон ППТ. properties.objects — массив {id,code,name,color,icon} бизнес-объектов ЗПР (M:N через functional_object_objects). EPSG:4326.';

grant execute on function public.functional_objects_geojson(text) to anon, authenticated, service_role;

-- ── 11. RLS на junction ───────────────────────────────────────────────────────
alter table functional_object_objects enable row level security;

create policy foo_select on functional_object_objects for select using (true);
create policy foo_admin_all on functional_object_objects for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- ── 12. Grant для роли arcgis_writer ──────────────────────────────────────────
grant select, insert, update, delete on functional_object_objects to arcgis_writer;
