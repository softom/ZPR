'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import { optionIconPrefix } from '@/lib/objects/iconLabel'

// ─── Типы ───────────────────────────────────────────────────────────────────

type TgMsg = {
  id: string
  chat_id: number
  msg_date: string
  sender_name: string | null
  media_kind: string | null
  media_file_name: string | null
  text: string | null
}

type EventTgLink = {
  tg_message_id: string
  confidence: number
  link_kind: string
  tg_messages: TgMsg | null
}

type PreliminaryEvent = {
  id: string
  event_type: string
  title: string | null
  note: string | null
  date_end: string | null
  date_start: string | null
  object_ids: string[] | null
  derived_source: string | null
  classifier_template_code: string | null
  created_at: string
  event_tg_messages: EventTgLink[] | null
}

type ObjectRef = {
  id: string
  code: string
  current_name: string
  color: string | null
  icon: string | null
  icon_small: string | null
}

type Template = {
  code: string
  label: string
  layer: string
}

type ChatRef = {
  chat_id: number
  title: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function fmtDateTime(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function confBadge(conf: number): string {
  if (conf >= 80) return 'bg-emerald-100 text-emerald-700'
  if (conf >= 60) return 'bg-blue-100 text-blue-700'
  if (conf >= 50) return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-500'
}

function layerBadge(layer: string): string {
  return layer === 'rule' ? 'bg-purple-100 text-purple-700' : 'bg-indigo-100 text-indigo-700'
}

// ─── Карточка одного preliminary события ────────────────────────────────────

function EventCard({
  ev,
  objects,
  templates,
  chats,
  onAccept,
  onReject,
  onRefresh,
}: {
  ev: PreliminaryEvent
  objects: ObjectRef[]
  templates: Map<string, Template>
  chats: Map<number, ChatRef>
  onAccept: () => void
  onReject: () => void
  onRefresh: () => void
}) {
  const [titleDraft, setTitleDraft] = useState(ev.title || '')
  const [noteDraft, setNoteDraft] = useState(ev.note || '')
  // Захватываем «автоматическую» версию title/note/objects на момент первого рендера —
  // нужна для записи в event_classifier_feedback (что предложил классификатор vs что осталось)
  const [autoTitle] = useState(ev.title || '')
  const [autoNote] = useState(ev.note || '')
  const [autoObjectIds] = useState<string[]>(ev.object_ids || [])
  // Текущий состав объектов (редактируется чипами ✕ + селектом +)
  const [objectIdsDraft, setObjectIdsDraft] = useState<string[]>(ev.object_ids || [])
  const [addObjectSelect, setAddObjectSelect] = useState('')
  const [saving, setSaving] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [showSource, setShowSource] = useState(true)
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)

  const tpl = ev.classifier_template_code ? templates.get(ev.classifier_template_code) : null
  const links = ev.event_tg_messages || []
  const objectsOfEvent = objectIdsDraft
    .map((oid) => objects.find((o) => o.id === oid))
    .filter((o): o is ObjectRef => !!o)
  const availableObjects = objects.filter((o) => !objectIdsDraft.includes(o.id))

  const avgConf = links.length
    ? Math.round(links.reduce((s, l) => s + (l.confidence || 0), 0) / links.length)
    : 0

  async function saveTitle() {
    const newTitle = titleDraft.trim()
    if (newTitle === (ev.title || '')) return
    if (!newTitle) { setTitleDraft(ev.title || ''); return }
    setSaving(true)
    await supabase.from('events').update({ title: newTitle }).eq('id', ev.id)
    setSaving(false)
    onRefresh()
  }

  async function saveNote() {
    if (noteDraft === (ev.note || '')) return
    setSaving(true)
    await supabase.from('events').update({ note: noteDraft || null }).eq('id', ev.id)
    setSaving(false)
    onRefresh()
  }

  async function saveObjectIds(newIds: string[]) {
    setSaving(true)
    const { error } = await supabase
      .from('events')
      .update({ object_ids: newIds })
      .eq('id', ev.id)
    setSaving(false)
    if (error) { alert(`Ошибка: ${error.message}`); return }
    setObjectIdsDraft(newIds)
  }

  async function removeObject(oid: string) {
    if (objectIdsDraft.length <= 1) {
      if (!confirm('Это последний объект события. Точно убрать (событие останется без объектов)?')) return
    }
    await saveObjectIds(objectIdsDraft.filter((x) => x !== oid))
  }

  async function addObject(oid: string) {
    if (!oid || objectIdsDraft.includes(oid)) return
    await saveObjectIds([...objectIdsDraft, oid])
    setAddObjectSelect('')
  }

  // Помечаем какие объекты изменились относительно auto-версии (для подсветки feedback-сигнала)
  const objectsAdded = objectIdsDraft.filter((oid) => !autoObjectIds.includes(oid))
  const objectsRemoved = autoObjectIds.filter((oid) => !objectIdsDraft.includes(oid))
  const objectsEdited = objectsAdded.length > 0 || objectsRemoved.length > 0

  // Snapshot для feedback (приоритет: media_file_name > text > '')
  function sourceQuote(): string {
    for (const l of links) {
      const m = l.tg_messages
      if (!m) continue
      if (m.media_file_name) return m.media_file_name
      if (m.text) return m.text.slice(0, 500)
    }
    return ''
  }

  async function recordFeedback(decision: 'accepted' | 'rejected') {
    try {
      const autoCodes = autoObjectIds
        .map((id) => objects.find((o) => o.id === id)?.code)
        .filter((c): c is string => !!c)
      const finalCodes = objectIdsDraft
        .map((id) => objects.find((o) => o.id === id)?.code)
        .filter((c): c is string => !!c)
      await supabase.from('event_classifier_feedback').insert({
        template_code: ev.classifier_template_code,
        layer: tpl?.layer || 'rule',
        decision,
        auto_title: autoTitle,
        final_title: decision === 'accepted' ? titleDraft : null,
        auto_note: autoNote || null,
        final_note: decision === 'accepted' ? (noteDraft || null) : null,
        title_edited: decision === 'accepted' && titleDraft !== autoTitle,
        source_quote: sourceQuote().slice(0, 500) || null,
        confidence: avgConf || null,
        auto_object_codes: autoCodes,
        object_codes: decision === 'accepted' ? finalCodes : autoCodes,
      })
    } catch (e) {
      // Не блокируем основное действие, если feedback не записался
      console.warn('feedback insert failed', e)
    }
  }

  async function accept() {
    setBusy('accept')
    await recordFeedback('accepted')
    const { error } = await supabase
      .from('events')
      .update({ is_preliminary: false })
      .eq('id', ev.id)
    setBusy(null)
    if (error) { alert(`Ошибка: ${error.message}`); return }
    onAccept()
  }

  async function reject() {
    if (!confirm(`Отбросить событие «${ev.title?.slice(0, 60)}…»? Связи с TG сохранятся.`)) return
    setBusy('reject')
    await recordFeedback('rejected')
    // Удаляем event (cascade удаляет event_tg_messages)
    const { error } = await supabase.from('events').delete().eq('id', ev.id)
    setBusy(null)
    if (error) { alert(`Ошибка: ${error.message}`); return }
    onReject()
  }

  return (
    <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-500 font-mono whitespace-nowrap">
          {fmtDate(ev.date_end)}
        </span>
        {tpl && (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${layerBadge(tpl.layer)}`}>
            {tpl.layer === 'rule' ? '⚙️' : '🤖'} {tpl.label}
          </span>
        )}
        {!tpl && ev.classifier_template_code && (
          <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 font-mono">
            {ev.classifier_template_code}
          </span>
        )}
        {avgConf > 0 && (
          <span
            className={`px-2 py-0.5 rounded text-xs font-mono ${confBadge(avgConf)}`}
            title="Средняя уверенность по связям с TG"
          >
            conf {avgConf}
          </span>
        )}
        {objectsOfEvent.map((o) => {
          const isAdded = objectsAdded.includes(o.id)
          return (
            <span
              key={o.id}
              title={`${o.current_name}${isAdded ? '  ← добавлен оператором' : ''}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono rounded border-l-2 ${
                isAdded
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-300'
                  : 'bg-blue-100 text-blue-700'
              }`}
              style={{ borderLeftColor: o.color ?? '#cbd5e1' }}
            >
              {o.icon_small ? (
                <img src={o.icon_small} alt="" className="w-3.5 h-3.5 object-contain" />
              ) : o.icon ? (
                <span aria-hidden>{o.icon}</span>
              ) : null}
              {o.code}
              <button
                onClick={() => removeObject(o.id)}
                disabled={saving || busy !== null}
                className="ml-0.5 px-0.5 text-blue-400 hover:text-red-600 disabled:opacity-30"
                title="Убрать объект (правка пойдёт в feedback)"
              >
                ✕
              </button>
            </span>
          )
        })}
        {/* Объекты, которые классификатор предложил, но оператор убрал — показываем мутным для feedback */}
        {objectsRemoved.map((oid) => {
          const o = objects.find((x) => x.id === oid)
          if (!o) return null
          return (
            <span
              key={`removed-${oid}`}
              title={`${o.current_name}  ← убран оператором`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-50 text-red-400 text-xs font-mono rounded line-through border border-dashed border-red-200"
            >
              {o.code}
              <button
                onClick={() => addObject(oid)}
                disabled={saving || busy !== null}
                className="ml-0.5 text-red-300 hover:text-emerald-600"
                title="Вернуть"
              >
                ↶
              </button>
            </span>
          )
        })}
        {/* Селект «+ объект» */}
        {availableObjects.length > 0 && (
          <select
            value={addObjectSelect}
            onChange={(e) => addObject(e.target.value)}
            disabled={saving || busy !== null}
            className="text-xs px-1.5 py-0.5 border border-gray-300 rounded bg-white text-gray-600 hover:bg-gray-50"
            title="Добавить объект (правка пойдёт в feedback)"
          >
            <option value="">+ объект</option>
            {availableObjects.map((o) => (
              <option key={o.id} value={o.id}>
                {optionIconPrefix(o.icon)}{o.code}
              </option>
            ))}
          </select>
        )}
        {objectsEdited && (
          <span
            className="px-1.5 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded"
            title="Состав объектов изменён относительно того, что предложил классификатор. При accept/reject diff пойдёт в feedback и обучит LLM."
          >
            ↻ кейс для обучения
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={accept}
          disabled={busy !== null}
          className="px-3 py-1 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
          title="Принять как подтверждённое событие (is_preliminary = false)"
        >
          {busy === 'accept' ? '⏳' : '✅'} Принять
        </button>
        <button
          onClick={reject}
          disabled={busy !== null}
          className="px-3 py-1 bg-red-100 text-red-700 text-sm rounded hover:bg-red-200 disabled:opacity-50 flex items-center gap-1"
          title="Удалить событие (cascade на связи с TG)"
        >
          {busy === 'reject' ? '⏳' : '🗑'} Отбросить
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Title — inline editable */}
        <textarea
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          rows={1}
          disabled={saving || busy !== null}
          className="w-full text-base font-semibold bg-transparent border border-transparent hover:border-gray-200 focus:border-blue-300 focus:bg-white rounded px-2 py-1 resize-y outline-none"
          title="Кликните, чтобы отредактировать заголовок"
        />

        {/* Note — collapsible */}
        {(ev.note || showNote) && (
          <div>
            <button
              onClick={() => setShowNote((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-700 mb-1"
            >
              {showNote ? '▾' : '▸'} Комментарий
            </button>
            {showNote && (
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={saveNote}
                rows={4}
                disabled={saving || busy !== null}
                placeholder="Свободный текст…"
                className="w-full px-2 py-1.5 border rounded text-sm font-mono resize-y"
              />
            )}
            {!showNote && ev.note && (
              <div className="text-xs text-gray-600 italic line-clamp-3 whitespace-pre-line px-2">
                {ev.note}
              </div>
            )}
          </div>
        )}

        {/* Source TG messages */}
        {links.length > 0 && (
          <div className="bg-sky-50 border border-sky-200 rounded p-3">
            <button
              onClick={() => setShowSource((v) => !v)}
              className="text-xs font-semibold uppercase tracking-wider text-sky-700 mb-2 hover:text-sky-900"
            >
              {showSource ? '▾' : '▸'} Источник в Telegram ({links.length})
            </button>
            {showSource && (
              <ul className="space-y-2">
                {links.map((l) => {
                  const m = l.tg_messages
                  if (!m) return null
                  const chatTitle = chats.get(m.chat_id)?.title || `chat ${m.chat_id}`
                  return (
                    <li key={l.tg_message_id} className="text-sm border-l-2 border-sky-300 pl-2">
                      <div className="flex items-center gap-2 text-xs text-gray-600 flex-wrap">
                        <span className="font-mono">{fmtDateTime(m.msg_date)}</span>
                        <span className="font-medium">{m.sender_name || 'unknown'}</span>
                        <span className="text-gray-400">·</span>
                        <span className="text-gray-500">{chatTitle}</span>
                        <span className={`ml-auto px-1.5 py-0.5 rounded text-xs font-mono ${confBadge(l.confidence)}`}>
                          {l.confidence}
                        </span>
                      </div>
                      {m.media_file_name && (
                        <div className="text-xs text-sky-800 mt-0.5">
                          📎 {m.media_file_name}
                          {m.media_kind && <span className="text-sky-500"> ({m.media_kind})</span>}
                        </div>
                      )}
                      {m.text && (
                        <div className="text-sm text-gray-700 mt-1 whitespace-pre-line break-words line-clamp-6">
                          {m.text}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Главная ────────────────────────────────────────────────────────────────

export default function PreliminaryEventsPage() {
  const { isAdmin, isLoggedIn } = useRole()
  const [events, setEvents] = useState<PreliminaryEvent[]>([])
  const [objects, setObjects] = useState<ObjectRef[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [chats, setChats] = useState<ChatRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterObject, setFilterObject] = useState<string>('')
  const [filterTemplate, setFilterTemplate] = useState<string>('')
  // session-stats
  const [accepted, setAccepted] = useState(0)
  const [rejected, setRejected] = useState(0)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [ev, ob, tp, ch] = await Promise.all([
        supabase
          .from('events')
          .select(`
            id, event_type, title, note, date_end, date_start,
            object_ids, derived_source, classifier_template_code, created_at,
            event_tg_messages (
              tg_message_id, confidence, link_kind,
              tg_messages (
                id, chat_id, msg_date, sender_name,
                media_kind, media_file_name, text
              )
            )
          `)
          .eq('is_preliminary', true)
          .order('date_end', { ascending: false }),
        supabase.from('objects').select('id,code,current_name,color,icon,icon_small').eq('active', true).order('code'),
        supabase.from('event_classifier_templates').select('code,label,layer').eq('active', true),
        supabase.from('tg_chats').select('chat_id,title'),
      ])
      if (ev.error) throw ev.error
      setEvents((ev.data as unknown as PreliminaryEvent[]) || [])
      setObjects((ob.data as ObjectRef[]) || [])
      setTemplates((tp.data as Template[]) || [])
      setChats((ch.data as ChatRef[]) || [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const templatesMap = useMemo(() => {
    const m = new Map<string, Template>()
    for (const t of templates) m.set(t.code, t)
    return m
  }, [templates])

  const chatsMap = useMemo(() => {
    const m = new Map<number, ChatRef>()
    for (const c of chats) m.set(c.chat_id, c)
    return m
  }, [chats])

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (filterObject && !(e.object_ids || []).includes(filterObject)) return false
      if (filterTemplate && e.classifier_template_code !== filterTemplate) return false
      return true
    })
  }, [events, filterObject, filterTemplate])

  // Группировка по объектам — счётчики в фильтре
  const objectCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) {
      for (const oid of e.object_ids || []) {
        m.set(oid, (m.get(oid) || 0) + 1)
      }
    }
    return m
  }, [events])

  const templateCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) {
      if (!e.classifier_template_code) continue
      m.set(e.classifier_template_code, (m.get(e.classifier_template_code) || 0) + 1)
    }
    return m
  }, [events])

  // Гейт: страница только для admin
  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <Link href="/events" className="text-sm text-gray-500 hover:text-gray-700">
          ← Все события
        </Link>
        <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">🔒</div>
          <div className="text-lg font-medium text-amber-900 mb-1">
            Доступ только для администраторов
          </div>
          <div className="text-sm text-amber-700">
            Ревью preliminary событий из автомата-классификатора — административная задача.
            {!isLoggedIn && ' Войдите в систему с правами admin.'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/events" className="text-sm text-gray-500 hover:text-gray-700">
            ← Все события
          </Link>
          <span className="text-gray-300">/</span>
          <h1 className="text-2xl font-bold">На ревью</h1>
          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-sm font-medium">
            {events.length}
          </span>
        </div>
        <div className="text-sm text-gray-600 flex items-center gap-3">
          {accepted > 0 && <span className="text-emerald-700">✅ принято: {accepted}</span>}
          {rejected > 0 && <span className="text-red-700">🗑 отброшено: {rejected}</span>}
          <button
            onClick={load}
            className="px-2 py-1 text-xs border rounded hover:bg-gray-50"
            title="Обновить"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Описание */}
      <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-4 text-sm text-amber-900">
        <strong>Что это:</strong> события, созданные автоматически классификатором{' '}
        <code className="bg-amber-100 px-1 rounded">tg_classifier.py</code> из Telegram-сообщений.
        Каждое — со связкой на источник.
        <br />
        <strong>Действия:</strong> <span className="text-emerald-800">✅ Принять</span> → событие станет финальным
        и попадёт в общую ленту. <span className="text-red-800">🗑 Отбросить</span> → удалить безвозвратно.
        Заголовок и комментарий можно править прямо здесь (клик → правка → клик вне).
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {/* Фильтры */}
      {events.length > 0 && (
        <div className="bg-white rounded shadow p-3 mb-4 flex items-center gap-3 flex-wrap text-sm">
          <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Фильтр:</span>
          <select
            value={filterObject}
            onChange={(e) => setFilterObject(e.target.value)}
            className="px-2 py-1 border rounded text-sm"
          >
            <option value="">Все объекты ({events.length})</option>
            {Array.from(objectCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([oid, cnt]) => {
                const o = objects.find((x) => x.id === oid)
                return (
                  <option key={oid} value={oid}>
                    {o?.code || oid.slice(0, 8)} ({cnt})
                  </option>
                )
              })}
          </select>
          <select
            value={filterTemplate}
            onChange={(e) => setFilterTemplate(e.target.value)}
            className="px-2 py-1 border rounded text-sm"
          >
            <option value="">Все типы</option>
            {Array.from(templateCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([code, cnt]) => {
                const t = templatesMap.get(code)
                return (
                  <option key={code} value={code}>
                    {t?.layer === 'rule' ? '⚙️' : '🤖'} {t?.label || code} ({cnt})
                  </option>
                )
              })}
          </select>
          {(filterObject || filterTemplate) && (
            <button
              onClick={() => { setFilterObject(''); setFilterTemplate('') }}
              className="text-xs text-red-600 hover:text-red-800"
            >
              ✕ Сбросить
            </button>
          )}
          <span className="text-xs text-gray-500 ml-auto">
            Показано: <b>{filtered.length}</b> из {events.length}
          </span>
        </div>
      )}

      {/* Список */}
      {loading ? (
        <div className="text-gray-400 py-12 text-center">Загрузка…</div>
      ) : events.length === 0 ? (
        <div className="bg-white rounded shadow p-8 text-center">
          <div className="text-5xl mb-3">🎉</div>
          <div className="text-lg text-gray-700 mb-2">Очередь пуста</div>
          <div className="text-sm text-gray-500 max-w-md mx-auto">
            Нет ожидающих ревью preliminary событий. Запусти{' '}
            <code className="bg-gray-100 px-1 rounded">tg_classifier.py --apply</code>{' '}
            чтобы создать новые из недавних сообщений.
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded shadow p-6 text-center text-gray-400">
          Нет событий по выбранным фильтрам
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((ev) => (
            <EventCard
              key={ev.id}
              ev={ev}
              objects={objects}
              templates={templatesMap}
              chats={chatsMap}
              onAccept={() => { setEvents((prev) => prev.filter((x) => x.id !== ev.id)); setAccepted((n) => n + 1) }}
              onReject={() => { setEvents((prev) => prev.filter((x) => x.id !== ev.id)); setRejected((n) => n + 1) }}
              onRefresh={async () => {
                // Перезагрузить одно событие
                const { data } = await supabase
                  .from('events')
                  .select(`
                    id, event_type, title, note, date_end, date_start,
                    object_ids, derived_source, classifier_template_code, created_at,
                    event_tg_messages (
                      tg_message_id, confidence, link_kind,
                      tg_messages (
                        id, chat_id, msg_date, sender_name,
                        media_kind, media_file_name, text
                      )
                    )
                  `)
                  .eq('id', ev.id)
                  .maybeSingle()
                if (data) {
                  setEvents((prev) => prev.map((x) => x.id === ev.id ? (data as unknown as PreliminaryEvent) : x))
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
