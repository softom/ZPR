-- ============================================================
-- ZPR — Целевая модель: Кадастровые участки (cadastrals)
-- ============================================================
-- Агрегация данных из pmt_cadastrals (Том 4.2) + pmt_cadastrals_pmt_t1 (Том 3.2)
-- + обогащение из pmt_stage1_izyatie (изъятие) и pmt_vri_changes (смена ВРИ).
--
-- Связь с plots — M:N через plot_cadastrals:
--   - один исходный КУ может быть разделён на несколько образуемых ЗУ
--   - один образуемый ЗУ может быть сформирован из частей нескольких КУ
-- ============================================================

-- ── 1. Тип собственности (enum) ────────────────────────────────────────────────
create type public.cadastral_ownership as enum (
  'private',          -- Частная
  'municipal',        -- Муниципальная
  'state_subject',    -- Государственная субъекта РФ
  'state_federal',    -- Государственная федеральная
  'mixed',            -- Совместная (несколько типов)
  'unknown'           -- Не указано / прочерк
);

-- ── 2. Таблица cadastrals ──────────────────────────────────────────────────────
create table public.cadastrals (
  id              uuid primary key default gen_random_uuid(),
  cadastral_number text not null unique,      -- формат 90:18:XXXXXX:YYYY
  address         text,
  category        text,                       -- категория земель (текст из ЕГРН)
  vri             text,                       -- вид разрешённого использования
  ownership_raw   text,                       -- оригинал из ПМТ (может быть ";"-separated)
  ownership       cadastral_ownership not null default 'unknown',
  area_m2         numeric,                    -- площадь по ЕГРН
  status          text,                       -- статус (из pmt_cadastrals)

  -- Изъятие (Stage 1)
  is_seizure      boolean not null default false,
  seizure_area_m2 numeric,                    -- площадь изъятия (может быть < area_m2)
  seizure_dpt_no  text,                       -- номер ДПТ
  seizure_note    text,                       -- примечание
  seizure_building_kn  text,                  -- КН здания на участке (если есть)
  seizure_building_area text,                 -- площадь здания

  -- Смена ВРИ (из pmt_vri_changes)
  vri_changes     jsonb,                      -- [{stage, category_old, category_new, vri_old, vri_new}]

  -- Источник
  source_page     integer,                    -- страница документа ПМТ
  source_id       text,                       -- ID источника (Том)

  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_cadastrals_ownership on cadastrals(ownership);
create index idx_cadastrals_seizure on cadastrals(is_seizure) where is_seizure = true;

comment on table public.cadastrals
  is 'Исходные кадастровые участки на территории проекта. Агрегация из pmt_cadastrals (Том 4.2) + pmt_stage1_izyatie + pmt_vri_changes.';

-- ── 3. Junction: plot_cadastrals (M:N) ─────────────────────────────────────────
create table public.plot_cadastrals (
  plot_id       uuid not null references plots(id) on delete cascade,
  cadastral_id  uuid not null references cadastrals(id) on delete cascade,
  primary key (plot_id, cadastral_id)
);

create index idx_plot_cadastrals_cad on plot_cadastrals(cadastral_id);

comment on table public.plot_cadastrals
  is 'M:N связь: образуемый ЗУ ↔ исходный кадастровый участок.';

-- ── 4. Заполнение из pmt_cadastrals ────────────────────────────────────────────
insert into cadastrals (
  cadastral_number, address, category, vri, ownership_raw, ownership,
  area_m2, status, source_page, source_id
)
select
  c.cadastral,
  c.address,
  c.category,
  c.vri,
  c.ownership,
  case
    when lower(c.ownership) = 'частная'                               then 'private'::cadastral_ownership
    when c.ownership = 'Муниципальная'                                then 'municipal'::cadastral_ownership
    when c.ownership = 'Государственная субъекта РФ'                  then 'state_subject'::cadastral_ownership
    when c.ownership = 'Государственная федеральная'                  then 'state_federal'::cadastral_ownership
    when c.ownership like '%;%'                                       then 'mixed'::cadastral_ownership
    else 'unknown'::cadastral_ownership
  end,
  c.area_m2,
  c.status,
  c.page_t42,
  c.source_id
from pmt_cadastrals c;

-- ── 5. Обогащение: изъятие из pmt_stage1_izyatie ───────────────────────────────
update cadastrals cad set
  is_seizure          = true,
  seizure_area_m2     = iz.area_m2_seizure,
  seizure_dpt_no      = iz.dpt_no,
  seizure_note        = iz.note,
  seizure_building_kn = iz.building_kn,
  seizure_building_area = iz.building_area
from pmt_stage1_izyatie iz
where cad.cadastral_number = iz.cadastral;

-- ── 6. Обогащение: смена ВРИ из pmt_vri_changes ───────────────────────────────
update cadastrals cad set
  vri_changes = sub.changes
from (
  select cadastral,
    jsonb_agg(jsonb_build_object(
      'stage', stage,
      'category_old', category_old,
      'category_new', category_new,
      'vri_old', vri_old,
      'vri_new', vri_new
    ) order by stage) as changes
  from pmt_vri_changes
  group by cadastral
) sub
where cad.cadastral_number = sub.cadastral;

-- ── 7. Авто-привязка plots ↔ cadastrals ────────────────────────────────────────
-- Связываем plot с cadastral, если код участка начинается с кадастрового номера
-- (напр. plot "90:18:000000:966:ЗУ1" → cadastral "90:18:000000:966")
insert into plot_cadastrals (plot_id, cadastral_id)
select p.id, cad.id
from plots p
join cadastrals cad on p.code like cad.cadastral_number || '%'
where p.active = true
on conflict do nothing;

-- Также заполняем plots.cadastral_number для участков с точным совпадением
-- (исходные ЗУ, сохраняемые без изменения)
update plots set cadastral_number = code
where code in (select cadastral_number from cadastrals)
  and (cadastral_number is null or cadastral_number = '');

-- ── 8. Триггер updated_at ──────────────────────────────────────────────────────
create or replace function public.cadastrals_set_updated_at()
returns trigger language plpgsql as $$
begin NEW.updated_at = now(); return NEW; end;
$$;

create trigger set_updated_at_cadastrals
  before update on cadastrals
  for each row execute function public.cadastrals_set_updated_at();

-- ── 9. GeoJSON RPC — кадастры на карте ─────────────────────────────────────────
-- Для кадастров, у которых есть связанные plots с геометрией,
-- строим Feature из union полигонов всех связанных plots.
create or replace function public.cadastrals_geojson(
  p_ownership text default 'all',
  p_seizure   text default 'all'   -- 'all' | 'seizure' | 'kept'
)
returns jsonb
language sql
stable
as $$
  with cad_geom as (
    select
      cad.id,
      cad.cadastral_number,
      cad.address,
      cad.category,
      cad.vri,
      cad.ownership,
      cad.ownership_raw,
      cad.area_m2,
      cad.is_seizure,
      cad.seizure_area_m2,
      cad.vri_changes,
      ST_Multi(ST_Union(pp.geom_4326)) as geom
    from cadastrals cad
    join plot_cadastrals pc on pc.cadastral_id = cad.id
    join plots p on p.id = pc.plot_id and p.active = true
    join plot_polygon_assignments ppa on ppa.plot_id = p.id and ppa.valid_to is null
    join plot_polygons pp on pp.id = ppa.polygon_id
    where cad.active = true
      and (p_ownership = 'all' or cad.ownership::text = p_ownership)
      and (p_seizure = 'all'
           or (p_seizure = 'seizure' and cad.is_seizure = true)
           or (p_seizure = 'kept' and cad.is_seizure = false))
    group by cad.id
  ),
  features as (
    select jsonb_build_object(
      'type', 'Feature',
      'id', cadastral_number,
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'cadastral_id',      id,
        'cadastral_number',  cadastral_number,
        'address',           address,
        'category',          category,
        'vri',               vri,
        'ownership',         ownership,
        'ownership_raw',     ownership_raw,
        'area_m2',           area_m2,
        'is_seizure',        is_seizure,
        'seizure_area_m2',   seizure_area_m2,
        'vri_changes',       coalesce(vri_changes, '[]'::jsonb)
      )
    ) as feature
    from cad_geom
    where geom is not null and ST_IsValid(geom)
  )
  select jsonb_build_object('type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(feature), '[]'::jsonb))
  from features;
$$;

comment on function public.cadastrals_geojson(text, text)
  is 'GeoJSON FeatureCollection исходных кадастровых участков. Фильтр по ownership и seizure. EPSG:4326.';

-- ── 10. Представление: v_cadastrals_full ───────────────────────────────────────
create or replace view public.v_cadastrals_full as
select
  cad.*,
  coalesce(pc.plot_count, 0) as linked_plots_count,
  coalesce(pc.plot_codes, '{}'::text[]) as linked_plot_codes
from cadastrals cad
left join lateral (
  select
    count(*) as plot_count,
    array_agg(p.code order by p.code) as plot_codes
  from plot_cadastrals pcl
  join plots p on p.id = pcl.plot_id
  where pcl.cadastral_id = cad.id
) pc on true;

comment on view public.v_cadastrals_full
  is 'Кадастры + количество и коды связанных участков.';

-- ── 11. Доступ ─────────────────────────────────────────────────────────────────
grant select on cadastrals to anon, authenticated;
grant select on plot_cadastrals to anon, authenticated;
grant select on v_cadastrals_full to anon, authenticated;
