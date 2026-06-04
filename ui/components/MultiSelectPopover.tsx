'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MultiSelectOption = {
  value: string
  label: string
  sublabel?: string         // вторая строка (например, current_name под кодом)
  icon?: string | null      // emoji или картинка-URL
}

const POPOVER_WIDTH = 320
const POPOVER_MAX_HEIGHT = 360

/**
 * Триггер-кнопка + popover-список с чекбоксами и поиском.
 * Popover рендерится через createPortal в document.body с fixed-позиционированием,
 * чтобы не обрезаться overflow-родителями (модалкой).
 * Изменения собираются в draft и применяются при «Применить» одним вызовом onApply().
 */
export default function MultiSelectPopover({
  label,
  options,
  selected,
  onApply,
  triggerClassName,
  disabled,
}: {
  label: string
  options: MultiSelectOption[]
  selected: string[]
  onApply: (newSelected: string[]) => void | Promise<void>
  triggerClassName?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>(selected)
  const [search, setSearch] = useState('')
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Сбрасываем draft и поиск при открытии
  useEffect(() => {
    if (open) {
      setDraft(selected)
      setSearch('')
    }
  }, [open, selected])

  // Вычисляем позицию popover относительно триггера + flip если не влазит
  useEffect(() => {
    if (!open || !triggerRef.current) return
    function place() {
      const trigger = triggerRef.current
      if (!trigger) return
      const r = trigger.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left = r.left
      // Если popover вылезает за правый край viewport — флипаем к правому краю триггера
      if (left + POPOVER_WIDTH > vw - 8) {
        left = Math.max(8, r.right - POPOVER_WIDTH)
      }
      let top = r.bottom + 4
      // Если popover вылезает за нижний край — флипаем вверх
      if (top + POPOVER_MAX_HEIGHT > vh - 8 && r.top - 4 > POPOVER_MAX_HEIGHT) {
        top = r.top - 4 - POPOVER_MAX_HEIGHT
      }
      setCoords({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return options
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) ||
      (o.sublabel ?? '').toLowerCase().includes(q)
    )
  }, [options, search])

  function toggle(v: string) {
    setDraft((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
  }

  async function apply() {
    await onApply(draft)
    setOpen(false)
  }

  const added   = draft.filter((x) => !selected.includes(x)).length
  const removed = selected.filter((x) => !draft.includes(x)).length
  const hasChanges = added > 0 || removed > 0

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={triggerClassName ||
          'px-2 py-0.5 border rounded text-xs bg-white hover:bg-gray-50 disabled:opacity-40'}
      >
        {label} <span className="text-gray-400">▾</span>
      </button>
      {open && coords && typeof window !== 'undefined' && createPortal(
        <>
          {/* overlay поверх всего — закрытие по клику снаружи */}
          <div
            className="fixed inset-0 z-[70]"
            onClick={() => setOpen(false)}
          />
          {/* сам popover */}
          <div
            className="fixed z-[71] bg-white border rounded shadow-2xl flex flex-col"
            style={{
              top: coords.top,
              left: coords.left,
              width: POPOVER_WIDTH,
              maxHeight: POPOVER_MAX_HEIGHT,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="поиск…"
              className="px-2 py-1.5 border-b text-sm outline-none"
              autoFocus
            />
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-400 text-center">пусто</div>
              ) : (
                filtered.map((o) => {
                  const checked = draft.includes(o.value)
                  return (
                    <label
                      key={o.value}
                      className="flex items-start gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-gray-50 border-b border-gray-50 last:border-0"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(o.value)}
                        className="mt-1 shrink-0"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-1">
                          {o.icon && (
                            o.icon.startsWith('data:image/') || /^https?:\/\//.test(o.icon)
                              ? <img src={o.icon} alt="" className="w-4 h-4 object-contain" />
                              : <span aria-hidden>{o.icon}</span>
                          )}
                          <span className="truncate">{o.label}</span>
                        </span>
                        {o.sublabel && (
                          <span className="block text-xs text-gray-400 truncate">{o.sublabel}</span>
                        )}
                      </span>
                    </label>
                  )
                })
              )}
            </div>
            <div className="flex border-t">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex-1 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 border-r"
              >Отмена</button>
              <button
                type="button"
                onClick={apply}
                disabled={!hasChanges}
                className="flex-1 px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Применить
                {hasChanges && (
                  <span className="ml-1 text-xs text-blue-100">
                    ({added > 0 && `+${added}`}{added > 0 && removed > 0 && ' '}{removed > 0 && `−${removed}`})
                  </span>
                )}
              </button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}
