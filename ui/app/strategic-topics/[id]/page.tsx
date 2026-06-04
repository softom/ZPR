'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useParams } from 'next/navigation'
import { useRole } from '@/lib/useRole'
import WorkflowPanels from './_components/WorkflowPanels'

type Topic = {
  id: string
  seq: number
  code: string | null
  title: string
  category: string
  synopsis: string
  threats: string
  solutions: string | null
  deadlines: string | null
  status: string
  owner_entity_id: string | null
  source_document_id: string | null
  source_quote: string | null
  notes: string | null
  published_revision_id: string | null
  published_at: string | null
  published_by_user_id: string | null
  created_at: string
  updated_at: string
  source_document: { id: string; title: string | null } | null
  owner: { id: string; name: string | null; short_name: string | null } | null
}

type LegalEntity = { id: string; name: string; short_name: string | null }

type RegenField = 'title' | 'synopsis' | 'threats' | 'solutions' | 'deadlines'

type CheckResult = {
  in_topic:  Array<{ quote: string; where: string;      comment: string }>
  missing:   Array<{ quote: string; suggestion: string }>
  off_topic: Array<{ quote: string; reason: string }>
}

const CATEGORY_LABEL: Record<string, string> = {
  environment:  'Средовое',
  engineering:  'Инженерное',
  land_legal:   'Земля/Право',
  organization: 'Организация',
  personnel:    'Кадры',
  contracting:  'Договоры',
}

const STATUS_LABEL: Record<string, string> = {
  open:         'Открыта',
  in_progress:  'В работе',
  mitigated:    'Купирована',
  resolved:     'Закрыта',
  cancelled:    'Отменена',
}

export default function StrategicTopicPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { isUploader, isAdmin } = useRole()

  const [topic, setTopic] = useState<Topic | null>(null)
  const [orgs, setOrgs] = useState<LegalEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [regenField, setRegenField] = useState<RegenField | null>(null)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  // Check-document modal
  const [checkOpen, setCheckOpen] = useState(false)
  const [checkText, setCheckText] = useState('')
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkError, setCheckError] = useState('')
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)

  const [form, setForm] = useState({
    seq: 1,
    code: '',
    title: '',
    category: 'organization',
    status: 'open',
    synopsis: '',
    threats: '',
    solutions: '',
    deadlines: '',
    owner_entity_id: '',
    source_quote: '',
    notes: '',
  })

  useEffect(() => {
    if (!params.id) return
    load()
    loadOrgs()
  }, [params.id])

  function applyTopicToForm(t: Topic) {
    setTopic(t)
    setForm({
      seq:             t.seq,
      code:            t.code ?? '',
      title:           t.title,
      category:        t.category,
      status:          t.status,
      synopsis:        t.synopsis,
      threats:         t.threats,
      solutions:       t.solutions ?? '',
      deadlines:       t.deadlines ?? '',
      owner_entity_id: t.owner_entity_id ?? '',
      source_quote:    t.source_quote ?? '',
      notes:           t.notes ?? '',
    })
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const r = await fetch(`/api/strategic-topics/${params.id}`)
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      applyTopicToForm(await r.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function loadOrgs() {
    try {
      const r = await fetch('/api/legal-entities?is_active=true')
      if (!r.ok) return
      const j = await r.json()
      setOrgs(j.items || [])
    } catch {}
  }

  async function save() {
    setSaving(true)
    setError('')
    setSavedFlash(false)
    try {
      const payload: Record<string, unknown> = {
        seq:             form.seq,
        code:            form.code,
        title:           form.title,
        category:        form.category,
        status:          form.status,
        synopsis:        form.synopsis,
        threats:         form.threats,
        solutions:       form.solutions,
        deadlines:       form.deadlines,
        owner_entity_id: form.owner_entity_id || null,
        source_quote:    form.source_quote,
        notes:           form.notes,
      }
      const r = await fetch(`/api/strategic-topics/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      // Обновляем topic — это снимает «грязный» статус формы.
      // НЕ перезаливаем форму через applyTopicToForm — у пользователя могли
      // остаться несохранённые правки, которые он сделал между PATCH и ответом.
      setTopic(j as Topic)
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function runCheck() {
    if (!checkText.trim()) {
      setCheckError('Вставьте текст документа в поле выше')
      return
    }
    setCheckRunning(true)
    setCheckError('')
    setCheckResult(null)
    try {
      const formTopic = {
        seq:       form.seq,
        title:     form.title,
        category:  form.category,
        synopsis:  form.synopsis,
        threats:   form.threats,
        solutions: form.solutions,
        deadlines: form.deadlines,
      }
      const r = await fetch(`/api/strategic-topics/${params.id}/check-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_text: checkText, topic: formTopic }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setCheckResult(j as CheckResult)
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : String(e))
    } finally {
      setCheckRunning(false)
    }
  }

  async function regenerate(field: RegenField) {
    setRegenField(field)
    setError('')
    try {
      // Передаём состояние формы — это критично, чтобы LLM работал с тем,
      // что пользователь напечатал прямо сейчас, а не с устаревшим DB-state.
      const formTopic = {
        title:        form.title,
        category:     form.category,
        synopsis:     form.synopsis,
        threats:      form.threats,
        solutions:    form.solutions,
        deadlines:    form.deadlines,
        source_quote: form.source_quote,
        notes:        form.notes,
      }
      const r = await fetch(`/api/strategic-topics/${params.id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, topic: formTopic }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      // Применяем ТОЛЬКО регенерированное поле в форму, остальные правки
      // пользователя сохраняются. Topic state обновляем целиком — для
      // корректного определения «грязности» формы.
      if (typeof j.value === 'string') {
        setForm(prev => ({ ...prev, [field]: j.value }))
      }
      if (j.topic) setTopic(j.topic as Topic)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRegenField(null)
    }
  }

  if (loading) return <div>Загрузка…</div>

  if (!topic) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link href="/strategic-topics" className="text-blue-600 hover:underline text-sm">
          ← Назад к списку
        </Link>
        <div className="mt-4 p-4 bg-red-50 text-red-700 border border-red-200 rounded">
          {error || 'Тема не найдена'}
        </div>
      </div>
    )
  }

  // ✨ regenerate на основной форме пишет в strategic_topics напрямую,
  // поэтому только admin. Для не-админа путь — «Предложить правку»
  // в секции «Правки» ниже (там у поля будет своя ✨ внутри revision-формы).
  const canRegen = isAdmin

  // Dirty: форма отличается от загруженного topic
  const isDirty = topic ? (
    form.seq !== topic.seq ||
    form.code !== (topic.code ?? '') ||
    form.title !== topic.title ||
    form.category !== topic.category ||
    form.status !== topic.status ||
    form.synopsis !== topic.synopsis ||
    form.threats !== topic.threats ||
    form.solutions !== (topic.solutions ?? '') ||
    form.deadlines !== (topic.deadlines ?? '') ||
    form.owner_entity_id !== (topic.owner_entity_id ?? '') ||
    form.source_quote !== (topic.source_quote ?? '') ||
    form.notes !== (topic.notes ?? '')
  ) : false

  const saveButton = (extraCls = '') => (
    <button
      onClick={save}
      disabled={saving || regenField !== null || !isAdmin || !isDirty}
      title={
        !isAdmin
          ? 'Прямая правка темы — только admin. Чтобы предложить правку, используйте секцию «Правки» ниже'
          : !isDirty
          ? 'Нет изменений'
          : ''
      }
      className={`px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed ${extraCls}`}
    >
      {saving ? 'Сохранение…' : 'Сохранить'}
    </button>
  )

  const stateChips = (
    <>
      {isDirty && (
        <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded whitespace-nowrap">
          ● несохранённые изменения
        </span>
      )}
      {savedFlash && (
        <span className="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded whitespace-nowrap">
          ✓ сохранено
        </span>
      )}
    </>
  )

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <Link href="/strategic-topics" className="text-blue-600 hover:underline text-sm">
          ← Все темы
        </Link>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => { setCheckOpen(true); setCheckError(''); setCheckResult(null) }}
            disabled={checkRunning}
            title="Вставить текст документа Word и проверить, что в нём учтено в теме, а что нет"
            className="px-3 py-2 bg-white border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 text-sm disabled:opacity-50"
          >
            📄 Проверить по документу
          </button>
          {stateChips}
          {saveButton()}
        </div>
      </div>

      {!isAdmin && isUploader && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900">
          ℹ️ Прямая правка темы — только у админа. Чтобы предложить изменения,
          прокрутите ниже к секции <strong>«Правки»</strong> и нажмите
          <strong> «✏️ Предложить правку»</strong> — админ рассмотрит и примет/отклонит.
        </div>
      )}

      <div className="bg-white rounded shadow">
        {/* Header */}
        <div className="p-6 border-b">
          <div className="flex items-end gap-4">
            <div className="shrink-0">
              <label className="block text-sm font-medium text-gray-700 mb-1">№</label>
              <input
                type="number"
                min={1}
                max={999}
                value={form.seq}
                onChange={e => {
                  const n = parseInt(e.target.value, 10)
                  if (Number.isFinite(n) && n >= 1 && n <= 999) {
                    setForm({ ...form, seq: n })
                  } else if (e.target.value === '') {
                    // позволяем поле временно пустым во время набора
                    setForm({ ...form, seq: 0 })
                  }
                }}
                disabled={!isAdmin}
                className={`w-24 px-3 py-2 text-2xl font-mono font-bold text-center border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${!isUploader ? 'bg-gray-50 text-gray-700' : 'border-gray-300'}`}
                title="Трёхзначный порядковый номер (1–999). Уникален. По нему сортируется список"
              />
              <p className="text-xs text-gray-400 mt-1 text-center font-mono">{String(form.seq).padStart(3, '0')}</p>
            </div>
            <div className="flex-1">
              <Field
                label="Название"
                value={form.title}
                onChange={v => setForm({ ...form, title: v })}
                disabled={!isAdmin}
                big
                onRegenerate={canRegen ? () => regenerate('title') : undefined}
                regenerating={regenField === 'title'}
                anyRegenerating={regenField !== null}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-4">
            <SelectField
              label="Категория"
              value={form.category}
              onChange={v => setForm({ ...form, category: v })}
              options={Object.entries(CATEGORY_LABEL)}
              disabled={!isAdmin}
            />
            <SelectField
              label="Статус"
              value={form.status}
              onChange={v => setForm({ ...form, status: v })}
              options={Object.entries(STATUS_LABEL)}
              disabled={!isAdmin}
            />
            <Field
              label="Код (опц.)"
              value={form.code}
              onChange={v => setForm({ ...form, code: v })}
              placeholder="KADRY, ROAD_TRANSFER…"
              disabled={!isAdmin}
            />
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 border-b">
          <Field
            label="Синопсис"
            value={form.synopsis}
            onChange={v => setForm({ ...form, synopsis: v })}
            disabled={!isAdmin}
            multiline
            autosize
            minRows={4}
            hint="1–4 предложения. Что происходит на эту тему, как сложилось, почему важно. Конкретика: числа, даты, участники, стадии"
            onRegenerate={canRegen ? () => regenerate('synopsis') : undefined}
            regenerating={regenField === 'synopsis'}
            anyRegenerating={regenField !== null}
          />
          <Field
            label="Угрозы"
            value={form.threats}
            onChange={v => setForm({ ...form, threats: v })}
            disabled={!isAdmin}
            multiline
            autosize
            minRows={3}
            hint="Что произойдёт если не реагировать. Будущее время, привязка к срокам/этапам"
            onRegenerate={canRegen ? () => regenerate('threats') : undefined}
            regenerating={regenField === 'threats'}
            anyRegenerating={regenField !== null}
          />
          <Field
            label="Решения"
            value={form.solutions}
            onChange={v => setForm({ ...form, solutions: v })}
            disabled={!isAdmin}
            multiline
            autosize
            minRows={3}
            hint="Что предлагается делать. Уровень намерения, без сроков и исполнителей"
            onRegenerate={canRegen ? () => regenerate('solutions') : undefined}
            regenerating={regenField === 'solutions'}
            anyRegenerating={regenField !== null}
          />
          <Field
            label="Сроки и контрольные точки"
            value={form.deadlines}
            onChange={v => setForm({ ...form, deadlines: v })}
            disabled={!isAdmin}
            multiline
            autosize
            minRows={2}
            onRegenerate={canRegen ? () => regenerate('deadlines') : undefined}
            regenerating={regenField === 'deadlines'}
            anyRegenerating={regenField !== null}
          />
        </div>

        {/* Meta */}
        <div className="p-6 border-b grid grid-cols-2 gap-4">
          <SelectField
            label="Владелец темы"
            value={form.owner_entity_id}
            onChange={v => setForm({ ...form, owner_entity_id: v })}
            options={[['', '—'] as [string, string], ...orgs.map(o => [o.id, o.short_name || o.name] as [string, string])]}
            disabled={!isAdmin}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Источник</label>
            {topic.source_document ? (
              <Link
                href={`/contracts/${topic.source_document.id}`}
                className="text-sm text-blue-600 hover:underline block py-2"
              >
                {topic.source_document.title || topic.source_document.id}
              </Link>
            ) : (
              <p className="text-sm text-gray-400 py-2 italic">
                Документ-источник не привязан
              </p>
            )}
          </div>
          <Field
            label="Цитата из источника"
            value={form.source_quote}
            onChange={v => setForm({ ...form, source_quote: v })}
            disabled={!isAdmin}
            multiline
            autosize
            minRows={2}
            colSpan2
          />
          <Field
            label="Заметки"
            value={form.notes}
            onChange={v => setForm({ ...form, notes: v })}
            disabled={!isAdmin}
            multiline
            autosize
            minRows={2}
            colSpan2
          />
        </div>

        {/* Workflow: Правки / Финальный документ / Обсуждение */}
        <WorkflowPanels topic={topic as Parameters<typeof WorkflowPanels>[0]['topic']} onTopicChange={load} />

        {/* Связи с проектом (на topic_focus, отложено до импорта ГПР) */}
        <div className="p-6 border-t bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Связи с графиком</h3>
          <p className="text-sm text-gray-500">
            Фокусы на сечениях графика, связанные задачи, события и плановые вехи —{' '}
            <span className="italic">появятся после переработки импорта ГПР и реализации модуля topic_focus.</span>
          </p>
          <p className="text-xs text-gray-400 mt-2">
            См. <span className="font-mono">MD WIKI/CLAUDE/24_Стратегические_темы.md</span>
          </p>
        </div>

        {/* Footer */}
        <div className="p-6 bg-gray-50 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="text-xs text-gray-400">
              Изменено: {new Date(topic.updated_at).toLocaleString('ru-RU')}
            </div>
            {isDirty && (
              <span className="text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
                ● несохранённые изменения
              </span>
            )}
            {savedFlash && (
              <span className="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded">
                ✓ сохранено
              </span>
            )}
          </div>
          <div className="flex gap-3 items-center">
            {error && (
              <div className="px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                {error}
              </div>
            )}
            {isAdmin && (
              <button
                onClick={async () => {
                  if (!confirm(`Удалить тему «${topic.title}»? Это действие необратимо.`)) return
                  setSaving(true)
                  try {
                    const r = await fetch(`/api/strategic-topics/${params.id}`, { method: 'DELETE' })
                    if (!r.ok) {
                      const j = await r.json().catch(() => ({}))
                      throw new Error(j.error || `HTTP ${r.status}`)
                    }
                    router.push('/strategic-topics')
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e))
                    setSaving(false)
                  }
                }}
                disabled={saving || regenField !== null}
                className="px-4 py-2 bg-white border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
              >
                Удалить
              </button>
            )}
            {saveButton()}
          </div>
        </div>
      </div>

      {checkOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={() => !checkRunning && setCheckOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-6 border-b flex items-baseline justify-between gap-3">
              <h2 className="text-xl font-semibold">
                Проверка темы по документу
              </h2>
              <button
                onClick={() => setCheckOpen(false)}
                disabled={checkRunning}
                className="text-gray-400 hover:text-gray-700 disabled:opacity-50 text-2xl leading-none"
                title="Закрыть"
              >
                ×
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Текст документа
                </label>
                <textarea
                  value={checkText}
                  onChange={e => setCheckText(e.target.value)}
                  placeholder="Вставьте текст из Word/PDF/любого источника. LLM сопоставит его с темой и покажет, что учтено, что не учтено и что не относится к теме."
                  rows={10}
                  disabled={checkRunning}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 font-mono"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {checkText.length} символов{checkText.length > 60000 ? ' — слишком много, лимит 60000' : ''}
                </p>
              </div>

              {checkError && (
                <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                  {checkError}
                </div>
              )}

              {checkResult && (
                <div className="space-y-4 pt-2 border-t">
                  <CheckSection
                    title="✓ Учтено в теме"
                    color="green"
                    items={checkResult.in_topic.map(it => ({
                      quote: it.quote,
                      meta: `${it.where}: ${it.comment}`,
                    }))}
                    emptyText="Ни одного фрагмента документа в теме не отражено"
                  />
                  <CheckSection
                    title="⚠️ Не учтено, но относится к теме"
                    color="amber"
                    items={checkResult.missing.map(it => ({
                      quote: it.quote,
                      meta: it.suggestion,
                    }))}
                    emptyText="Все релевантные фрагменты уже учтены"
                  />
                  <CheckSection
                    title="✗ Не относится к теме"
                    color="gray"
                    items={checkResult.off_topic.map(it => ({
                      quote: it.quote,
                      meta: it.reason,
                    }))}
                    emptyText="Весь документ по теме"
                  />
                </div>
              )}
            </div>
            <div className="p-6 border-t bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setCheckOpen(false)}
                disabled={checkRunning}
                className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Закрыть
              </button>
              <button
                onClick={runCheck}
                disabled={checkRunning || !checkText.trim() || checkText.length > 60000}
                className="px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
              >
                {checkRunning ? '⏳ Проверка…' : '✨ Проверить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CheckSection({
  title, color, items, emptyText,
}: {
  title: string
  color: 'green' | 'amber' | 'gray'
  items: Array<{ quote: string; meta: string }>
  emptyText: string
}) {
  const colorMap = {
    green: { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-800' },
    amber: { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-800' },
    gray:  { bg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-600' },
  }[color]
  return (
    <div>
      <h3 className={`text-sm font-semibold mb-2 ${colorMap.text}`}>
        {title} <span className="text-xs font-normal text-gray-400">({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 italic">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className={`p-3 ${colorMap.bg} ${colorMap.border} border rounded text-sm`}>
              <div className="text-gray-900 italic">«{it.quote}»</div>
              <div className={`text-xs mt-1 ${colorMap.text}`}>→ {it.meta}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
  autosize,
  minRows,
  big,
  disabled,
  colSpan2,
  onRegenerate,
  regenerating,
  anyRegenerating,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  multiline?: boolean
  autosize?: boolean
  minRows?: number
  big?: boolean
  disabled?: boolean
  colSpan2?: boolean
  onRegenerate?: () => void
  regenerating?: boolean
  anyRegenerating?: boolean
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const cls = `w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${disabled ? 'bg-gray-50 text-gray-700' : 'border-gray-300'} ${big ? 'text-xl font-semibold' : 'text-sm'}`

  // auto-resize: высота = scrollHeight при изменении value
  useEffect(() => {
    if (!multiline || !autosize) return
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, multiline, autosize])

  const showRegen = !!onRegenerate

  return (
    <div className={colSpan2 ? 'col-span-2' : ''}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <label className="block text-sm font-medium text-gray-700">{label}</label>
        {showRegen && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating || anyRegenerating || disabled}
            title="Переработать с LLM (Polza.AI)"
            className="px-2 py-0.5 bg-emerald-600 text-white text-[11px] rounded hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {regenerating ? '⏳' : '✨'}
          </button>
        )}
      </div>
      {multiline ? (
        <textarea
          ref={taRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={autosize ? (minRows ?? 2) : (minRows ?? 3)}
          disabled={disabled}
          className={`${cls} ${autosize ? 'resize-none overflow-hidden' : 'resize-y'}`}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cls}
        />
      )}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  )
}

function SelectField({
  label, value, onChange, options, disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: [string, string][]
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm ${disabled ? 'bg-gray-50 text-gray-700' : 'border-gray-300'}`}
      >
        {options.map(([k, v]) => (
          <option key={k} value={k}>{v}</option>
        ))}
      </select>
    </div>
  )
}
