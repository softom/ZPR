'use client'

/**
 * /contracts/print — сводка по ВСЕМ активным договорам.
 *
 * Структура для каждого договора повторяет single-print:
 *   заголовок, стороны, объекты, этапы с диапазонами дат + событиями.
 *
 * Между договорами вставляется page-break, чтобы при печати каждый
 * договор начинался с новой страницы (для брошюровки портфеля).
 *
 * Дополнительно сверху — компактный «Перечень договоров»: единая таблица,
 * по строке на договор (номер, название, заказчик, подрядчик, объекты,
 * стадия, кол-во этапов, окончательная дата). Удобно как первая страница.
 */

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  computeStageDateRanges,
  type ClauseForStageDates,
  type EventTypeForStageDates,
} from '@/lib/contracts/computeStageDates'
import { computeAllClauseDates } from '@/lib/contracts/computeClauseDates'

// ─── DTO-типы (загружаем минимум полей, всё что нужно для печати) ───────

interface DocumentRow {
  id: string
  title: string
  doc_number: string | null
  version: string | null
  signed_date: string | null
  folder_path: string | null
  project_stage: string | null
  customer_entity_id: string | null
  contractor_entity_id: string | null
}

interface LegalEntityRow {
  id: string
  name: string
  inn: string
  kpp: string | null
  signatory_name: string | null
  signatory_position: string | null
}

interface ProjectStageRow {
  code: string
  label: string
  sort_order: number
}

interface ContractStageRow {
  id: string
  document_id: string
  stage_number: number
  stage_name: string
  description: string | null
  sort_order: number
}

interface ContractClauseRow extends ClauseForStageDates {
  document_id: string
  description: string
  note: string | null
  source_quote: string | null
  source_page: number | null
  term_text: string | null
}

interface ObjectRow {
  code: string
  current_name: string
}

interface DocObjectRow {
  document_id: string
  object_code: string
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.split('-')
  return `${d}.${m}.${y}`
}

export default function ContractsPrintPage() {
  const router = useRouter()
  const [docs, setDocs] = useState<DocumentRow[]>([])
  const [entities, setEntities] = useState<LegalEntityRow[]>([])
  const [projectStages, setProjectStages] = useState<ProjectStageRow[]>([])
  const [contractStages, setContractStages] = useState<ContractStageRow[]>([])
  const [clauses, setClauses] = useState<ContractClauseRow[]>([])
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [docObjects, setDocObjects] = useState<DocObjectRow[]>([])
  const [eventTypes, setEventTypes] = useState<EventTypeForStageDates[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [d, le, ps, cs, cc, o, doxo, et] = await Promise.all([
          supabase.from('documents')
            .select('id,title,doc_number,version,signed_date,folder_path,project_stage,customer_entity_id,contractor_entity_id')
            .eq('type', 'ДОГОВОРА').is('deleted_at', null)
            .order('signed_date', { ascending: true, nullsFirst: false }),
          supabase.from('legal_entities')
            .select('id,name,inn,kpp,signatory_name,signatory_position'),
          supabase.from('project_stages')
            .select('code,label,sort_order').order('sort_order'),
          supabase.from('contract_stages')
            .select('id,document_id,stage_number,stage_name,description,sort_order').order('sort_order'),
          supabase.from('contract_clauses')
            .select('id,document_id,order_index,clause_date,term_days,term_type,term_base,term_text,term_ref_clause_id,date_mode,stage_id,event_type_id,description,note,source_quote,source_page,is_anchor')
            .order('order_index'),
          supabase.from('objects').select('code,current_name').eq('active', true),
          supabase.from('document_objects').select('document_id,object_code'),
          supabase.from('contract_event_types').select('id,code').eq('is_active', true),
        ])
        if (cancelled) return
        if (d.error)  { setError(d.error.message); return }
        setDocs((d.data as DocumentRow[]) ?? [])
        setEntities((le.data as LegalEntityRow[]) ?? [])
        setProjectStages((ps.data as ProjectStageRow[]) ?? [])
        setContractStages((cs.data as ContractStageRow[]) ?? [])
        setClauses((cc.data as ContractClauseRow[]) ?? [])
        setObjects((o.data as ObjectRow[]) ?? [])
        setDocObjects((doxo.data as DocObjectRow[]) ?? [])
        setEventTypes((et.data as EventTypeForStageDates[]) ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // ─── Подсчёт диапазонов / маппинги ──────────────────────────────

  const entityById = useMemo(() => {
    const m = new Map<string, LegalEntityRow>()
    for (const e of entities) m.set(e.id, e)
    return m
  }, [entities])

  const projectStageByCode = useMemo(() => {
    const m = new Map<string, ProjectStageRow>()
    for (const s of projectStages) m.set(s.code, s)
    return m
  }, [projectStages])

  const objectByCode = useMemo(() => {
    const m = new Map<string, ObjectRow>()
    for (const o of objects) m.set(o.code, o)
    return m
  }, [objects])

  const stagesByDoc = useMemo(() => {
    const m = new Map<string, ContractStageRow[]>()
    for (const s of contractStages) {
      const arr = m.get(s.document_id) ?? []
      arr.push(s)
      m.set(s.document_id, arr)
    }
    return m
  }, [contractStages])

  const clausesByDoc = useMemo(() => {
    const m = new Map<string, ContractClauseRow[]>()
    for (const c of clauses) {
      const arr = m.get(c.document_id) ?? []
      arr.push(c)
      m.set(c.document_id, arr)
    }
    return m
  }, [clauses])

  const objectsByDoc = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const dox of docObjects) {
      const arr = m.get(dox.document_id) ?? []
      arr.push(dox.object_code)
      m.set(dox.document_id, arr)
    }
    return m
  }, [docObjects])

  // Резолв дат и диапазонов — по каждому договору
  const datesByDoc = useMemo(() => {
    const m = new Map<string, Map<string, { date: string | null }>>()
    for (const doc of docs) {
      const cs = clausesByDoc.get(doc.id) ?? []
      m.set(doc.id, computeAllClauseDates(cs, { signedDate: doc.signed_date }))
    }
    return m
  }, [docs, clausesByDoc])

  const stageRangesByDoc = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeStageDateRanges>>()
    for (const doc of docs) {
      const cs = clausesByDoc.get(doc.id) ?? []
      m.set(doc.id, computeStageDateRanges(cs, eventTypes, doc.signed_date))
    }
    return m
  }, [docs, clausesByDoc, eventTypes])

  // Финальная дата по договору — последний срок (max computed date)
  const finalDateByDoc = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const doc of docs) {
      const dates = datesByDoc.get(doc.id)
      let maxd: string | null = null
      for (const v of dates?.values() ?? []) {
        if (v.date && (!maxd || v.date > maxd)) maxd = v.date
      }
      m.set(doc.id, maxd)
    }
    return m
  }, [docs, datesByDoc])

  if (loading) return <div className="p-6 text-sm text-gray-500">Загрузка…</div>
  if (error)   return <div className="p-6 text-sm text-red-600">{error}</div>

  return (
    <div className="bg-white text-gray-900 max-w-5xl mx-auto p-6 print:p-0 print:max-w-none">
      {/* Print rules + sticky controls */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .stage-block, .doc-block { break-inside: avoid; page-break-inside: avoid; }
          .doc-block { page-break-before: always; }
          .doc-block:first-of-type { page-break-before: auto; }
          body { color: #000; }
          table { border-collapse: collapse; }
          a { color: inherit; text-decoration: none; }
        }
        @page { margin: 1.3cm 1.1cm; size: A4; }
      `}</style>

      <div className="no-print flex items-center gap-3 mb-4 sticky top-0 bg-white py-2 z-10 border-b">
        <button onClick={() => router.push('/contracts')} className="text-blue-600 text-sm">← К списку договоров</button>
        <div className="flex-1" />
        <button
          onClick={() => window.print()}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >🖨 Печать</button>
      </div>

      {/* Title */}
      <header className="mb-6 pb-3 border-b-2 border-gray-800">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Портфель договоров</div>
        <h1 className="text-2xl font-bold mb-1">Сводка по всем договорам</h1>
        <div className="text-sm text-gray-600">
          Договоров: <b>{docs.length}</b> · Этапов: <b>{contractStages.length}</b> · Событий: <b>{clauses.length}</b> ·
          Сформировано: {fmtDate(new Date().toISOString().slice(0, 10))}
        </div>
      </header>

      {/* ─── Часть 1: Перечень договоров ─── */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 border-b">
          Перечень договоров
        </h2>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b text-[10px] uppercase tracking-wider text-gray-500">
              <th className="text-left py-1 pr-2 w-8">#</th>
              <th className="text-left py-1 pr-2 w-24">Номер</th>
              <th className="text-left py-1 pr-2">Название</th>
              <th className="text-left py-1 pr-2 w-20">Подписан</th>
              <th className="text-left py-1 pr-2 w-20">Послед.</th>
              <th className="text-left py-1 pr-2 w-12 text-center">Этап.</th>
              <th className="text-left py-1 pr-2 w-12 text-center">Соб.</th>
              <th className="text-left py-1 pr-2">Подрядчик</th>
              <th className="text-left py-1 pr-2">Объекты</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc, idx) => {
              const contractor = doc.contractor_entity_id ? entityById.get(doc.contractor_entity_id) : null
              const objs = (objectsByDoc.get(doc.id) ?? []).map(c => c).join(', ')
              const stagesCount = (stagesByDoc.get(doc.id) ?? []).length
              const clausesCount = (clausesByDoc.get(doc.id) ?? []).length
              const finalDate = finalDateByDoc.get(doc.id) ?? null
              const docStages = stagesByDoc.get(doc.id) ?? []
              const ranges = stageRangesByDoc.get(doc.id) ?? new Map()
              const docClauses = clausesByDoc.get(doc.id) ?? []

              return (
                <Fragment key={doc.id}>
                  <tr className="border-b border-gray-200 align-top font-medium">
                    <td className="py-1 pr-2 font-mono tabular-nums text-gray-500">{idx + 1}</td>
                    <td className="py-1 pr-2 font-mono">{doc.doc_number ?? '—'}</td>
                    <td className="py-1 pr-2"><a href={`/contracts/${doc.id}/print`} className="hover:underline">{doc.title}</a></td>
                    <td className="py-1 pr-2 font-mono tabular-nums whitespace-nowrap">{fmtDate(doc.signed_date)}</td>
                    <td className="py-1 pr-2 font-mono tabular-nums whitespace-nowrap">{fmtDate(finalDate)}</td>
                    <td className="py-1 pr-2 text-center tabular-nums">{stagesCount || '—'}</td>
                    <td className="py-1 pr-2 text-center tabular-nums">{clausesCount || '—'}</td>
                    <td className="py-1 pr-2 truncate max-w-[180px]">{contractor?.name ?? '—'}</td>
                    <td className="py-1 pr-2 text-[11px] text-gray-700">{objs}</td>
                  </tr>
                  {/* Sub-rows: этапы договора с диапазонами дат и кол-вом событий */}
                  {docStages.map(s => {
                    const r = ranges.get(s.id)
                    const sClausesCount = docClauses.filter(c => c.stage_id === s.id).length
                    const startMark = r?.startSource === 'explicit' ? '▶' : '↦'
                    const endMark   = r?.endSource   === 'explicit' ? '🏁' : '↤'
                    return (
                      <tr key={`${doc.id}-${s.id}`} className="border-b border-gray-100 bg-gray-50/40 print:bg-transparent text-[11px]">
                        <td></td>
                        <td></td>
                        <td className="py-0.5 pr-2 pl-3 text-gray-700">
                          <span className="text-gray-400">└</span>{' '}
                          <span className="font-mono text-gray-500">Этап {s.stage_number}</span>
                          {' · '}
                          <span>{s.stage_name}</span>
                        </td>
                        <td className="py-0.5 pr-2 font-mono tabular-nums text-gray-600 whitespace-nowrap">
                          {r?.start ? `${startMark} ${fmtDate(r.start)}` : '—'}
                        </td>
                        <td className="py-0.5 pr-2 font-mono tabular-nums text-gray-600 whitespace-nowrap">
                          {r?.end ? `${endMark} ${fmtDate(r.end)}` : '—'}
                        </td>
                        <td></td>
                        <td className="py-0.5 pr-2 text-center tabular-nums text-gray-600">{sClausesCount || '—'}</td>
                        <td></td>
                        <td></td>
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        <div className="text-[10px] text-gray-400 mt-1">
          «Подписан» — дата подписания договора, «Послед.» — последняя дата срока среди всех событий договора (включая формульные).
          Строки этапов: <span className="font-mono">▶/🏁</span> — даты из явно размеченных событий (<code>work_start</code> / <code>work_result_delivery</code>),
          <span className="font-mono"> ↦/↤</span> — авто-расчёт по min/max клауз этапа.
        </div>
      </section>

      {/* ─── Часть 2: Детальный разворот по каждому договору ─── */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 border-b">
          Детальная сводка
        </h2>

        {docs.map((doc) => {
          const customer   = doc.customer_entity_id ? entityById.get(doc.customer_entity_id) : null
          const contractor = doc.contractor_entity_id ? entityById.get(doc.contractor_entity_id) : null
          const projStage  = doc.project_stage ? projectStageByCode.get(doc.project_stage) : null
          const docClauses = clausesByDoc.get(doc.id) ?? []
          const docStages  = stagesByDoc.get(doc.id) ?? []
          const datesMap   = datesByDoc.get(doc.id) ?? new Map()
          const ranges     = stageRangesByDoc.get(doc.id) ?? new Map()
          const objs = (objectsByDoc.get(doc.id) ?? [])
            .map(c => {
              const o = objectByCode.get(c)
              return o ? `${o.code} — ${o.current_name}` : c
            }).join(', ')

          // Группируем clauses по stage_id
          const byStage = new Map<string | null, ContractClauseRow[]>()
          for (const c of docClauses) {
            const k = c.stage_id
            if (!byStage.has(k)) byStage.set(k, [])
            byStage.get(k)!.push(c)
          }
          for (const arr of byStage.values()) {
            arr.sort((a, b) => {
              const da = datesMap.get(a.id)?.date ?? ''
              const db = datesMap.get(b.id)?.date ?? ''
              if (da !== db) return da.localeCompare(db)
              return a.order_index - b.order_index
            })
          }
          const generalClauses = (byStage.get(null) ?? []).filter(c => !c.is_anchor)

          return (
            <div key={doc.id} className="doc-block mb-8 pb-4 border-b-2 border-gray-300">
              {/* Doc header */}
              <div className="mb-3">
                <div className="flex items-baseline gap-3 flex-wrap mb-1">
                  <h3 className="text-lg font-bold flex-1 min-w-0">{doc.title}</h3>
                  {doc.doc_number && <span className="text-xs font-mono text-gray-500">№ {doc.doc_number}</span>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-700">
                  {doc.signed_date && <span><b>Подписан:</b> {fmtDate(doc.signed_date)}</span>}
                  {projStage?.label && <span><b>Стадия:</b> {projStage.label}</span>}
                  {doc.version && <span><b>Версия:</b> {doc.version}</span>}
                </div>
              </div>

              {/* Parties + Objects — компактно */}
              <div className="grid grid-cols-2 gap-3 text-xs mb-3">
                <div>
                  <div className="text-gray-500 text-[10px] uppercase tracking-wider">Заказчик</div>
                  <div className="font-medium">{customer?.name ?? '—'}</div>
                  <div className="text-gray-600">ИНН {customer?.inn ?? '—'}{customer?.kpp ? ` · КПП ${customer.kpp}` : ''}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-[10px] uppercase tracking-wider">Подрядчик</div>
                  <div className="font-medium">{contractor?.name ?? '—'}</div>
                  <div className="text-gray-600">ИНН {contractor?.inn ?? '—'}{contractor?.kpp ? ` · КПП ${contractor.kpp}` : ''}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-gray-500 text-[10px] uppercase tracking-wider">Объекты</div>
                  <div>{objs || '—'}</div>
                </div>
              </div>

              {/* Общие условия (если есть) */}
              {generalClauses.length > 0 && (
                <div className="stage-block mb-3">
                  <div className="text-xs font-semibold text-gray-600 mb-1">
                    Общие условия и без привязки к этапу ({generalClauses.length})
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {generalClauses.map(c => (
                        <tr key={c.id} className="border-b border-gray-100 align-top">
                          <td className="py-0.5 pr-2 w-20 font-mono tabular-nums whitespace-nowrap text-gray-700">{fmtDate(datesMap.get(c.id)?.date)}</td>
                          <td className="py-0.5">{c.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Этапы */}
              {docStages.length === 0 ? (
                <div className="text-xs text-gray-400 italic">Этапы не выделены.</div>
              ) : (
                docStages.map(s => {
                  const r = ranges.get(s.id)
                  const sClauses = (byStage.get(s.id) ?? [])
                  return (
                    <div key={s.id} className="stage-block mb-2 border border-gray-300 rounded">
                      <div className="bg-gray-50 print:bg-transparent px-2 py-1 border-b border-gray-300 flex items-baseline gap-2 flex-wrap text-xs">
                        <span className="font-mono text-gray-500 shrink-0">Этап {s.stage_number}</span>
                        <span className="font-semibold flex-1">{s.stage_name}</span>
                        {r && r.start && r.end && (
                          <span className="font-mono tabular-nums whitespace-nowrap text-gray-700">
                            {r.startSource === 'explicit' ? '▶' : '↦'} {fmtDate(r.start)}
                            {' — '}
                            {r.endSource === 'explicit' ? '🏁' : '↤'} {fmtDate(r.end)}
                          </span>
                        )}
                        <span className="text-gray-400 shrink-0">{r?.clausesCount ?? sClauses.length} событ.</span>
                      </div>
                      {sClauses.length > 0 && (
                        <table className="w-full text-xs">
                          <tbody>
                            {sClauses.map(c => (
                              <tr key={c.id} className="border-b border-gray-100 last:border-b-0 align-top">
                                <td className="py-0.5 px-2 w-20 font-mono tabular-nums whitespace-nowrap text-gray-700">{fmtDate(datesMap.get(c.id)?.date)}</td>
                                <td className="py-0.5 pr-2">
                                  <div>{c.description}</div>
                                  {c.term_text && <div className="text-[10px] text-gray-500 italic">⏱ {c.term_text}</div>}
                                </td>
                                <td className="py-0.5 pr-2 w-8 text-[10px] text-gray-500 font-mono tabular-nums text-right">{c.source_page ?? ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )
        })}
      </section>

      <footer className="mt-6 pt-3 border-t text-xs text-gray-500">
        Сводка сформирована {fmtDate(new Date().toISOString().slice(0, 10))} ·
        Источник: документная база ЗПР (`documents`, `contract_stages`, `contract_clauses`, `contract_event_types`).
      </footer>
    </div>
  )
}
