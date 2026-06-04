-- ============================================================
-- ZPR — ENUM-типы и справочники для модели Участок (Ф1 миграция 1)
-- ============================================================
-- Базовые типы для plots / plot_polygon_assignments / functional_objects /
-- engineering_loads. См. [[29_Сущность_Участок]] и [[32_План_импорта_ПМТ]].
-- ============================================================

create type plot_role as enum (
    'plot',        -- основной ЗУ
    'servitude',   -- сервитут (право прохода/проезда/коммуникаций)
    'partial',     -- часть кадастра
    'cadastral'    -- исходный кадастровый участок до межевания
);

create type assignment_ring_role as enum (
    'outer',       -- внешний контур (default)
    'hole',        -- вырез внутри участка
    'servitude',   -- резерв
    'overlap'      -- наложение
);

create type functional_object_kind as enum (
    'hotel',                  -- Г-, К- (гостиничные, курортные)
    'transit_hotel',          -- Т- (транзитный)
    'sport_entertainment',    -- С- (музей, аквапарк, конгресс-центр, термальный)
    'food',                   -- О- (общепит, барная улица)
    'transport_infra',        -- ТИ- (ТПУ, автостоянки)
    'utility',                -- Х- (хоз/админ зоны)
    'promenade',              -- Н- (набережные, променад)
    'energy',                 -- P- (подстанция)
    'other'
);

create type engineering_network as enum (
    'water',
    'sewer',
    'storm',
    'heat',
    'gas',
    'power',
    'telecom'
);

-- ============================================================
-- plot_boundary_types — справочник типов источников границы
-- ============================================================
create table plot_boundary_types (
    code        text primary key,
    label       text not null,
    description text,
    priority    smallint not null,
    active      boolean not null default true
);

insert into plot_boundary_types (code, label, priority, description) values
  ('masterplan', 'По мастерплану', 1,
   'Концептуальная граница из мастер-плана проекта. Низкая точность.'),
  ('survey',     'По межеванию',   2,
   'По актуальному проекту межевания территории (ПМТ). Может иметь несколько версий.'),
  ('cadastral',  'По кадастрам',   3,
   'По выписке ЕГРН / публичной кадастровой карте. Юридически закреплено.');
