-- ============================================================
-- ZPR — RLS политики для masterplan_objects и связанных таблиц
-- ============================================================
-- SELECT — для всех авторизованных
-- INSERT / UPDATE / DELETE — только для admin (как у `objects`)
-- ============================================================

-- masterplan_objects
alter table masterplan_objects enable row level security;

create policy mpo_select on masterplan_objects
  for select using (true);

create policy mpo_admin_all on masterplan_objects
  for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- masterplan_metric_codes (справочник — read-only для всех, admin может править)
alter table masterplan_metric_codes enable row level security;

create policy mmc_select on masterplan_metric_codes
  for select using (true);

create policy mmc_admin_all on masterplan_metric_codes
  for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- masterplan_object_metrics
alter table masterplan_object_metrics enable row level security;

create policy mom_select on masterplan_object_metrics
  for select using (true);

create policy mom_admin_all on masterplan_object_metrics
  for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- masterplan_object_objects (junction)
alter table masterplan_object_objects enable row level security;

create policy mpoo_select on masterplan_object_objects
  for select using (true);

create policy mpoo_admin_all on masterplan_object_objects
  for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- masterplan_object_plots (junction)
alter table masterplan_object_plots enable row level security;

create policy mpop_select on masterplan_object_plots
  for select using (true);

create policy mpop_admin_all on masterplan_object_plots
  for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- masterplan_object_functional_objects (junction)
alter table masterplan_object_functional_objects enable row level security;

create policy mpofo_select on masterplan_object_functional_objects
  for select using (true);

create policy mpofo_admin_all on masterplan_object_functional_objects
  for all
  using (public.user_role() = 'admin')
  with check (public.user_role() = 'admin');

-- Grant для роли arcgis_writer (чтение всех таблиц для ArcGIS Pro)
grant select on masterplan_objects, masterplan_metric_codes, masterplan_object_metrics,
                masterplan_object_objects, masterplan_object_plots, masterplan_object_functional_objects
       to arcgis_writer;
