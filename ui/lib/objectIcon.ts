/**
 * Хелперы для иконок `objects.icon` (см. WIKI 25_Сущность_Объект.md).
 *
 * Поле `icon` может содержать:
 *   - короткий **эмодзи** (1–4 символа, напр. `🚀`, `☀️`)
 *   - **data:image/...** PNG data-URL (например 256×256 PNG, base64)
 *
 * При рендере в HTML/JSX нужно различать: эмодзи вставляем как текст, PNG — как `<img>`.
 * Иначе data-URL выводится как огромная base64-строка прямо в DOM.
 */

export function isDataUrl(icon: string | null | undefined): boolean {
  return typeof icon === 'string' && icon.startsWith('data:image/')
}

/** HTML-фрагмент для иконки внутри popup/leaflet (не JSX, а raw HTML-строка). */
export function iconHtml(icon: string | null | undefined, size: number = 16): string {
  if (!icon) return ''
  if (isDataUrl(icon)) {
    return `<img src="${icon}" alt="" style="width:${size}px;height:${size}px;object-fit:contain;vertical-align:middle;display:inline-block" />`
  }
  return icon // эмодзи как есть
}
