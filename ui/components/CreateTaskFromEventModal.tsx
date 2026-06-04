'use client'

// ─── CreateTaskFromEventModal ─────────────────────────────────────────────
// Простая форма для создания задачи из карточки события.
// При submit caller выполняет:
//   1) INSERT в tasks
//   2) entity_link raised_from (task → event)
//   3) task_object_status для каждого object_id (open)
//
// Контракт: компонент НЕ пишет в БД сам — onSubmit возвращает строку с
// ошибкой или null. Используется в /events/page.tsx.

import { useEffect, useState } from 'react'

export type CreateTaskFromEventArgs = {
  title: string
  explanation: string | null
  priority: 'high' | 'medium' | 'low'
  assignee_entity_id: string | null
  start_date: string | null
  due_date: string | null
  object_ids: string[]
}

type Props = {
  /** Имя/код события — отображается в шапке. */
  eventTitle: string
  eventCode: string
  /** Дата события — используется как дефолтная дата начала задачи. */
  eventDate: string
  /** object_ids события — по умолчанию задача наследует их. */
  defaultObjectIds: string[]
  /** Справочник юр.лиц для выбора assignee. */
  entities: Array<{ id: string; name: string; short_name: string | null }>
  /** Справочник объектов для выбора (наследуем из события, можно редактировать). */
  objects: Array<{ id: string; code: string; current_name: string }>
  onClose: () => void
  onSubmit: (args: CreateTaskFromEventArgs) => Promise<string | null>
}

export function CreateTaskFromEventModal({
  eventTitle, eventCode, eventDate, defaultObjectIds, entities, objects, onClose, onSubmit,
}: Props) {
  const [title, setTitle]               = useState('')
  const [explanation, setExplanation]   = useState('')
  const [priority, setPriority]         = useState<'high' | 'medium' | 'low'>('medium')
  const [assigneeId, setAssigneeId]     = useState<string>('')
  const [startDate, setStartDate]       = useState(eventDate)
  const [dueDate, setDueDate]           = useState('')
  const [objectIds, setObjectIds]       = useState<string[]>(defaultObjectIds)
  const [submitting, setSubmitting]     = useState(false)
  const [error, setError]               = useState<string | null>(null)

  // Сброс при открытии (mount)
  useEffect(() => { setObjectIds(defaultObjectIds) }, [defaultObjectIds])

  function toggleObject(id: string) {
    setObjectIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  async function handleSubmit() {
    if (!title.trim()) { setError('Введите название задачи'); return }
    setSubmitting(true)
    setError(null)
    const err = await onSubmit({
      title:              title.trim(),
      explanation:        explanation.trim() || null,
      priority,
      assignee_entity_id: assigneeId || null,
      start_date:         startDate || null,
      due_date:           dueDate || null,
      object_ids:         objectIds,
    })
    setSubmitting(false)
    if (err) setError(err)
  }

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
            Поставить задачу — связь raised_from с событием
          </div>
          <h2 className="text-base font-semibold mt-0.5">{eventTitle}</h2>
          <div className="text-xs text-gray-500 mt-1 font-mono">{eventCode}</div>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Название задачи <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Что нужно сделать"
              className="w-full px-2 py-1.5 border rounded text-sm"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Описание / пояснение
            </label>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              rows={2}
              className="w-full px-2 py-1.5 border rounded text-sm"
              placeholder="Контекст, детали, ссылки на материалы (опционально)"
            />
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Приоритет
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'high' | 'medium' | 'low')}
                className="w-full px-2 py-1.5 border rounded text-sm"
              >
                <option value="high">Высокий</option>
                <option value="medium">Средний</option>
                <option value="low">Низкий</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Дата начала
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-2 py-1.5 border rounded text-sm"
                title="По умолчанию — дата события"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Срок
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-2 py-1.5 border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Ответственный
              </label>
              <select
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="w-full px-2 py-1.5 border rounded text-sm"
              >
                <option value="">— не выбран —</option>
                {entities.map((le) => (
                  <option key={le.id} value={le.id}>{le.short_name || le.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Объекты (унаследованы из события — отредактируйте, если нужно)
            </label>
            <div className="max-h-32 overflow-y-auto border rounded p-2">
              {objects.length === 0 ? (
                <p className="text-xs text-gray-400 italic">Активных объектов нет</p>
              ) : (
                <div className="grid grid-cols-1 gap-1">
                  {objects.map((o) => (
                    <label key={o.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-gray-50 px-1">
                      <input
                        type="checkbox"
                        checked={objectIds.includes(o.id)}
                        onChange={() => toggleObject(o.id)}
                      />
                      <span className="font-mono text-gray-500 w-32 shrink-0">{o.code}</span>
                      <span className="truncate">{o.current_name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Для каждого выбранного объекта создаётся запись task_object_status со статусом «open».
            </p>
          </div>

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
          >Отмена</button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !title.trim()}
            className="px-4 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
          >
            {submitting ? 'Создаётся…' : 'Создать задачу'}
          </button>
        </div>
      </div>
    </div>
  )
}
