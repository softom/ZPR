-- ============================================================================
-- Сохранение FieldID и деклараций ExtendedAttributes в schedule_imports.
-- ============================================================================
-- Контекст: реальный MS Project XML использует пользовательские поля
-- с произвольными FieldID (например 188744001 для «Текст15» с alias
-- «Наименование объекта»). Чтобы экспорт писал в то же поле и сохранял
-- round-trip с Project, запоминаем FieldID и шапку ExtendedAttributes
-- из исходного файла.
-- ============================================================================

alter table schedule_imports
    add column object_field_id text,
    add column extended_attribute_defs jsonb not null default '[]'::jsonb;

comment on column schedule_imports.object_field_id is
    'FieldID в MSPDI поля, откуда читается привязка к объекту (например 188744001 для кастомного Текст15). NULL для objectField=Notes.';
comment on column schedule_imports.extended_attribute_defs is
    'JSON-массив деклараций ExtendedAttributes из шапки исходного XML: [{fieldId, fieldName, alias}, ...]. Нужно для round-trip экспорта.';

notify pgrst, 'reload schema';
