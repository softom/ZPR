-- ============================================================================
-- Цвет и иконка для объектов — сквозная визуальная дифференциация.
-- ============================================================================
-- Используется в: /calendar (подкраска задач), /objects, /reports, /tasks,
-- бейджах в карточках событий и календарных вех. Фронт-компонент ObjectBadge.
-- ============================================================================

alter table objects
    add column color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
    add column icon text;

comment on column objects.color is
    'HEX-цвет объекта для визуальной дифференциации в календарях, отчётах, бейджах. Формат #RRGGBB. NULL = серый по умолчанию в UI.';
comment on column objects.icon is
    'Иконка объекта: эмодзи (☀️ 🚀) или короткая текстовая метка (1–2 символа). Опционально.';

-- Seed: палитра Tailwind 500-серии для 8 объектов проекта (по семантике названий)
update objects set color = '#a855f7', icon = '🚀' where code like '001%';   -- Космос/Спортивный
update objects set color = '#f59e0b', icon = '☀️' where code like '002%';   -- Family Солнышко
update objects set color = '#0ea5e9', icon = '👪' where code like '003%';   -- Family 5*
update objects set color = '#10b981', icon = '🩺' where code like '004%';   -- Health
update objects set color = '#059669', icon = '💚' where code like '005%';   -- Emerald
update objects set color = '#ec4899', icon = '🎉' where code like '006%';   -- Club
update objects set color = '#3b82f6', icon = '🏨' where code like '007%';   -- Select / Residence
update objects set color = '#64748b', icon = '🏠' where code like '008%';   -- Персонал
update objects set color = '#475569', icon = '📋' where code like '000%';   -- МАСТЕРПЛАН

notify pgrst, 'reload schema';
