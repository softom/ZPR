'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Types ──────────────────────────────────────────────────────────────────

type Task = {
  id: string
  code: string
  title: string
  status: 'preliminary' | 'open' | 'in_progress' | 'done' | 'closed' | 'cancelled'
  priority: 'high' | 'medium' | 'low' | null
  assignee_org: string | null
  assignee_entity_id: string | null
  object_codes: string[]
  due_date: string | null
  done_date: string | null
  created_at: string
  source_meeting_date: string | null
}

type ObjectRef = { code: string; current_name: string }
type LegalEntity = { id: string; name: string; signatory_name: string | null; signatory_position: string | null }

type DocumentRow = {
  id: string
  title: string
  doc_number: string | null
  signed_date: string | null
  customer_entity_id: string | null
  contractor_entity_id: string | null
  parties_snapshot: { customer?: PartyInfo; contractor?: PartyInfo } | null
  deleted_at: string | null
}

type PartyInfo = {
  name?: string
  signatory_name?: string
  signatory_position?: string
  signatory?: string  // legacy: combined "ФИО, Должность"
}

type Clause = {
  id: string
  document_id: string
  order_index: number
  clause_date: string | null
  description: string
  source_page: number | null
}

type ObjectReport = {
  id: string
  object_code: string
  period_start: string
  period_end: string
  achievements: string | null
  weekly_work: string | null
  problems: string | null
  generated_at: string
  model_used: string | null
}

// ─── Constants ──────────────────────────────────────────────────────────────

const COLOR_DONE = '#16a34a'
const COLOR_OPEN = '#2563eb'
const COLOR_PREL = '#9ca3af'
const COLOR_CANCEL = '#dc2626'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('ru-RU')
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24))
}

function isOverdue(t: Task): boolean {
  if (!t.due_date) return false
  if (['done', 'closed', 'cancelled'].includes(t.status)) return false
  return new Date(t.due_date) < new Date(new Date().toDateString())
}

function weekRange(today: Date = new Date()): { start: string; end: string } {
  const d = new Date(today); d.setHours(0,0,0,0)
  const day = d.getDay() || 7
  const monday = new Date(d); monday.setDate(d.getDate() - (day - 1))
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
  return { start: monday.toISOString().slice(0,10), end: sunday.toISOString().slice(0,10) }
}

function partySignatory(p: PartyInfo | undefined, fallback: LegalEntity | null): string {
  if (p?.signatory_name) {
    const pos = p.signatory_position ? `, ${p.signatory_position}` : ''
    return `${p.signatory_name}${pos}`
  }
  if (p?.signatory) return p.signatory
  if (fallback?.signatory_name) {
    const pos = fallback.signatory_position ? `, ${fallback.signatory_position}` : ''
    return `${fallback.signatory_name}${pos}`
  }
  return '—'
}

// ─── Pie SVG ────────────────────────────────────────────────────────────────

function Pie({ values, size = 110 }: { values: { value: number; color: string }[]; size?: number }) {
  const total = values.reduce((s, v) => s + v.value, 0)
  if (total === 0) return <svg width={size} height={size} viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#f3f4f6" /></svg>
  let offset = 0
  const segs = values.filter((v) => v.value > 0)
  if (segs.length === 1) return <svg width={size} height={size} viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill={segs[0].color} /></svg>
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {segs.map((s, i) => {
        const f = s.value / total
        const a1 = offset * 2 * Math.PI - Math.PI / 2
        offset += f
        const a2 = offset * 2 * Math.PI - Math.PI / 2
        const x1 = 50 + 45 * Math.cos(a1), y1 = 50 + 45 * Math.sin(a1)
        const x2 = 50 + 45 * Math.cos(a2), y2 = 50 + 45 * Math.sin(a2)
        return <path key={i} d={`M 50 50 L ${x1} ${y1} A 45 45 0 ${f > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`} fill={s.color} />
      })}
    </svg>
  )
}

// ─── Main ───────────────────────────────────────────────────────────────────

export default function TasksStatsPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [objects, setObjects] = useState<ObjectRef[]>([])
  const [entities, setEntities] = useState<Record<string, LegalEntity>>({})
  const [docsByObject, setDocsByObject] = useState<Record<string, DocumentRow[]>>({})
  const [clausesByDoc, setClausesByDoc] = useState<Record<string, Clause[]>>({})
  const [reports, setReports] = useState<Record<string, ObjectReport | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [generating, setGenerating] = useState<Record<string, boolean>>({})
  const [genAllRunning, setGenAllRunning] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')

    const [tasksRes, objsRes, ents, docs, lastReports] = await Promise.all([
      supabase.from('tasks').select('id, code, title, status, priority, assignee_org, assignee_entity_id, object_codes, due_date, done_date, created_at, source_meeting_date'),
      supabase.from('objects').select('code, current_name').order('code'),
      supabase.from('legal_entities').select('id, name, signatory_name, signatory_position'),
      supabase.from('documents').select('id, title, doc_number, signed_date, customer_entity_id, contractor_entity_id, parties_snapshot, deleted_at').is('deleted_at', null),
      supabase.from('object_reports_latest').select('*'),
    ])

    if (tasksRes.error) { setError(tasksRes.error.message); setLoading(false); return }

    setTasks((tasksRes.data as Task[]) || [])
    setObjects((objsRes.data as ObjectRef[]) || [])
    const eMap: Record<string, LegalEntity> = {}
    for (const e of (ents.data as LegalEntity[]) || []) eMap[e.id] = e
    setEntities(eMap)

    // documents → docsByObject
    const docList = (docs.data as DocumentRow[]) || []
    const docIds = docList.map((d) => d.id)
    let docObjLinks: { document_id: string; object_code: string }[] = []
    if (docIds.length) {
      const link = await supabase.from('document_objects').select('document_id, object_code').in('document_id', docIds)
      docObjLinks = (link.data as { document_id: string; object_code: string }[]) || []
    }
    const dByO: Record<string, DocumentRow[]> = {}
    for (const lk of docObjLinks) {
      const doc = docList.find((d) => d.id === lk.document_id)
      if (!doc) continue
      if (!dByO[lk.object_code]) dByO[lk.object_code] = []
      dByO[lk.object_code].push(doc)
    }
    setDocsByObject(dByO)

    // clauses for these documents
    if (docIds.length) {
      const clauses = await supabase.from('contract_clauses')
        .select('id, document_id, order_index, clause_date, description, source_page')
        .in('document_id', docIds)
        .order('clause_date', { ascending: true, nullsFirst: false })
      const cByD: Record<string, Clause[]> = {}
      for (const c of (clauses.data as Clause[]) || []) {
        if (!cByD[c.document_id]) cByD[c.document_id] = []
        cByD[c.document_id].push(c)
      }
      setClausesByDoc(cByD)
    }

    // reports
    const rMap: Record<string, ObjectReport | null> = {}
    for (const r of (lastReports.data as ObjectReport[]) || []) {
      rMap[r.object_code] = r
    }
    setReports(rMap)

    setLoading(false)
  }

  // Группы по объектам (только те, у кого есть задачи)
  const groups = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const t of tasks) {
      if (t.object_codes.length === 0) {
        if (!map.has('none')) map.set('none', [])
        map.get('none')!.push(t)
      } else {
        for (const oc of t.object_codes) {
          if (!map.has(oc)) map.set(oc, [])
          map.get(oc)!.push(t)
        }
      }
    }
    return [...map.entries()].map(([key, items]) => {
      const o = objects.find((x) => x.code === key)
      const label = o ? `${o.code} — ${o.current_name}` : (key === 'none' ? 'Без объекта' : key)
      const stats = {
        total: items.length,
        done: items.filter((t) => ['done','closed'].includes(t.status)).length,
        open: items.filter((t) => ['open','in_progress'].includes(t.status)).length,
        prel: items.filter((t) => t.status === 'preliminary').length,
        cancelled: items.filter((t) => t.status === 'cancelled').length,
        overdue: items.filter(isOverdue).length,
      }
      const oldOpen = items
        .filter((t) => ['open','in_progress','preliminary'].includes(t.status))
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .slice(0, 5)
      return { key, label, items, stats, oldOpen }
    }).sort((a, b) => a.key.localeCompare(b.key))
  }, [tasks, objects])

  // Регенерация резюме для конкретного объекта
  async function regenerateReport(code: string) {
    setGenerating((g) => ({ ...g, [code]: true }))
    try {
      const res = await fetch(`/api/objects/${encodeURIComponent(code)}/report`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setReports((r) => ({ ...r, [code]: data.report }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`Не удалось сгенерировать резюме для ${code}: ${msg}`)
    } finally {
      setGenerating((g) => ({ ...g, [code]: false }))
    }
  }

  // Массовая генерация — для всех объектов с задачами
  async function regenerateAll() {
    setGenAllRunning(true)
    const codes = groups.filter((g) => g.key !== 'none').map((g) => g.key)
    const queue = [...codes]
    const concurrency = 3
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const c = queue.shift()
        if (!c) break
        await regenerateReport(c)
      }
    })
    await Promise.all(workers)
    setGenAllRunning(false)
  }

  const today = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  const wr = weekRange()

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <Link href="/tasks" className="text-sm text-blue-600 hover:underline">← К списку задач</Link>
          <h1 className="text-2xl font-bold mt-1">
            Отчёт по объектам
            <span className="ml-3 text-base font-normal text-gray-500">
              на {today}
            </span>
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Резюме за неделю {formatDate(wr.start)} — {formatDate(wr.end)}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={regenerateAll}
            disabled={genAllRunning || loading}
            className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {genAllRunning ? '⏳ Формируется…' : '✨ Сформировать все резюме'}
          </button>
          <button
            onClick={() => window.print()}
            className="px-4 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800"
          >
            🖨️ Печать в PDF
          </button>
        </div>
      </div>

      {error && <div className="p-3 mb-4 bg-red-50 text-red-700 rounded">{error}</div>}

      {loading ? (
        <div>Загрузка…</div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <ObjectCard
              key={g.key}
              code={g.key}
              label={g.label}
              stats={g.stats}
              oldOpen={g.oldOpen}
              docs={docsByObject[g.key] || []}
              clausesByDoc={clausesByDoc}
              entities={entities}
              report={reports[g.key] || null}
              regenerating={generating[g.key] || false}
              onRegenerate={() => regenerateReport(g.key)}
              objects={objects}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Карточка объекта (одна страница A4) ──────────────────────────────────

function ObjectCard(props: {
  code: string
  label: string
  stats: { total: number; done: number; open: number; prel: number; cancelled: number; overdue: number }
  oldOpen: Task[]
  docs: DocumentRow[]
  clausesByDoc: Record<string, Clause[]>
  entities: Record<string, LegalEntity>
  report: ObjectReport | null
  regenerating: boolean
  onRegenerate: () => void
  objects: ObjectRef[]
}) {
  const { code, label, stats, oldOpen, docs, clausesByDoc, entities, report, regenerating, onRegenerate } = props
  const today = new Date(new Date().toDateString())

  return (
    <article className="object-report bg-white rounded shadow border border-gray-200 p-6">
      {/* Шапка */}
      <header className="border-b pb-3 mb-4">
        <h2 className="text-xl font-bold text-gray-900">{label}</h2>
      </header>

      {/* Верх: статистика + договоры */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-5">
        {/* Статистика */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2">Статистика задач</h3>
          <div className="flex items-center gap-4">
            <Pie
              values={[
                { value: stats.done, color: COLOR_DONE },
                { value: stats.open, color: COLOR_OPEN },
                { value: stats.prel, color: COLOR_PREL },
                { value: stats.cancelled, color: COLOR_CANCEL },
              ]}
              size={100}
            />
            <div className="text-sm space-y-0.5 flex-1">
              <Row label="Поставлено" value={stats.total} color="text-gray-800" />
              <Row label="Выполнено" value={stats.done} color="text-green-700" />
              <Row label="Открыто" value={stats.open} color="text-blue-700" />
              {stats.prel > 0 && <Row label="Черновики" value={stats.prel} color="text-gray-500" />}
              {stats.overdue > 0 && <Row label="Просрочено" value={stats.overdue} color="text-red-600" />}
            </div>
          </div>
        </section>

        {/* Договоры */}
        <section>
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2">Договоры объекта</h3>
          {docs.length === 0 ? (
            <p className="text-sm text-gray-400">Договоров нет</p>
          ) : (
            <div className="space-y-3 text-sm">
              {docs.map((d) => {
                const customer = entities[d.customer_entity_id || '']
                const contractor = entities[d.contractor_entity_id || '']
                const ps = d.parties_snapshot || {}
                const clauses = (clausesByDoc[d.id] || [])
                  .filter((c) => c.clause_date && new Date(c.clause_date) >= today)
                  .slice(0, 5)
                return (
                  <div key={d.id} className="border-l-2 border-gray-300 pl-3">
                    <div className="font-medium text-gray-800">
                      {d.doc_number ? `№ ${d.doc_number} · ` : ''}{d.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      Подписан: {formatDate(d.signed_date)}
                    </div>
                    <div className="text-xs text-gray-600 mt-1">
                      <span className="text-gray-400">Заказчик:</span> {ps.customer?.name || customer?.name || '—'}
                      {' · '}
                      <span className="text-gray-400">подписант:</span> {partySignatory(ps.customer, customer)}
                    </div>
                    <div className="text-xs text-gray-600">
                      <span className="text-gray-400">Подрядчик:</span> {ps.contractor?.name || contractor?.name || '—'}
                      {' · '}
                      <span className="text-gray-400">подписант:</span> {partySignatory(ps.contractor, contractor)}
                    </div>
                    {clauses.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="text-xs text-blue-600 cursor-pointer">
                          Ключевые пункты ({clauses.length})
                        </summary>
                        <ul className="text-xs text-gray-700 mt-1 space-y-1">
                          {clauses.map((c) => (
                            <li key={c.id} className="flex gap-2">
                              <span className="text-gray-400 font-mono whitespace-nowrap">{formatDate(c.clause_date)}</span>
                              <span className="line-clamp-2">{c.description}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      {/* Резюме недели */}
      <section className="mb-5 bg-emerald-50/40 rounded p-4 border border-emerald-100">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <h3 className="text-sm font-bold text-emerald-800">Резюме недели</h3>
            {report ? (
              <p className="text-xs text-gray-500">
                Период: {formatDate(report.period_start)} — {formatDate(report.period_end)} · сгенерировано {new Date(report.generated_at).toLocaleString('ru-RU')}
              </p>
            ) : (
              <p className="text-xs text-gray-400">Резюме ещё не сформировано</p>
            )}
          </div>
          <button
            onClick={onRegenerate}
            disabled={regenerating}
            className="no-print px-3 py-1 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {regenerating ? '⏳ ' : '⟳ '}{report ? 'Переформировать' : 'Сформировать'}
          </button>
        </div>
        {report ? (
          <div className="space-y-3">
            <SummaryBlock title="Достижения" text={report.achievements} />
            <SummaryBlock title="Работы недели" text={report.weekly_work} />
            <SummaryBlock title="Проблемы" text={report.problems} />
          </div>
        ) : (
          <p className="text-sm text-gray-500 italic">Нажмите «Сформировать» — LLM подготовит абзацы по достижениям, работам недели и проблемам.</p>
        )}
      </section>

      {/* Старые невыполненные */}
      {oldOpen.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-2">
            Давно невыполненные (топ {oldOpen.length})
          </h3>
          <table className="w-full text-xs">
            <tbody>
              {oldOpen.map((t) => {
                const days = daysSince(t.created_at)
                return (
                  <tr key={t.id} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-2">
                      <span className="font-mono text-gray-400">{t.code}</span>
                    </td>
                    <td className="py-1.5 pr-2">{t.title}</td>
                    <td className="py-1.5 pr-2 text-gray-500">{formatDate(t.source_meeting_date || t.created_at)}</td>
                    <td className={`py-1.5 text-right font-mono ${
                      days > 30 ? 'text-red-600 font-semibold' : days > 14 ? 'text-amber-600' : 'text-gray-600'
                    }`}>
                      {days} дн.
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </article>
  )
}

function Row({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex justify-between"><span className="text-gray-600">{label}</span><b className={color}>{value}</b></div>
  )
}

function SummaryBlock({ title, text }: { title: string; text: string | null }) {
  return (
    <div>
      <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wider mb-1">{title}</div>
      <p className="text-sm text-gray-800 leading-relaxed">{text || <span className="text-gray-400 italic">—</span>}</p>
    </div>
  )
}
