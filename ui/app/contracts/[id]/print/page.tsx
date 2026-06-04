'use client'

/**
 * /contracts/[id]/print — печатная сводка по договору.
 *
 * Содержит: метаданные, стороны, объекты, диапазоны дат по этапам и
 * списки событий внутри каждого этапа. Открывается из карточки договора
 * (кнопка «🖨 Печать»). Подходит для Ctrl+P / сохранения PDF в браузере.
 *
 * @media print:
 *   - кнопки и контролы скрыты (.no-print)
 *   - каждый блок этапа не разрывается между страницами
 *   - убраны фоны/тени (для экономии тонера)
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { computeStageDateRanges, type ClauseForStageDates, type EventTypeForStageDates } from '@/lib/contracts/computeStageDates'
import { computeAllClauseDates } from '@/lib/contracts/computeClauseDates'

interface LegalEntityRow {
  id: string
  name: string
  inn: string
  kpp: string | null
  address_legal: string | null
  signatory_name: string | null
  signatory_position: string | null
}

interface ClauseRow extends ClauseForStageDates {
  description: string
  note: string | null
  source_quote: string | null
  source_page: number | null
  term_text: string | null
}

interface StageRow {
  id: string
  stage_number: number
  stage_name: string
  description: string | null
  sort_order: number
}

interface DocResp {
  id: string
  title: string
  doc_number: string | null
  version: string | null
  signed_date: string | null
  folder_path: string | null
  project_stage: string | null
  stage?: { code: string; label: string; sort_order: number } | null
  customer: LegalEntityRow | null
  contractor: LegalEntityRow | null
  objects: { object_code: string; objects?: { code: string; current_name: string } | null }[]
  clauses: ClauseRow[]
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.split('-')
  return `${d}.${m}.${y}`
}

export default function ContractPrintPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id

  const [doc, setDoc] = useState<DocResp | null>(null)
  const [stages, setStages] = useState<StageRow[]>([])
  const [eventTypes, setEventTypes] = useState<EventTypeForStageDates[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [docRes, stagesRes, etRes] = await Promise.all([
          fetch(`/api/contracts/v2/${id}`).then(r => r.json()),
          supabase.from('contract_stages').select('id,stage_number,stage_name,description,sort_order').eq('document_id', id).order('sort_order'),
          supabase.from('contract_event_types').select('id,code').eq('is_active', true),
        ])
        if (cancelled) return
        if (docRes.error) { setError(docRes.error); return }
        setDoc(docRes as DocResp)
        setStages((stagesRes.data as StageRow[]) ?? [])
        setEventTypes((etRes.data as EventTypeForStageDates[]) ?? [])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  if (loading) return <div className="p-6 text-sm text-gray-500">Загрузка…</div>
  if (error)   return <div className="p-6 text-sm text-red-600">{error}</div>
  if (!doc)    return <div className="p-6 text-sm text-gray-500">Не найдено</div>

  // Резолв дат (включая формульные) и диапазоны этапов
  const datesMap = computeAllClauseDates(doc.clauses, { signedDate: doc.signed_date })
  const ranges = computeStageDateRanges(doc.clauses, eventTypes, doc.signed_date)

  // Группируем clauses по этапам для секций
  const byStage = new Map<string | null, ClauseRow[]>()
  for (const c of doc.clauses) {
    const k = c.stage_id
    if (!byStage.has(k)) byStage.set(k, [])
    byStage.get(k)!.push(c)
  }
  // Сортировка clauses в группе — по computed date, потом order_index
  for (const arr of byStage.values()) {
    arr.sort((a, b) => {
      const da = datesMap.get(a.id)?.date ?? ''
      const db = datesMap.get(b.id)?.date ?? ''
      if (da !== db) return da.localeCompare(db)
      return a.order_index - b.order_index
    })
  }

  const objectsList = doc.objects
    .map(o => o.objects ? `${o.objects.code} — ${o.objects.current_name}` : o.object_code)
    .join(', ')

  return (
    <div className="bg-white text-gray-900 max-w-4xl mx-auto p-6 print:p-0 print:max-w-none">
      {/* Print rules + controls */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .stage-block { break-inside: avoid; page-break-inside: avoid; }
          body { color: #000; }
          table { border-collapse: collapse; }
        }
        @page { margin: 1.5cm 1.2cm; size: A4; }
      `}</style>

      <div className="no-print flex items-center gap-3 mb-4 sticky top-0 bg-white py-2 z-10 border-b">
        <button onClick={() => router.push(`/contracts/${id}`)} className="text-blue-600 text-sm">← К карточке</button>
        <div className="flex-1" />
        <a
          href={`/api/contracts/v2/${id}/file`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded hover:bg-gray-50"
          title="Открыть PDF договора в новом окне"
        >📄 Договор</a>
        <button
          onClick={() => window.print()}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >🖨 Печать</button>
      </div>

      {/* Title */}
      <header className="mb-6 pb-3 border-b-2 border-gray-800">
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Сводка по договору</div>
        <h1 className="text-2xl font-bold mb-1">{doc.title}</h1>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700">
          {doc.doc_number && <span><b>№:</b> {doc.doc_number}</span>}
          {doc.signed_date && <span><b>Подписан:</b> {fmtDate(doc.signed_date)}</span>}
          {doc.version && <span><b>Версия:</b> {doc.version}</span>}
          {doc.stage?.label && <span><b>Стадия:</b> {doc.stage.label}</span>}
        </div>
      </header>

      {/* Parties */}
      <section className="mb-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 border-b">Стороны</h2>
        <table className="w-full text-sm">
          <tbody>
            <tr className="border-b">
              <td className="py-1.5 w-32 text-gray-500 align-top">Заказчик</td>
              <td className="py-1.5">
                <div className="font-medium">{doc.customer?.name ?? '—'}</div>
                <div className="text-xs text-gray-600">
                  ИНН {doc.customer?.inn ?? '—'}
                  {doc.customer?.kpp && ` · КПП ${doc.customer.kpp}`}
                  {doc.customer?.signatory_name && ` · ${doc.customer.signatory_name}`}
                  {doc.customer?.signatory_position && `, ${doc.customer.signatory_position}`}
                </div>
              </td>
            </tr>
            <tr>
              <td className="py-1.5 w-32 text-gray-500 align-top">Подрядчик</td>
              <td className="py-1.5">
                <div className="font-medium">{doc.contractor?.name ?? '—'}</div>
                <div className="text-xs text-gray-600">
                  ИНН {doc.contractor?.inn ?? '—'}
                  {doc.contractor?.kpp && ` · КПП ${doc.contractor.kpp}`}
                  {doc.contractor?.signatory_name && ` · ${doc.contractor.signatory_name}`}
                  {doc.contractor?.signatory_position && `, ${doc.contractor.signatory_position}`}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Objects */}
      <section className="mb-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 border-b">Объекты</h2>
        <div className="text-sm">{objectsList || '—'}</div>
      </section>

      {/* General clauses (no stage, excluding anchor) */}
      {(() => {
        const general = (byStage.get(null) ?? []).filter(c => !c.is_anchor)
        if (general.length === 0) return null
        return (
          <section className="mb-5 stage-block">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 border-b">
              Общие условия и без привязки к этапу <span className="text-gray-400">({general.length})</span>
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="text-left py-1 pr-3 w-24">Дата</th>
                  <th className="text-left py-1">Событие</th>
                </tr>
              </thead>
              <tbody>
                {general.map(c => {
                  const d = datesMap.get(c.id)?.date
                  return (
                    <tr key={c.id} className="border-b border-gray-100 align-top">
                      <td className="py-1 pr-3 font-mono tabular-nums whitespace-nowrap">{fmtDate(d)}</td>
                      <td className="py-1">
                        <div>{c.description}</div>
                        {c.note && <div className="text-xs text-gray-500 italic">{c.note}</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )
      })()}

      {/* Stages — each as its own block */}
      <section className="mb-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2 border-b">
          Этапы договора <span className="text-gray-400">({stages.length})</span>
        </h2>
        {stages.length === 0 ? (
          <div className="text-sm text-gray-400 italic">Этапы не выделены.</div>
        ) : (
          stages.map(s => {
            const r = ranges.get(s.id)
            const clauses = (byStage.get(s.id) ?? [])
            return (
              <div key={s.id} className="stage-block mb-4 border border-gray-300 rounded">
                <div className="bg-gray-50 print:bg-transparent px-3 py-2 border-b border-gray-300 flex items-baseline gap-3 flex-wrap">
                  <span className="text-xs font-mono text-gray-500 shrink-0">Этап {s.stage_number}</span>
                  <span className="font-semibold flex-1">{s.stage_name}</span>
                  {r && r.start && r.end && (
                    <span className="text-xs font-mono tabular-nums whitespace-nowrap text-gray-700">
                      {r.startSource === 'explicit' ? '▶' : '↦'} {fmtDate(r.start)}
                      {' — '}
                      {r.endSource === 'explicit' ? '🏁' : '↤'} {fmtDate(r.end)}
                    </span>
                  )}
                  <span className="text-xs text-gray-400 shrink-0">{r?.clausesCount ?? clauses.length} событ.</span>
                </div>
                {s.description && (
                  <div className="px-3 py-1.5 text-xs text-gray-600 border-b border-gray-200">{s.description}</div>
                )}
                {clauses.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-400 italic">Нет событий, привязанных к этому этапу.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-[10px] uppercase tracking-wider text-gray-500">
                        <th className="text-left py-1 px-3 w-24">Дата</th>
                        <th className="text-left py-1 pr-3">Событие</th>
                        <th className="text-left py-1 pr-3 w-20">Стр.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clauses.map(c => {
                        const d = datesMap.get(c.id)?.date
                        return (
                          <tr key={c.id} className="border-b border-gray-100 last:border-b-0 align-top">
                            <td className="py-1 px-3 font-mono tabular-nums whitespace-nowrap">{fmtDate(d)}</td>
                            <td className="py-1 pr-3">
                              <div>{c.description}</div>
                              {c.term_text && <div className="text-xs text-gray-500 italic">⏱ {c.term_text}</div>}
                              {c.note && <div className="text-xs text-gray-500">{c.note}</div>}
                            </td>
                            <td className="py-1 pr-3 text-xs text-gray-500 font-mono tabular-nums">{c.source_page ?? ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })
        )}
      </section>

      {/* Footer */}
      <footer className="mt-8 pt-3 border-t text-xs text-gray-500 flex items-center justify-between">
        <span>Сводка сформирована {fmtDate(new Date().toISOString().slice(0, 10))}</span>
        <span className="font-mono">{doc.folder_path}</span>
      </footer>
    </div>
  )
}
