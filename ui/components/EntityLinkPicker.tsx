'use client'

// ─── EntityLinkPicker ─────────────────────────────────────────────────────
// Универсальная модалка для выбора цели entity_link: тип сущности
// (meeting/event/document/letter/object/legal_entity/task) + текстовый поиск
// + radio-список + примечание. Используется в /tasks, /events, /protocols
// и везде, где надо создать связь сущность→сущность.
//
// Контракт: компонент НЕ делает INSERT в entity_links — на onSubmit caller
// получает выбор и сам решает что сохранить и какие каскады применить
// (для задач это, например, закрытие task_object_status при resolved_by;
// для событий — свои каскады).
//
// См. WIKI 09_Правило_связей раздел «Унифицированный модуль связей в UI».

import { useState } from 'react'
import {
  formatMeetingRef,
  formatEventRef,
  formatDocumentRef,
  formatLetterRef,
  formatObjectRef,
  formatLegalEntityRef,
  formatTaskRef,
  formatContactRef,
  KIND_META,
  type EntityKind,
  type EntityRef,
  type EntityRegistry,
} from '@/lib/entityRef'

export type EntityLinkPickerProps = {
  /** Заголовок модалки. Default: 'Добавить связь' */
  title?: string
  /** Подзаголовок (например, имя фазы для задач). Опционально. */
  subtitle?: string
  /** Контекстная инфа об источнике связи: код + имя сущности. */
  fromEntity?: { code: string; title: string }
  /** Какие типы цели разрешены в этом контексте.
   *  Default: ['meeting', 'event', 'document', 'letter']. */
  allowedToTypes?: EntityKind[]
  /** Реестры сущностей — что показывать в radio-списке. */
  registry: EntityRegistry
  /** Опц. пояснительная плашка под формой (caller может рендерить контекстный hint
   *  типа «при resolved_by закроем per-object статусы»). */
  hint?: React.ReactNode
  /** Текст кнопки submit. Default: 'Создать связь' */
  submitLabel?: string
  /** Цвет кнопки submit. Default: 'blue'. Допустимы 'blue' и 'emerald'. */
  submitColor?: 'blue' | 'emerald'
  onClose: () => void
  /** Передаёт выбор caller'у (массив выбранных id для multi-select).
   *  Возвращает строку ошибки или null если успех. Caller сам решает, как
   *  обработать пакет (последовательные INSERT'ы, каскады и т.п.). */
  onSubmit: (args: { toType: EntityKind; toIds: string[]; notes: string }) => Promise<string | null>
}

const DEFAULT_ALLOWED_TO_TYPES: EntityKind[] =
  ['meeting', 'event', 'document', 'letter']

export function EntityLinkPicker({
  title = 'Добавить связь',
  subtitle,
  fromEntity,
  allowedToTypes = DEFAULT_ALLOWED_TO_TYPES,
  registry,
  hint,
  submitLabel = 'Создать связь',
  submitColor = 'blue',
  onClose,
  onSubmit,
}: EntityLinkPickerProps) {
  const [toType, setToType] = useState<EntityKind>(allowedToTypes[0])
  // Multi-select: множество выбранных id. Снимать/ставить чекбоксом.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Опции для выбора цели — единым формат через format*Ref.
  // Поиск ведётся по label + sublabel + tooltip.
  const options: EntityRef[] = (() => {
    const q = search.trim().toLowerCase()
    let refs: EntityRef[] = []
    if (toType === 'meeting')      refs = (registry.meetings  ?? []).map(formatMeetingRef)
    else if (toType === 'event')   refs = (registry.events    ?? []).map(formatEventRef)
    else if (toType === 'document') refs = (registry.documents ?? []).map(formatDocumentRef)
    else if (toType === 'letter')  refs = (registry.letters   ?? []).map(formatLetterRef)
    else if (toType === 'object')  refs = (registry.objects   ?? []).map(formatObjectRef)
    else if (toType === 'legal_entity') refs = (registry.entities ?? []).map(formatLegalEntityRef)
    else if (toType === 'task')    refs = (registry.tasks     ?? []).map(formatTaskRef)
    else if (toType === 'contact') {
      // Для контакта подтягиваем имя организации через legal_entity_id → registry.entities
      refs = (registry.contacts ?? []).map((c) => {
        const orgName = c.legal_entity_id
          ? (registry.entities ?? []).find((e) => e.id === c.legal_entity_id)?.name
          : null
        return formatContactRef(c, orgName)
      })
    }
    if (q) {
      refs = refs.filter((r) =>
        r.label.toLowerCase().includes(q) ||
        (r.sublabel ?? '').toLowerCase().includes(q) ||
        r.tooltip.toLowerCase().includes(q),
      )
    }
    return refs.slice(0, 200)
  })()

  function changeType(t: EntityKind) {
    setToType(t)
    setSelectedIds(new Set())
    setSearch('')
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSubmit() {
    if (selectedIds.size === 0) { setError('Выберите хотя бы одну запись'); return }
    setSubmitting(true)
    setError(null)
    const err = await onSubmit({ toType, toIds: [...selectedIds], notes: notes.trim() })
    setSubmitting(false)
    if (err) setError(err)
  }

  const colorClass = submitColor === 'emerald'
    ? 'bg-emerald-600 hover:bg-emerald-700'
    : 'bg-blue-600 hover:bg-blue-700'

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b">
          <div className="text-[11px] text-gray-500 uppercase tracking-wider">
            {title}{subtitle && ` — ${subtitle}`}
          </div>
          {fromEntity && (
            <>
              <h2 className="text-base font-semibold mt-0.5">{fromEntity.title}</h2>
              <div className="text-xs text-gray-500 mt-1 font-mono">{fromEntity.code}</div>
            </>
          )}
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Тип цели
            </label>
            <div className="flex gap-1 flex-wrap">
              {allowedToTypes.map((t) => {
                const meta = KIND_META[t]
                return (
                  <button
                    key={t}
                    onClick={() => changeType(t)}
                    className={`px-3 py-1 text-xs rounded border flex items-center gap-1 ${
                      toType === t
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span>{meta.icon}</span>
                    <span>{meta.kindLabel}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Поиск
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Часть кода/названия…"
              className="w-full px-2 py-1.5 border rounded text-sm"
            />
          </div>

          <div>
            <label className="flex items-baseline justify-between text-xs font-medium text-gray-700 mb-1">
              <span>Записи ({options.length}{options.length === 50 ? '+' : ''})</span>
              {selectedIds.size > 0 && (
                <span className="font-normal text-blue-700">выбрано: {selectedIds.size}</span>
              )}
            </label>
            <div className="max-h-56 overflow-y-auto border rounded">
              {options.length === 0 ? (
                <p className="px-3 py-4 text-xs text-gray-400 text-center italic">— нет совпадений —</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {options.map((opt) => {
                    const checked = selectedIds.has(opt.id)
                    return (
                      <li key={opt.id}>
                        <label className={`flex items-baseline gap-2 px-3 py-1.5 cursor-pointer text-xs ${checked ? 'bg-blue-50' : 'hover:bg-blue-50'}`} title={opt.tooltip}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelect(opt.id)}
                          />
                          <span className="text-sm shrink-0">{opt.icon}</span>
                          <span className="font-medium text-gray-800 truncate flex-1">{opt.label}</span>
                          {opt.sublabel && (
                            <span className="text-[10px] text-gray-500 shrink-0">{opt.sublabel}</span>
                          )}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Примечание (необязательно)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="Контекст связи: почему эта сущность связана"
            />
          </div>

          {hint}

          {error && (
            <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">
              {error}
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm border rounded hover:bg-gray-50"
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || selectedIds.size === 0}
            className={`px-4 py-1.5 text-sm text-white rounded disabled:opacity-50 ${colorClass}`}
          >
            {submitting
              ? 'Сохраняется…'
              : selectedIds.size > 1
                ? `${submitLabel} (${selectedIds.size})`
                : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
