/**
 * Утилиты для рендера иконок объектов (`objects.icon`, `objects.icon_small`).
 *
 * Контекст: поле `icon` может содержать ЛИБО emoji (короткая строка вроде '📋'),
 * ЛИБО data-URL картинки (`data:image/png;base64,...`), ЛИБО http(s)-URL.
 *
 * Когда иконка рендерится в JSX (например, через ObjectBadge) — для data/url
 * можно использовать `<img>`. Но в нативных HTML-элементах, которые принимают
 * только текст (`<option>`, `title=""`, `aria-label=""`), `<img>` невозможен —
 * именно там base64-URL «выскакивает» как простыня символов.
 *
 * Эти хелперы фильтруют такие случаи.
 */

/** Иконка — это data-URL или http(s) URL (то есть картинка, не emoji). */
export function isImageUrl(s: string | null | undefined): s is string {
  return !!s && (s.startsWith('data:image/') || /^https?:\/\//.test(s))
}

/**
 * Для `<option>`-like контекстов: возвращает префикс «<emoji> » для emoji-иконок,
 * пустую строку для url/data — и для null.
 *
 * Пример:
 *   `${optionIconPrefix(o.icon)}${o.code}`  → «📋 101_ГОСТИНИЦА_350»
 *                                          → «106_ГОСТИНИЦА_350»  (если у объекта картинка)
 */
export function optionIconPrefix(icon: string | null | undefined): string {
  if (!icon || isImageUrl(icon)) return ''
  return `${icon} `
}
