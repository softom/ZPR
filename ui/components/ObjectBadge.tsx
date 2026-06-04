/**
 * ObjectBadge — единый бейдж объекта ЗПР с цветом и иконкой.
 *
 * Использование:
 *   <ObjectBadge object={obj} />                              // полный: иконка + код + имя
 *   <ObjectBadge object={obj} variant="compact" />            // только иконка + код
 *   <ObjectBadge object={obj} variant="dot" />                // цветовая точка с tooltip
 *
 * Источники данных в БД: objects.color (HEX), objects.icon (emoji),
 * objects.code, objects.current_name.
 */

import React from 'react'

export interface ObjectRef {
  id?: string
  code: string
  current_name?: string | null
  color?: string | null
  icon?: string | null
  icon_small?: string | null
}

interface Props {
  object: ObjectRef | null | undefined
  variant?: 'full' | 'compact' | 'dot'
  className?: string
  /** Если true, бейдж имеет фоновый цвет объекта (для выделенных мест). По умолчанию — окантовка. */
  filled?: boolean
}

const FALLBACK_COLOR = '#94a3b8'   // slate-400

function isImageUrl(s: string | null | undefined): s is string {
  return !!s && (s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://'))
}

/** Рендер иконки объекта: img для data-URL / http, span для эмодзи. */
function renderIcon(o: ObjectRef, size: 'compact' | 'full') {
  // compact: предпочитаем icon_small (32×32), иначе icon (может быть и эмодзи, и большая картинка)
  const src = size === 'compact'
    ? (o.icon_small ?? o.icon ?? null)
    : (o.icon ?? null)

  if (isImageUrl(src)) {
    const sidePx = size === 'compact' ? 14 : 18
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={sidePx} height={sidePx} className="inline-block object-contain rounded-sm" />
  }
  return <span aria-hidden>{src ?? o.code.charAt(0)}</span>
}

export function ObjectBadge({ object, variant = 'full', className = '', filled = false }: Props) {
  if (!object) return <span className={`text-slate-400 text-xs ${className}`}>— объект не указан —</span>

  const color = object.color ?? FALLBACK_COLOR

  if (variant === 'dot') {
    return (
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full align-middle ${className}`}
        style={{ backgroundColor: color }}
        title={`${object.code}${object.current_name ? ' — ' + object.current_name : ''}`}
      />
    )
  }

  if (variant === 'compact') {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${className}`}
        style={
          filled
            ? { backgroundColor: color, color: '#fff' }
            : { borderLeft: `3px solid ${color}`, paddingLeft: '6px', backgroundColor: `${color}15` }
        }
        title={object.current_name ?? object.code}
      >
        {renderIcon(object, 'compact')}
        <span className="font-mono">{object.code}</span>
      </span>
    )
  }

  // variant === 'full'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs ${className}`}
      style={
        filled
          ? { backgroundColor: color, color: '#fff' }
          : { borderLeft: `3px solid ${color}`, paddingLeft: '8px', backgroundColor: `${color}10` }
      }
    >
      {renderIcon(object, 'full')}
      <span className="font-mono font-medium">{object.code}</span>
      {object.current_name && <span className="text-slate-600 truncate max-w-[200px]">{object.current_name}</span>}
    </span>
  )
}

export default ObjectBadge
