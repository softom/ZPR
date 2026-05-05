-- ============================================================
-- Фикс аномалий модели событий: A1 + A2 + A3
-- ============================================================
-- A1 — events.notes / events.note дублирующая колонка
-- A2 — events_fact_date_propagate каскад без защиты от ре-пересчёта
-- A3 — рассинхрон events.is_planned vs агрегат event_object_status

-- ─── A1. Унификация notes → note ───────────────────────────────
-- В UI страницы /events используется колонка 'note', 'notes' — legacy.
update events
   set note = notes
 where (note is null or note = '')
   and notes is not null
   and notes != '';

alter table events drop column notes;

-- ─── A2. Защита propagate от ре-каскада ────────────────────────
-- Когда recompute_event_fact() пишет events.fact_date изнутри триггера
-- event_object_status_recompute, функция уже выставила app.skip_event_sync='on'.
-- Расширяем гард на propagate-функцию: если флаг 'on' — пропускаем каскад.
create or replace function trg_events_fact_date_changed()
returns trigger language plpgsql as $$
begin
    -- Защита: если каскад инициирован junction-триггером, не делаем повторный пересчёт
    if current_setting('app.skip_event_sync', true) = 'on' then
        return new;
    end if;
    if new.fact_date is distinct from old.fact_date then
        perform propagate_event_date(new.id);
    end if;
    return new;
end$$;

comment on function trg_events_fact_date_changed() is
    'Каскад пересчёта date_computed потомков при изменении fact_date. Защита от ре-каскада через GUC app.skip_event_sync.';

-- ─── A3. Разовый пересчёт агрегата по всем событиям ────────────
do $$
declare r record;
begin
    for r in select id from events loop
        perform recompute_event_fact(r.id);
    end loop;
end$$;

notify pgrst, 'reload schema';
