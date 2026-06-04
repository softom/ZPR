-- ============================================================
-- event_subtypes: добавить запись для contract_stage_change
-- ============================================================
-- Контекст: события смены этапа договора создаются с
-- events.event_type='contract_stage_change' (см. миграцию _20260514000003).
-- В UI таблицы событий рендер «Тип» делает lookup в event_subtypes,
-- и если строки нет — печатает сырой event_type ('contract_stage_change'),
-- что ломает layout колонки. Добавляем человеко-читаемый label + icon.
-- ============================================================

insert into event_subtypes (code, category, label, icon)
values ('contract_stage_change', 'system', 'Переход этапа', '🔄')
on conflict (code) do update
   set label = excluded.label,
       icon  = excluded.icon,
       category = excluded.category;

notify pgrst, 'reload schema';
