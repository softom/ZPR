-- ============================================================================
-- Бэкафилл calendar_entries.object_ids / is_project_wide из schedule_object_mapping
-- ============================================================================
-- Контекст (аудит боевой БД, 2026-06-23):
--   В существующих версиях графика поле calendar_entries.object_ids пусто во
--   всех строках. Привязка задачи к объекту фактически живёт в
--   calendar_entries.schedule_raw_text (сырой текст из поля привязки MS Project)
--   и справочнике schedule_object_mapping(raw_text → object_id | is_project_wide).
--   Мост между ними — case-insensitive по тексту: lower(schedule_raw_text) = lower(raw_text).
--
-- Эта миграция воспроизводит логику резолва из importMspdi.ts (resolveObjects):
--   • raw_text найден в mapping, m.object_id IS NOT NULL  → object_ids = [m.object_id], is_project_wide = false
--   • raw_text найден в mapping, m.is_project_wide = true → object_ids = '{}',          is_project_wide = true
--   • raw_text NULL или не найден в mapping               → НЕ ТРОГАЕМ (остаётся как было)
--
-- Идемпотентность: оба UPDATE безопасно повторять. Объектный UPDATE гейтится по
-- «ещё не заполненному» object_ids; project-wide UPDATE — по is_project_wide=false.
-- Повторный прогон не делает лишних изменений.
--
-- КОНТРАКТ ЭКСПОРТА (round-trip MS Project): НЕ трогаем mspdi_passthrough,
-- mspdi_uid, schedule_raw_text. Пишем только owned-поля object_ids / is_project_wide.
--
-- Согласованность со схемой 20260508000006_calendar_mspdi.sql:
--   • schedule_object_mapping_target_check: object_id IS NOT NULL ⟺ is_project_wide=false
--     ⇒ два UPDATE ниже не пересекаются по строкам mapping.
--   • calendar_entries_project_wide_check: при is_project_wide=true object_ids
--     обязан быть '{}' (или array_length NULL) ⇒ project-wide UPDATE выставляет object_ids='{}'.
--   • schedule_object_mapping_raw_text_uidx — уникальный индекс на lower(raw_text)
--     ⇒ join по lower() даёт максимум одну строку mapping на raw_text (без дублей).
-- ============================================================================

-- ─── 1. Привязанные к конкретному объекту задачи ──────────────────────────────
-- Заполняем object_ids одним объектом и фиксируем is_project_wide=false.
-- Гейт: трогаем только строки с пустым object_ids (NULL или нулевой длины),
-- чтобы не перетереть возможные ручные правки и обеспечить идемпотентность.
update calendar_entries ce
set object_ids      = array[m.object_id],
    is_project_wide = false
from schedule_object_mapping m
where lower(ce.schedule_raw_text) = lower(m.raw_text)
  and m.object_id is not null
  and ce.schedule_raw_text is not null
  and (ce.object_ids is null or array_length(ce.object_ids, 1) is null);

-- ─── 2. Общепроектные задачи (is_project_wide в справочнике) ──────────────────
-- Помечаем is_project_wide=true и обнуляем object_ids='{}' (требование
-- calendar_entries_project_wide_check). Гейт: только строки, ещё не помеченные
-- как project-wide — идемпотентно при повторном прогоне.
update calendar_entries ce
set is_project_wide = true,
    object_ids      = '{}'::uuid[]
from schedule_object_mapping m
where lower(ce.schedule_raw_text) = lower(m.raw_text)
  and m.is_project_wide = true
  and ce.schedule_raw_text is not null
  and ce.is_project_wide = false;

-- ─── PostgREST schema reload ──────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ============================================================================
-- ПРОВЕРКА ПОКРЫТИЯ (выполнить вручную после применения; раскомментировать):
-- ----------------------------------------------------------------------------
-- -- Сводка по резолву привязок в разрезе наличия raw_text и заполненности:
-- select
--     case
--         when ce.schedule_raw_text is null                        then 'no_raw_text'
--         when m.object_id is not null                             then 'mapped_object'
--         when m.is_project_wide                                   then 'mapped_project_wide'
--         else                                                          'unmapped_raw_text'
--     end                                                          as bucket,
--     count(*)                                                     as entries,
--     count(*) filter (where array_length(ce.object_ids,1) >= 1)   as with_object_ids,
--     count(*) filter (where ce.is_project_wide)                   as project_wide
-- from calendar_entries ce
-- left join schedule_object_mapping m
--        on lower(ce.schedule_raw_text) = lower(m.raw_text)
-- group by 1
-- order by 1;
--
-- -- Остаток нерезолвленных (есть raw_text, но нет строки в mapping):
-- select distinct ce.schedule_raw_text
-- from calendar_entries ce
-- left join schedule_object_mapping m
--        on lower(ce.schedule_raw_text) = lower(m.raw_text)
-- where ce.schedule_raw_text is not null
--   and m.id is null
-- order by 1;
-- ============================================================================
