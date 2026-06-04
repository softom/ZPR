'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'

/**
 * Три секции workflow стратегической темы:
 *   - Правки (topic_revisions) — список, создание, approve/reject (admin)
 *   - Обсуждение (topic_comments) — плоский список + textarea
 *   - Финальный документ — скачать .docx + admin может зафиксировать approved-ревизию
 *
 * См. WIKI 24, раздел «Workflow B: явная фиксация финального документа».
 */

export type Topic = {
  id: string
  seq: number
  title: string
  category: string
  status: string
  synopsis: string
  threats: string
  solutions: string | null
  deadlines: string | null
  published_revision_id: string | null
  published_at: string | null
  published_by_user_id: string | null
}

type Revision = {
  id: string
  topic_id: string
  author_user_id: string | null
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'changes_requested'
  proposed_seq: number | null
  proposed_title: string | null
  proposed_category: string | null
  proposed_synopsis: string | null
  proposed_threats: string | null
  proposed_solutions: string | null
  proposed_deadlines: string | null
  base_snapshot: Record<string, unknown> | null
  review_comment: string | null
  reviewer_user_id: string | null
  reviewed_at: string | null
  submitted_at: string | null
  created_at: string
  updated_at: string
}

type Comment = {
  id: string
  revision_id: string | null
  field_name: string | null
  author_user_id: string | null
  author_name: string | null
  body: string
  created_at: string
}

const STATUS_LABEL: Record<string, string> = {
  draft:             'Черновик',
  pending_review:    'На согласовании',
  approved:          'Принято',
  rejected:          'Отклонено',
  changes_requested: 'Запрошены изменения',
}
const STATUS_COLOR: Record<string, string> = {
  draft:             'bg-gray-100  text-gray-700',
  pending_review:    'bg-yellow-100 text-yellow-800',
  approved:          'bg-green-100 text-green-800',
  rejected:          'bg-red-100   text-red-700',
  changes_requested: 'bg-orange-100 text-orange-800',
}

const FIELD_LABEL: Record<string, string> = {
  seq:       'Номер',
  title:     'Название',
  category:  'Категория',
  synopsis:  'Синопсис',
  threats:   'Угрозы',
  solutions: 'Решения',
  deadlines: 'Сроки',
}

export default function WorkflowPanels({ topic, onTopicChange }: { topic: Topic; onTopicChange: () => void }) {
  const { isAdmin, isUploader } = useRole()
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [revModal, setRevModal] = useState<{ mode: 'create' | 'view'; revision: Revision | null } | null>(null)

  useEffect(() => {
    load()
  }, [topic.id])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const token = await getToken()
      const [revR, comR] = await Promise.all([
        fetch(`/api/strategic-topics/${topic.id}/revisions`, { headers: authHeaders(token) }),
        fetch(`/api/strategic-topics/${topic.id}/comments`),
      ])
      if (!revR.ok) throw new Error(`revisions: HTTP ${revR.status}`)
      if (!comR.ok) throw new Error(`comments:  HTTP ${comR.status}`)
      const revJ = await revR.json()
      const comJ = await comR.json()
      setRevisions(revJ.items || [])
      setComments(comJ.items || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const publishedRev = useMemo(
    () => revisions.find(r => r.id === topic.published_revision_id) || null,
    [revisions, topic.published_revision_id],
  )

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Загрузка правок и комментариев…</div>
  }

  return (
    <>
      {error && (
        <div className="m-6 p-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          {error}
        </div>
      )}

      <RevisionsSection
        topic={topic}
        revisions={revisions}
        isAdmin={isAdmin}
        isUploader={isUploader}
        onCreate={() => setRevModal({ mode: 'create', revision: null })}
        onOpen={(r) => setRevModal({ mode: 'view', revision: r })}
      />

      <FinalDocSection
        topic={topic}
        publishedRev={publishedRev}
        approvedRevisions={revisions.filter(r => r.status === 'approved')}
        isAdmin={isAdmin}
        onChange={onTopicChange}
        onError={setError}
      />

      <CommentsSection
        topic={topic}
        comments={comments}
        isUploader={isUploader}
        onChange={load}
        onError={setError}
      />

      {revModal && (
        <RevisionModal
          topic={topic}
          mode={revModal.mode}
          revision={revModal.revision}
          isAdmin={isAdmin}
          isUploader={isUploader}
          onClose={() => setRevModal(null)}
          onSaved={async () => { setRevModal(null); onTopicChange(); await load() }}
        />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Правки
// ─────────────────────────────────────────────────────────────────────────

function RevisionsSection({
  topic, revisions, isAdmin, isUploader, onCreate, onOpen,
}: {
  topic: Topic
  revisions: Revision[]
  isAdmin: boolean
  isUploader: boolean
  onCreate: () => void
  onOpen: (r: Revision) => void
}) {
  const pendingCount = revisions.filter(r => r.status === 'pending_review').length
  return (
    <div className="p-6 border-t">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">
          Правки <span className="text-gray-400 font-normal">({revisions.length})</span>
          {pendingCount > 0 && (
            <span className="ml-2 inline-block px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-800">
              {pendingCount} на согласовании
            </span>
          )}
        </h3>
        {isUploader && (
          <button
            onClick={onCreate}
            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            ✏️ Предложить правку
          </button>
        )}
      </div>
      {revisions.length === 0 ? (
        <p className="text-sm text-gray-400">Правок пока нет</p>
      ) : (
        <ul className="space-y-2">
          {revisions.map(r => {
            const changedFields = countChangedFields(r, topic)
            return (
              <li
                key={r.id}
                onClick={() => onOpen(r)}
                className="cursor-pointer p-3 border border-gray-200 rounded hover:bg-gray-50 hover:border-blue-300"
              >
                <div className="flex items-center gap-2 mb-1 flex-wrap text-sm">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOR[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                  </span>
                  <span className="text-gray-500 text-xs">
                    {changedFields} полей изменено
                  </span>
                  {r.id === topic.published_revision_id && (
                    <span className="inline-block px-2 py-0.5 rounded text-xs bg-purple-100 text-purple-800">
                      📄 финальный документ
                    </span>
                  )}
                  <span className="ml-auto text-xs text-gray-400">
                    {new Date(r.updated_at).toLocaleString('ru-RU')}
                  </span>
                </div>
                {r.review_comment && (
                  <p className="text-xs text-gray-600 italic mt-1">«{r.review_comment}»</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {isAdmin && (
        <p className="text-xs text-gray-400 mt-2">
          Чёрновик видит только его автор. После «Отправить на согласование» — виден всем.
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Финальный документ
// ─────────────────────────────────────────────────────────────────────────

function FinalDocSection({
  topic, publishedRev, approvedRevisions, isAdmin, onChange, onError,
}: {
  topic: Topic
  publishedRev: Revision | null
  approvedRevisions: Revision[]
  isAdmin: boolean
  onChange: () => void
  onError: (s: string) => void
}) {
  const [selectedRevId, setSelectedRevId] = useState('')
  const [busy, setBusy] = useState(false)

  async function publish() {
    if (!selectedRevId) return
    setBusy(true)
    onError('')
    try {
      const token = await getToken()
      const r = await fetch(`/api/strategic-topics/${topic.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ revision_id: selectedRevId }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setSelectedRevId('')
      onChange()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function unpublish() {
    if (!confirm('Отозвать публикацию? Финальный документ перестанет быть доступным для скачивания.')) return
    setBusy(true)
    onError('')
    try {
      const token = await getToken()
      const r = await fetch(`/api/strategic-topics/${topic.id}/publish`, {
        method: 'DELETE',
        headers: authHeaders(token),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      onChange()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 border-t bg-purple-50">
      <h3 className="text-sm font-semibold text-purple-900 mb-3">
        📄 Финальный документ
      </h3>
      {publishedRev ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-700">
            Зафиксирована ревизия от {new Date(publishedRev.created_at).toLocaleString('ru-RU')}
            {topic.published_at && (
              <span className="text-gray-500"> · публикация: {new Date(topic.published_at).toLocaleString('ru-RU')}</span>
            )}
          </p>
          <div className="flex gap-3 items-center flex-wrap">
            <a
              href={`/api/strategic-topics/${topic.id}/render?format=docx`}
              className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm"
            >
              ⬇️ Скачать .docx
            </a>
            {isAdmin && (
              <button
                onClick={unpublish}
                disabled={busy}
                className="px-3 py-2 bg-white border border-purple-300 text-purple-700 rounded hover:bg-purple-100 text-sm disabled:opacity-50"
              >
                Отозвать публикацию
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 italic">
            Финальный документ не зафиксирован
          </p>
          {isAdmin && approvedRevisions.length > 0 && (
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">
                  Зафиксировать approved-ревизию:
                </label>
                <select
                  value={selectedRevId}
                  onChange={e => setSelectedRevId(e.target.value)}
                  disabled={busy}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">— выберите —</option>
                  {approvedRevisions.map(r => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.created_at).toLocaleString('ru-RU')} — {countChangedFields(r, topic)} полей
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={publish}
                disabled={busy || !selectedRevId}
                className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm disabled:opacity-50"
              >
                Зафиксировать
              </button>
            </div>
          )}
          {isAdmin && approvedRevisions.length === 0 && (
            <p className="text-xs text-gray-500">
              Нет одобренных ревизий, которые можно зафиксировать. Нужно сначала принять хотя бы одну правку.
            </p>
          )}
          {!isAdmin && (
            <p className="text-xs text-gray-500">
              Финальный документ фиксирует администратор.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Обсуждение
// ─────────────────────────────────────────────────────────────────────────

function CommentsSection({
  topic, comments, isUploader, onChange, onError,
}: {
  topic: Topic
  comments: Comment[]
  isUploader: boolean
  onChange: () => Promise<void> | void
  onError: (s: string) => void
}) {
  const [body, setBody] = useState('')
  const [field, setField] = useState('')
  const [busy, setBusy] = useState(false)

  async function post() {
    if (!body.trim()) return
    setBusy(true)
    onError('')
    try {
      const token = await getToken()
      const r = await fetch(`/api/strategic-topics/${topic.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ body, field_name: field || null }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setBody('')
      setField('')
      await onChange()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('Удалить комментарий?')) return
    onError('')
    try {
      const token = await getToken()
      const r = await fetch(`/api/strategic-topics/${topic.id}/comments/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      await onChange()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="p-6 border-t">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Обсуждение <span className="text-gray-400 font-normal">({comments.length})</span>
      </h3>
      {comments.length === 0 ? (
        <p className="text-sm text-gray-400">Комментариев пока нет</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {comments.map(c => (
            <li key={c.id} className="p-3 bg-gray-50 border border-gray-200 rounded">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-sm font-medium text-gray-700">{c.author_name || '(автор)'}</span>
                <span className="text-xs text-gray-400">
                  {c.field_name && <span className="mr-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{FIELD_LABEL[c.field_name] ?? c.field_name}</span>}
                  {new Date(c.created_at).toLocaleString('ru-RU')}
                </span>
              </div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{c.body}</p>
              <button
                onClick={() => remove(c.id)}
                className="text-xs text-gray-400 hover:text-red-700 mt-1"
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      )}
      {isUploader && (
        <div className="space-y-2">
          <div className="flex gap-2 items-end">
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={2}
              placeholder="Комментарий…"
              className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex gap-2 items-center">
            <select
              value={field}
              onChange={e => setField(e.target.value)}
              className="px-2 py-1 border border-gray-300 rounded text-xs"
            >
              <option value="">К теме целиком</option>
              {Object.entries(FIELD_LABEL).map(([k, v]) => (
                <option key={k} value={k}>К полю «{v}»</option>
              ))}
            </select>
            <button
              onClick={post}
              disabled={busy || !body.trim()}
              className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-xs disabled:opacity-50"
            >
              {busy ? 'Отправка…' : 'Добавить'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Модалка ревизии (создание / просмотр / правка / approve / reject)
// ─────────────────────────────────────────────────────────────────────────

function RevisionModal({
  topic, mode, revision, isAdmin, isUploader, onClose, onSaved,
}: {
  topic: Topic
  mode: 'create' | 'view'
  revision: Revision | null
  isAdmin: boolean
  isUploader: boolean
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  // Начальные значения proposed_*: при create = текущие значения темы;
  // при view = из revision (если poле NULL — current value темы).
  const [form, setForm] = useState<RevForm>({
    seq:       (revision?.proposed_seq ?? topic.seq),
    title:     (revision?.proposed_title ?? topic.title),
    category:  (revision?.proposed_category ?? topic.category),
    synopsis:  (revision?.proposed_synopsis ?? topic.synopsis),
    threats:   (revision?.proposed_threats ?? topic.threats),
    solutions: (revision?.proposed_solutions ?? topic.solutions ?? ''),
    deadlines: (revision?.proposed_deadlines ?? topic.deadlines ?? ''),
  })
  const [reviewComment, setReviewComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isAuthor = revision?.author_user_id !== null
  const editable = mode === 'create' || (revision?.status === 'draft' && isUploader)
  const adminCanReview = isAdmin && (revision?.status === 'pending_review' || revision?.status === 'changes_requested')

  // Какие поля изменены (для diff)
  const diff = useMemo(() => {
    const fields: Array<{ key: keyof typeof form; label: string; current: string; proposed: string }> = []
    const current = {
      seq:       String(topic.seq),
      title:     topic.title,
      category:  topic.category,
      synopsis:  topic.synopsis,
      threats:   topic.threats,
      solutions: topic.solutions ?? '',
      deadlines: topic.deadlines ?? '',
    }
    for (const k of ['seq','title','category','synopsis','threats','solutions','deadlines'] as const) {
      const proposed = String(form[k])
      const curr = current[k]
      if (proposed !== curr) {
        fields.push({ key: k, label: FIELD_LABEL[k], current: curr, proposed })
      }
    }
    return fields
  }, [form, topic])

  async function submitOrSave(targetStatus: 'draft' | 'pending_review') {
    setBusy(true); setError('')
    try {
      const token = await getToken()
      const proposedDiff: Record<string, unknown> = {}
      for (const f of diff) {
        proposedDiff[`proposed_${f.key}`] = f.key === 'seq' ? Number(form[f.key]) : (form[f.key] || null)
      }
      if (mode === 'create') {
        if (Object.keys(proposedDiff).length === 0) {
          throw new Error('Ничего не изменено — нечего предлагать')
        }
        const r = await fetch(`/api/strategic-topics/${topic.id}/revisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
          body: JSON.stringify({ status: targetStatus, ...proposedDiff }),
        })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      } else if (revision) {
        const r = await fetch(`/api/strategic-topics/${topic.id}/revisions/${revision.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
          body: JSON.stringify({ status: targetStatus, ...proposedDiff }),
        })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      }
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function review(newStatus: 'approved' | 'rejected' | 'changes_requested') {
    if (!revision) return
    if ((newStatus === 'rejected' || newStatus === 'changes_requested') && !reviewComment.trim()) {
      setError('Укажите комментарий — почему отклонено или что нужно доработать')
      return
    }
    setBusy(true); setError('')
    try {
      const token = await getToken()
      const r = await fetch(`/api/strategic-topics/${topic.id}/revisions/${revision.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ status: newStatus, review_comment: reviewComment.trim() || null }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!revision) return
    if (!confirm('Удалить эту ревизию?')) return
    setBusy(true); setError('')
    try {
      const token = await getToken()
      const r = await fetch(`/api/strategic-topics/${topic.id}/revisions/${revision.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      await onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 border-b flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold">
            {mode === 'create' ? 'Предложить правку' : 'Правка'}
            {revision && (
              <span className={`ml-3 inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOR[revision.status]}`}>
                {STATUS_LABEL[revision.status]}
              </span>
            )}
          </h2>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-700 disabled:opacity-50 text-2xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Поля формы */}
          {editable ? (
            <FormFields form={form} setForm={setForm} />
          ) : (
            <DiffView diff={diff} topic={topic} revision={revision!} />
          )}

          {/* Review comment (от админа) */}
          {revision?.review_comment && !editable && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded">
              <p className="text-xs text-amber-700 mb-1">Комментарий рецензента:</p>
              <p className="text-sm text-gray-800">{revision.review_comment}</p>
            </div>
          )}

          {/* Admin review controls */}
          {adminCanReview && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded space-y-2">
              <label className="block text-sm font-medium text-blue-900">Решение рецензента</label>
              <textarea
                value={reviewComment}
                onChange={e => setReviewComment(e.target.value)}
                rows={2}
                placeholder="Комментарий (обязателен при отклонении и changes_requested)"
                className="w-full px-3 py-2 border border-blue-300 rounded text-sm"
              />
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">{error}</div>
          )}
        </div>

        <div className="p-6 border-t bg-gray-50 flex gap-2 flex-wrap justify-end">
          {editable && (
            <>
              <button
                onClick={() => submitOrSave('draft')}
                disabled={busy}
                className="px-4 py-2 bg-white border rounded hover:bg-gray-100 text-sm disabled:opacity-50"
              >
                {mode === 'create' ? 'Сохранить как черновик' : 'Сохранить черновик'}
              </button>
              <button
                onClick={() => submitOrSave('pending_review')}
                disabled={busy || diff.length === 0}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50"
              >
                {busy ? 'Сохранение…' : 'Отправить на согласование'}
              </button>
            </>
          )}
          {adminCanReview && (
            <>
              <button
                onClick={() => review('rejected')}
                disabled={busy}
                className="px-4 py-2 bg-white border border-red-300 text-red-700 rounded hover:bg-red-50 text-sm disabled:opacity-50"
              >
                Отклонить
              </button>
              <button
                onClick={() => review('changes_requested')}
                disabled={busy}
                className="px-4 py-2 bg-white border border-orange-300 text-orange-700 rounded hover:bg-orange-50 text-sm disabled:opacity-50"
              >
                Запросить изменения
              </button>
              <button
                onClick={() => review('approved')}
                disabled={busy}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm disabled:opacity-50"
              >
                ✓ Принять
              </button>
            </>
          )}
          {revision && (isAdmin || (revision.status === 'draft' && isAuthor)) && (
            <button
              onClick={remove}
              disabled={busy}
              className="px-3 py-2 text-red-600 hover:text-red-800 text-sm disabled:opacity-50"
            >
              Удалить
            </button>
          )}
          <button onClick={onClose} disabled={busy} className="px-4 py-2 bg-white border rounded hover:bg-gray-100 text-sm disabled:opacity-50">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}

type RevForm = { seq: number; title: string; category: string; synopsis: string; threats: string; solutions: string; deadlines: string }

function FormFields({ form, setForm }: { form: RevForm; setForm: React.Dispatch<React.SetStateAction<RevForm>> }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="w-20">
          <label className="block text-xs text-gray-500 mb-1">№</label>
          <input
            type="number"
            min={1} max={999}
            value={form.seq}
            onChange={e => setForm(prev => ({ ...prev, seq: parseInt(e.target.value, 10) || 1 }))}
            className="w-full px-2 py-1 border border-gray-300 rounded font-mono text-lg text-center"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-gray-500 mb-1">Название</label>
          <input
            type="text"
            value={form.title}
            onChange={e => setForm(prev => ({ ...prev, title: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded text-lg font-semibold"
          />
        </div>
      </div>
      <FieldTextarea label="Синопсис" value={form.synopsis} onChange={v => setForm(prev => ({ ...prev, synopsis: v }))} rows={4} />
      <FieldTextarea label="Угрозы"   value={form.threats}   onChange={v => setForm(prev => ({ ...prev, threats: v }))}   rows={3} />
      <FieldTextarea label="Решения"  value={form.solutions} onChange={v => setForm(prev => ({ ...prev, solutions: v }))} rows={3} />
      <FieldTextarea label="Сроки"    value={form.deadlines} onChange={v => setForm(prev => ({ ...prev, deadlines: v }))} rows={2} />
    </div>
  )
}

function FieldTextarea({ label, value, onChange, rows }: { label: string; value: string; onChange: (v: string) => void; rows: number }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}

function DiffView({ diff, topic, revision }: { diff: Array<{ key: string; label: string; current: string; proposed: string }>; topic: Topic; revision: Revision }) {
  if (diff.length === 0) {
    return <p className="text-sm text-gray-400">Изменений нет</p>
  }
  // Подсказка: если тема была изменена с момента ревизии — предупреждение
  const baseUpdated = revision.base_snapshot
    ? Object.entries(revision.base_snapshot).some(([k, v]) => {
        if (!(k in topic)) return false
        const tv = (topic as unknown as Record<string, unknown>)[k]
        return v !== null && tv !== null && v !== tv
      })
    : false
  return (
    <div className="space-y-3">
      {baseUpdated && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
          ⚠️ Тема была изменена с момента создания этой ревизии. Сравнение ниже — против ТЕКУЩЕГО состояния темы, не против базового состояния на момент создания правки.
        </div>
      )}
      {diff.map(f => (
        <div key={f.key} className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-gray-500 mb-1">{f.label} — было</div>
            <div className="p-2 bg-red-50 border border-red-200 rounded text-sm whitespace-pre-wrap">{f.current || <span className="text-gray-400 italic">(пусто)</span>}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-1">{f.label} — стало</div>
            <div className="p-2 bg-green-50 border border-green-200 rounded text-sm whitespace-pre-wrap">{f.proposed || <span className="text-gray-400 italic">(пусто)</span>}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function countChangedFields(r: Revision, topic: Topic): number {
  let n = 0
  if (r.proposed_seq        !== null && r.proposed_seq        !== topic.seq)        n++
  if (r.proposed_title      !== null && r.proposed_title      !== topic.title)      n++
  if (r.proposed_category   !== null && r.proposed_category   !== topic.category)   n++
  if (r.proposed_synopsis   !== null && r.proposed_synopsis   !== topic.synopsis)   n++
  if (r.proposed_threats    !== null && r.proposed_threats    !== topic.threats)    n++
  if (r.proposed_solutions  !== null && r.proposed_solutions  !== topic.solutions)  n++
  if (r.proposed_deadlines  !== null && r.proposed_deadlines  !== topic.deadlines)  n++
  return n
}
