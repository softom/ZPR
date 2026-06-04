'use client'

// ─── EntityLinksBlock ─────────────────────────────────────────────────────
// Универсальный блок отображения связей одной сущности с группировкой по
// «фазам» (link_type). Используется в /tasks, /events, /protocols и везде,
// где надо показать список связей с возможностью add/delete.
//
// Контракт презентационный: компонент НЕ читает БД, НЕ пишет — только
// рендерит данные из props и зовёт колбэки. Список связей фильтруется
// caller'ом (например, по from_id).
//
// См. WIKI 09_Правило_связей раздел «Унифицированный модуль связей в UI».

import Link from 'next/link'
import { resolveEntityRef, type EntityKind, type EntityRegistry } from '@/lib/entityRef'

/** Минимальный контракт связи. Совместим с строкой `entity_links`. */
export type GenericLink = {
  id: string
  to_type: string
  to_id: string
  link_type: string
  notes: string | null
}

/** Описание одной «фазы»/группы в блоке. */
export type LinkPhase = {
  /**
   * Один link_type или массив — для агрегированных фаз
   * (например, «Источник» = ['from_document','from_letter','from_meeting','from_protocol']).
   * При множественном linkType колбэк onAdd получает defaultAddLinkType (первый).
   */
  linkType: string | string[]
  /**
   * Опц.: link_type, используемый при создании из этой фазы. Если linkType — массив,
   * этот параметр определяет какой именно тип записать. По умолчанию — первый из массива.
   */
  defaultAddLinkType?: string
  /** Emoji-индикатор. */
  icon: string
  /** Человеко-читаемое имя группы. */
  label: string
  /** Tailwind-классы для бордера + фона строки связи (border-l-2 + bg-*). */
  color: string
  /** Override текста при пустой группе. Default: '— нет —'. */
  emptyText?: string
  /** Tooltip на кнопке «+ Добавить». */
  addHint?: string
}

function phaseLinkTypes(phase: LinkPhase): string[] {
  return Array.isArray(phase.linkType) ? phase.linkType : [phase.linkType]
}

function phaseAddLinkType(phase: LinkPhase): string {
  return phase.defaultAddLinkType ?? phaseLinkTypes(phase)[0]
}

export type EntityLinksBlockProps = {
  /** Заголовок блока. Default: 'Связи' */
  title?: string
  /** Связи, относящиеся к этой сущности (caller их уже отфильтровал). */
  links: GenericLink[]
  /** Описание фаз. Каждая = одна группа = один link_type. */
  phases: LinkPhase[]
  /** Реестр для резолва имён целевых сущностей через entityRef. */
  registry: EntityRegistry
  /** Колбэк при клике «+ Добавить» в фазе. Caller открывает свой EntityLinkPicker. */
  onAdd?: (linkType: string) => void
  /** Колбэк при клике «✕» на связи. Caller делает DELETE + reload. */
  onDelete?: (linkId: string) => void
}

export function EntityLinksBlock({
  title = 'Связи',
  links,
  phases,
  registry,
  onAdd,
  onDelete,
}: EntityLinksBlockProps) {
  return (
    <div className="border-t pt-3 mt-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
        {title}
      </h3>
      <div className="space-y-2">
        {phases.map((phase) => {
          const types = phaseLinkTypes(phase)
          const phaseLinks = links.filter((l) => types.includes(l.link_type))
          const phaseKey = types.join('|')
          return (
            <div key={phaseKey}>
              <div className="text-[11px] font-medium text-gray-600 mb-1 flex items-center gap-1">
                <span>{phase.icon}</span>
                <span>{phase.label}</span>
                <span className="text-gray-400 font-normal">({phaseLinks.length})</span>
                {onAdd && (
                  <button
                    onClick={() => onAdd(phaseAddLinkType(phase))}
                    className="ml-auto text-[11px] text-blue-600 hover:underline"
                    title={phase.addHint ?? `Добавить связь «${phase.label}»`}
                  >
                    + Добавить
                  </button>
                )}
              </div>
              {phaseLinks.length === 0 ? (
                <p className="text-[11px] text-gray-400 italic pl-5">
                  {phase.emptyText ?? '— нет —'}
                </p>
              ) : (
                <ul className="space-y-1">
                  {phaseLinks.map((l) => {
                    const ref = resolveEntityRef(l.to_type as EntityKind, l.to_id, registry)
                    const tooltip = l.notes ? `${ref.tooltip}\n— ${l.notes}` : ref.tooltip
                    const inner = (
                      <>
                        <span className="text-sm shrink-0" title={ref.kindLabel} aria-label={ref.kindLabel}>
                          {ref.icon}
                        </span>
                        <span className="text-xs font-medium text-gray-800 truncate flex-1" title={tooltip}>
                          {ref.label}
                        </span>
                        {ref.sublabel && (
                          <span className="text-[10px] text-gray-500 shrink-0">{ref.sublabel}</span>
                        )}
                      </>
                    )
                    return (
                      <li key={l.id} className={`flex items-stretch rounded border-l-2 ${phase.color} overflow-hidden`}>
                        {ref.href ? (
                          <Link href={ref.href} className="flex items-baseline gap-2 px-2 py-1 flex-1 min-w-0 hover:bg-white/50">
                            {inner}
                          </Link>
                        ) : (
                          <div className="flex items-baseline gap-2 px-2 py-1 flex-1 min-w-0">
                            {inner}
                          </div>
                        )}
                        {onDelete && (
                          <button
                            onClick={() => onDelete(l.id)}
                            className="px-2 text-gray-400 hover:text-red-600 hover:bg-red-50 text-xs shrink-0"
                            title="Удалить связь"
                          >
                            ✕
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
