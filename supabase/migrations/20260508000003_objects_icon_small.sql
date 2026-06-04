-- Маленькое превью логотипа объекта (32×32 PNG) — для отрисовки чипов в
-- списках задач/событий/отчётов без загрузки полноразмерных 256×256.
--
-- objects.icon       — основной 256×256 PNG (или эмодзи)
-- objects.icon_small — мини-копия 32×32 PNG (только если icon — картинка)
--
-- Для существующих 9 объектов с эмодзи icon_small остаётся NULL; UI делает
-- fallback на icon. Для будущих картинок ObjectModal генерирует обе версии.

alter table objects add column if not exists icon_small text;

comment on column objects.icon is
    'Логотип объекта: эмодзи (1-4 символа) ИЛИ data-URL PNG до 256×256 px. Для шапок страниц, отчётов, крупных карточек.';
comment on column objects.icon_small is
    'Мини-превью логотипа: data-URL PNG 32×32 для чипов в списках. NULL если objects.icon — эмодзи (тогда UI рендерит icon как есть).';

notify pgrst, 'reload schema';
