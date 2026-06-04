-- ============================================================
-- ZPR — junction-таблицы masterplan_objects ↔ {objects, plots, functional_objects}
-- ============================================================
-- Симметрия с моделью `objects` (M:N через `functional_object_objects` и т.д.).
-- Один объект мастерплана может быть привязан к нескольким бизнес-объектам,
-- размещён на нескольких участках, входить в несколько функциональных зон.
-- ============================================================

-- ── 1. masterplan_objects ↔ objects ──────────────────────────────────────────
create table masterplan_object_objects (
  masterplan_object_id uuid not null references masterplan_objects(id) on delete cascade,
  object_id            uuid not null references objects(id)            on delete cascade,
  created_at           timestamptz not null default now(),
  primary key (masterplan_object_id, object_id)
);
create index mpoo_object_idx on masterplan_object_objects(object_id);
create index mpoo_mpo_idx    on masterplan_object_objects(masterplan_object_id);

comment on table masterplan_object_objects is
  'M:N связь masterplan_object ↔ object. Появляется при «оживлении» объекта мастерплана: создаётся / подвязывается бизнес-объект.';

-- ── 2. masterplan_objects ↔ plots ────────────────────────────────────────────
create table masterplan_object_plots (
  masterplan_object_id uuid not null references masterplan_objects(id) on delete cascade,
  plot_id              uuid not null references plots(id)              on delete cascade,
  created_at           timestamptz not null default now(),
  primary key (masterplan_object_id, plot_id)
);
create index mpop_plot_idx on masterplan_object_plots(plot_id);
create index mpop_mpo_idx  on masterplan_object_plots(masterplan_object_id);

comment on table masterplan_object_plots is
  'M:N связь masterplan_object ↔ plot. Один объект мастерплана может размещаться на нескольких участках (многокорпусные).';

-- ── 3. masterplan_objects ↔ functional_objects ───────────────────────────────
create table masterplan_object_functional_objects (
  masterplan_object_id uuid not null references masterplan_objects(id) on delete cascade,
  functional_object_id uuid not null references functional_objects(id) on delete cascade,
  created_at           timestamptz not null default now(),
  primary key (masterplan_object_id, functional_object_id)
);
create index mpofo_fo_idx  on masterplan_object_functional_objects(functional_object_id);
create index mpofo_mpo_idx on masterplan_object_functional_objects(masterplan_object_id);

comment on table masterplan_object_functional_objects is
  'M:N связь masterplan_object ↔ functional_object. Обычно 1:1 (объект в одной зоне ППТ), но допускаем M:N для ОКС на границе зон.';
