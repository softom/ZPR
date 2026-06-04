-- ============================================================
-- ZPR — Иерархия участков: container_plot_id (геометрическое включение)
-- ============================================================
-- Концепция: в ПМТ функциональная зона часто натягивается на один большой
-- кадастровый участок-«контейнер», который физически нарезан на несколько
-- внутренних кадастровых ЗУ. Пример: зона Г-1.4 = :ЗУ149 (22 300 м²), внутри
-- :ЗУ67 (12 540) + :ЗУ103 (9 760) = 22 300.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Существующее поле plots.parent_plot_id зарезервировано под сервитуты и
-- частичные участки (триггер plots_validate_parent ограничивает его роль
-- значениями 'servitude'/'partial'). Семантика «контейнер ↔ внутренний
-- кадастровый ЗУ» — другая: оба участника имеют role='plot' (кадастровые
-- юнита), один просто физически шире и содержит другой.
--
-- Поэтому заводим новое отдельное поле plots.container_plot_id (не путать с
-- parent_plot_id). Никаких ограничений по role на participants — может быть
-- любой active plot.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Эта миграция:
--   1. ALTER TABLE plots ADD COLUMN container_plot_id (+ индекс).
--   2. Функция recalc_plot_containers() — для каждого активного plot
--      находит МИНИМАЛЬНОГО по площади контейнера через ST_CoveredBy.
--      Сервитуты как родители отбрасываются (полосы, не контейнеры).
--   3. Одноразовый прогон для текущего состояния БД.
--   4. Пересоздаёт v_plots_current — добавляет:
--        container_plot_id, container_plot_code, is_container, child_count
--   5. Восстанавливает зависимые view (v_object_current_plots, gis_objects).
--   6. Расширяет RPC plots_geojson — те же поля в properties.
--
-- Семантика для UI:
--   • Привязка ОКС к контейнеру = объект сидит «во всей зоне».
--   • Привязка ОКС к внутреннему ЗУ = объект на конкретной нарезке.
--   • Если у внутреннего plot нет functional_zone_code — UI наследует код
--     от контейнера через container_plot_code.
-- ============================================================

-- ── 1. Колонка container_plot_id ──────────────────────────────────────────
alter table plots
  add column if not exists container_plot_id uuid
    references plots(id) on delete set null;

create index if not exists plots_container_idx
  on plots(container_plot_id)
  where container_plot_id is not null;

comment on column plots.container_plot_id is
  'Контейнерный участок (parent), который геометрически полностью содержит этот plot. Для кадастровых нарезок: контейнер = большой ЗУ, на который ППТ натянул функциональную зону. NULL = top-level. Заполняется функцией recalc_plot_containers(). НЕ путать с parent_plot_id (тот для сервитутов/частей).';

-- ── 2. Функция автозаполнения container_plot_id ──────────────────────────
create or replace function public.recalc_plot_containers(
  p_threshold_ratio numeric default 1.001  -- контейнер строго > ребёнка по площади
)
returns table (
  child_code      text,
  container_code  text,
  child_area_m2   numeric,
  container_area_m2 numeric
)
language plpgsql
as $$
#variable_conflict use_column
begin
  -- Чистим существующие container_plot_id для пересчёта.
  update plots set container_plot_id = null where active = true;

  return query
  with candidates as (
    select
      child.plot_id  as child_id,
      child.code     as child_code,
      child.area_calc_m2 as child_area,
      parent.plot_id as container_id,
      parent.code    as container_code,
      parent.area_calc_m2 as container_area,
      row_number() over (
        partition by child.plot_id
        order by parent.area_calc_m2 asc  -- ближайший контейнер = минимальный
      ) as rn
    from v_plots_current child
    join v_plots_current parent
      on parent.plot_id <> child.plot_id
     and parent.role::text <> 'servitude'
     and parent.area_calc_m2 > child.area_calc_m2 * p_threshold_ratio
     and extensions.ST_CoveredBy(child.geom_sk63_multi, parent.geom_sk63_multi)
    where child.geom_sk63_multi is not null
  ),
  picked as (
    select child_id, container_id, child_code, container_code, child_area, container_area
      from candidates where rn = 1
  ),
  updated as (
    update plots p
       set container_plot_id = pk.container_id,
           updated_at        = now()
      from picked pk
     where p.id = pk.child_id
     returning pk.child_code, pk.container_code, pk.child_area, pk.container_area
  )
  select u.child_code, u.container_code, u.child_area, u.container_area
    from updated u
   order by u.child_code;
end;
$$;

comment on function public.recalc_plot_containers(numeric) is
  'Автозаполнение plots.container_plot_id через ST_CoveredBy. Запускать после массовой загрузки или пересчёта полигонов. Возвращает таблицу проставленных пар (child → container).';

-- ── 3. Одноразовый прогон ────────────────────────────────────────────────
do $$
declare v_rows int;
begin
  perform * from public.recalc_plot_containers();
  get diagnostics v_rows = row_count;
  raise notice 'recalc_plot_containers: % container links written', v_rows;
end $$;

-- ── 4. Пересоздание v_plots_current ──────────────────────────────────────
drop view if exists gis_objects             cascade;
drop view if exists v_object_current_plots  cascade;
drop view if exists v_plots_current         cascade;

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
    select functional_object_id, array_agg(object_id) as object_ids
      from functional_object_objects
     group by functional_object_id
),
child_stats as (
    select container_plot_id as plot_id, count(*) as child_count
      from plots
     where container_plot_id is not null and active = true
     group by container_plot_id
)
select
    p.id                          as plot_id,
    p.object_id,
    p.functional_object_id,
    p.code,
    p.name,
    p.role,
    p.parent_plot_id,
    p.container_plot_id,
    cont.code                     as container_plot_code,
    coalesce(cs.child_count, 0) > 0 as is_container,
    coalesce(cs.child_count, 0)::int as child_count,
    p.permitted_use,
    p.category,
    p.area_declared_m2,
    p.cadastral_number,
    p.source_pmt_zu,
    fo.zone_code                  as functional_zone_code,
    fo.queue                      as functional_queue,
    fo.kind                       as functional_kind,
    fo.name                       as functional_name,
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
left join plots cont            on cont.id = p.container_plot_id
left join functional_objects fo on fo.id   = p.functional_object_id
left join zone_objects zo       on zo.functional_object_id = p.functional_object_id
left join current_assignment ca on ca.plot_id = p.id
left join child_stats cs        on cs.plot_id = p.id
left join plot_polygon_assignments ppa on ppa.plot_id = p.id
left join plot_polygons pp on pp.id = ppa.polygon_id
where p.active = true
group by p.id, cont.code, cs.child_count,
         fo.zone_code, fo.queue, fo.kind, fo.name, zo.object_ids,
         ca.current_boundary_type, ca.current_version, ca.current_valid_from, ca.current_source_document_id;

comment on view v_plots_current is
  'Актуальные участки с multi-part геометрией. effective_object_ids[] (M:N через зону или override через plots.object_id). container_plot_code/is_container/child_count — иерархия «контейнер→внутренние» (см. 29_Сущность_Участок).';

-- ── 5. Восстановление зависимых views ────────────────────────────────────
create view v_object_current_plots as
select
    o.id            as object_id,
    o.code          as object_code,
    o.current_name  as object_name,
    vpc.plot_id,
    vpc.code        as plot_code,
    vpc.name        as plot_name,
    vpc.functional_zone_code,
    vpc.functional_kind,
    vpc.functional_name,
    vpc.current_boundary_type,
    vpc.current_version,
    vpc.current_valid_from,
    vpc.area_declared_m2,
    vpc.area_calc_m2,
    vpc.polygon_count,
    vpc.geom_4326_multi
from objects o
join v_plots_current vpc on o.id = any (vpc.effective_object_ids)
where o.active = true;

comment on view v_object_current_plots is
  'Все участки одного бизнес-объекта ЗПР (через effective_object_ids[]: прямой plots.object_id ИЛИ через зону M:N).';

create view gis_objects as
with obj_plots as (
    select obj_id.obj_id as object_id,
           v.plot_id,
           v.geom_4326_multi as geom_4326,
           v.geom_sk63_multi as geom_sk63,
           v.area_calc_m2
      from v_plots_current v,
           lateral unnest(v.effective_object_ids) obj_id(obj_id)
     where v.geom_4326_multi is not null
),
obj_geom as (
    select object_id,
           extensions.ST_Multi(extensions.ST_Union(geom_4326)) as geom_4326,
           extensions.ST_Multi(extensions.ST_Union(geom_sk63)) as geom_sk63,
           sum(area_calc_m2)                  as area_m2,
           count(distinct plot_id)::int       as plots_count
      from obj_plots
     group by object_id
)
select row_number() over (order by o.code)::int as objectid,
       o.id,
       o.code,
       o.current_name  as name,
       o.contractor,
       o.color,
       coalesce(og.plots_count, 0)        as plots_count,
       coalesce(og.area_m2, 0::numeric)   as area_m2,
       og.geom_4326,
       og.geom_sk63
  from objects o
  left join obj_geom og on og.object_id = o.id
 where o.active = true and og.geom_4326 is not null;

comment on view gis_objects is
  'Свёртка бизнес-объектов ЗПР с геометрией: union полигонов всех участков, помеченных как effective. Для ArcGIS-feature service.';

-- ── 6. RPC plots_geojson — расширение properties ──────────────────────────
create or replace function public.plots_geojson(p_role text default 'all')
returns jsonb
language sql
stable
as $$
  with oks_per_zone as (
    select zone_code,
      jsonb_agg(jsonb_build_object(
        'name', object_name, 'etazh_max', etazh_max, 'queue', queue,
        'status', status_code, 'value', value_code
      ) order by id) as oks_list
    from pmt_oks where zone_code is not null group by zone_code
  ),
  enriched as (
    select
      v.plot_id, v.code as plot_code, v.name as plot_name, v.role,
      v.permitted_use, v.category, v.area_declared_m2, v.area_calc_m2, v.polygon_count,
      v.functional_zone_code, v.functional_queue, v.functional_kind, v.functional_name,
      v.effective_object_ids,
      v.container_plot_id, v.container_plot_code, v.is_container, v.child_count,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', o.id, 'code', o.code, 'name', o.current_name,
          'color', o.color, 'icon', o.icon
        ) order by o.code), '[]'::jsonb)
        from unnest(v.effective_object_ids) as oid
        join objects o on o.id = oid
      ) as objects,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', mo.id, 'code', mo.code, 'queue', mo.queue,
          'name_ppt', mo.name_ppt, 'name_contract', mo.name_contract
        ) order by mo.code), '[]'::jsonb)
        from masterplan_object_plots mop
        join masterplan_objects mo on mo.id = mop.masterplan_object_id
        where mop.plot_id = v.plot_id and mo.active = true
      ) as masterplan_objects,
      oks.oks_list,
      v.geom_4326_multi as geom
    from v_plots_current v
    left join oks_per_zone oks on oks.zone_code = v.functional_zone_code
    where v.geom_4326_multi is not null
      and (p_role = 'all' or v.role::text = p_role)
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature',
      'id', plot_code,
      'geometry', extensions.ST_AsGeoJSON(geom)::jsonb,
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
        'container_plot_id',      container_plot_id,
        'container_plot_code',    container_plot_code,
        'is_container',           is_container,
        'child_count',            child_count,
        'objects',                coalesce(objects, '[]'::jsonb),
        'masterplan_objects',     coalesce(masterplan_objects, '[]'::jsonb),
        'oks',                    coalesce(oks_list, '[]'::jsonb)
      )
    ) as feature
    from enriched
    where extensions.ST_IsValid(geom)
  )
  select jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  from features;
$$;

comment on function public.plots_geojson(text) is
  'GeoJSON FeatureCollection участков с иерархией (container_plot_code/is_container/child_count) и связями (objects[]/masterplan_objects[]). EPSG:4326.';
