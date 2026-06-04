-- ============================================================================
-- Сохранение исходного raw_text из MS Project в calendar_entries.
-- ============================================================================
-- Контекст: при экспорте обратно в MSPDI задача должна содержать тот же
-- текст в поле «Объект», что был при импорте — иначе round-trip ломается
-- (повторный импорт того же файла создаст пустые привязки, потому что
-- значение в Текст15 поменялось с человекочитаемого на код объекта).
-- ============================================================================

alter table calendar_entries
    add column schedule_raw_text text;

create index calendar_entries_schedule_raw_text_idx
    on calendar_entries (schedule_raw_text)
    where schedule_raw_text is not null;

comment on column calendar_entries.schedule_raw_text is
    'Оригинальное значение поля привязки к объекту из исходного MS Project XML (например «Отель 4* Family (Солнышко)»). Сохраняет round-trip при экспорте обратно.';

notify pgrst, 'reload schema';
