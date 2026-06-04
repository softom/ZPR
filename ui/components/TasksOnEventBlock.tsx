'use client'

// ─── TasksOnEventBlock ────────────────────────────────────────────────────
// Inverse-секция «Задачи» в карточке события. Показывает задачи, которые
// ссылаются на это событие через entity_links (from_type='task', to_type='event').
// Группировка по link_type: raised_from / related_to / resolved_by.
//
// Контракт презентационный: компонент НЕ читает БД, НЕ пишет — только рендерит
// данные из props и зовёт колбэки. Используется в EventLinkModal.

import Link from 'next/link'

export type TaskRefMini = {
  id: string
  code: string
  title: string
  status: string
  priority: string | null
  assignee_entity_id: string | null
  due_date: string | null
}

export type TaskToEventLinkMini = {
  id: string
  from_id: string       // task.id
  to_id: string         // event.id
  link_type: 'raised_from' | 'related_to' | 'resolved_by'
}

const PHASE_META: Record<TaskToEventLinkMini['link_type'], { icon: string; label: string; color: string }> = {
  raised_from: { icon: '📌', label: 'Поставлены на событии', color: 'border-blue-400 bg-blue-50' },
  related_to:  { icon: '🔄', label: 'Связанные с событием',  color: 'border-amber-400 bg-amber-50' },
  resolved_by: { icon: '✅', label: 'Закрыты этим событием', color: 'border-green-400 bg-green-50' },
}

const STATUS_BADGE: Record<string, string> = {
  preliminary: 'bg-gray-100 text-gray-600',
  open:        'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  done:        'bg-green-100 text-green-700',
  closed:      'bg-gray-200 text-gray-600',
  cancelled:   'bg-red-100 text-red-600',
}

const STATUS_LABEL: Record<string, string> = {
  preliminary: 'Черновик',
  open:        'Открыта',
  in_progress: 'В работе',
  done:        'Выполнена',
  closed:      'Закрыта',
  cancelled:   'Отменена',
}

const PRIORITY_BADGE: Record<string, string> = {
  high:   'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low:    'bg-gray-100 text-gray-600',
}

type Props = {
  /** ID события (для фильтрации ссылок). */
  eventId: string
  /** Все task→event связи (caller их грузит). */
  links: TaskToEventLinkMini[]
  /** Реестр задач для резолва имён. */
  tasks: TaskRefMini[]
  /** Карта юр.лиц для отображения assignee. */
  entityNameById: Map<string, string>
  /** Колбэк при клике «+ Поставить задачу» (создание новой задачи raised_from). */
  onCreate?: () => void
  /** Колбэк при клике «+ Связать с задачей» в фазе (выбор СУЩЕСТВУЮЩЕЙ задачи). */
  onLinkExisting?: (linkType: TaskToEventLinkMini['link_type']) => void
  /** Колбэк при клике на удаление связи. Сама задача остаётся. */
  onUnlink?: (linkId: string) => void
}

export function TasksOnEventBlock({
  eventId, links, tasks, entityNameById, onCreate, onLinkExisting, onUnlink,
}: Props) {
  const myLinks = links.filter((l) => l.to_id === eventId)
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const phases: TaskToEventLinkMini['link_type'][] = ['raised_from', 'related_to', 'resolved_by']

  return (
    <div className="border-t pt-3 mt-2">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Задачи на событии <span className="text-gray-400 font-normal normal-case">({myLinks.length})</span>
        </h3>
        {onCreate && (
          <button
            onClick={onCreate}
            className="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
            title="Создать НОВУЮ задачу, поставленную на этом событии (raised_from)"
          >+ Поставить задачу</button>
        )}
      </div>

      {/* Показываем ВСЕ 3 фазы всегда (с кнопкой «+ Связать») — чтобы юзер мог
          привязать СУЩЕСТВУЮЩУЮ задачу как resolved_by/related_to/raised_from. */}
      <div className="space-y-2">
        {phases.map((phase) => {
          const phaseLinks = myLinks.filter((l) => l.link_type === phase)
          const meta = PHASE_META[phase]
          return (
            <div key={phase}>
              <div className="text-[11px] font-medium text-gray-600 mb-1 flex items-center gap-1">
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
                <span className="text-gray-400 font-normal">({phaseLinks.length})</span>
                {onLinkExisting && (
                  <button
                    onClick={() => onLinkExisting(phase)}
                    className="ml-auto text-[11px] text-blue-600 hover:underline"
                    title={`Привязать СУЩЕСТВУЮЩУЮ задачу как «${meta.label}»`}
                  >
                    + Связать с задачей
                  </button>
                )}
              </div>
              {phaseLinks.length === 0 ? (
                <p className="text-[11px] text-gray-400 italic pl-5">— нет —</p>
              ) : (
                <ul className="space-y-1">
                  {phaseLinks.map((l) => {
                    const task = tasksById.get(l.from_id)
                    if (!task) {
                      return (
                        <li key={l.id} className={`flex items-center gap-2 px-2 py-1 border-l-2 ${meta.color} rounded text-xs text-gray-400 italic`}>
                          (задача удалена) — связь {l.id.slice(0, 8)}
                          {onUnlink && (
                            <button onClick={() => onUnlink(l.id)} className="ml-auto text-gray-400 hover:text-red-600">✕</button>
                          )}
                        </li>
                      )
                    }
                    const assigneeName = task.assignee_entity_id
                      ? entityNameById.get(task.assignee_entity_id) ?? null
                      : null
                    const isOverdue = task.due_date
                      && !['done', 'closed', 'cancelled'].includes(task.status)
                      && new Date(task.due_date) < new Date(new Date().toDateString())
                    return (
                      <li
                        key={l.id}
                        className={`flex items-baseline gap-2 px-2 py-1 border-l-2 ${meta.color} rounded text-xs overflow-hidden`}
                      >
                        <Link
                          href={`/tasks#${task.id}`}
                          className="font-mono text-[10px] text-gray-500 shrink-0 hover:text-blue-700 hover:underline"
                          title={`Открыть задачу ${task.code}`}
                        >
                          {task.code}
                        </Link>
                        <span className="flex-1 min-w-0 truncate font-medium text-gray-900" title={task.title}>
                          {task.title}
                        </span>
                        {task.priority && (
                          <span className={`shrink-0 px-1 py-0.5 rounded text-[10px] ${PRIORITY_BADGE[task.priority] ?? 'bg-gray-100'}`}>
                            {task.priority === 'high' ? '!' : task.priority === 'low' ? '↓' : '~'}
                          </span>
                        )}
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${STATUS_BADGE[task.status] ?? 'bg-gray-100'}`}>
                          {STATUS_LABEL[task.status] ?? task.status}
                        </span>
                        {assigneeName && (
                          <span className="shrink-0 text-[10px] text-gray-500 max-w-[120px] truncate" title={assigneeName}>
                            {assigneeName}
                          </span>
                        )}
                        {task.due_date && (
                          <span className={`shrink-0 text-[10px] ${isOverdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                            {new Date(task.due_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                          </span>
                        )}
                        {onUnlink && (
                          <button
                            onClick={() => onUnlink(l.id)}
                            className="shrink-0 text-gray-400 hover:text-red-600 text-xs"
                            title="Открепить задачу от события (сама задача остаётся)"
                          >✕</button>
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
