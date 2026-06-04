'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import GanttChart, { type GanttLayer, type GanttStage } from '@/components/GanttChart'
import { resolveEventDates, type DBEventForResolution } from '@/lib/dateFormula'

const EVENT_TYPE_ICON: Record<string, string> = {
  fin_advance: '💰', fin_interim: '💸', fin_final: '✅',
  work_start: '▶', work_end: '⬛', work_stage: '◆', work_event: '◇',
  appr_submission: '📤', appr_review: '🔍', appr_sign: '📝',
  exec_work: '🔨', contract_signed: '📋',
}

type EventRow = DBEventForResolution & {
  event_type: string         // entry_type из calendar_entries (renamed для совместимости с dateFormula)
  title: string | null
  stage_name: string | null
  entity_id: string          // document_id, резолвится через entity_links
}

type Props = {
  /** Фильтр по конкретному договору. Если не задан — загружаем все договоры. */
  documentId?: string
  mode?: 'view' | 'edit'
  showTypeLabels?: boolean
  onBarChange?: (id: string, layer: GanttLayer, start: string, end: string) => void
  className?: string
}

export default function ProjectGanttView({
  documentId,
  mode = 'view',
  showTypeLabels = true,
  onBarChange,
  className = '',
}: Props) {
  const [stages, setStages] = useState<GanttStage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        // После сплита 20260508* плановые/договорные вехи живут в calendar_entries.
        // Связь с документом — через entity_links (from_type='calendar_entry' → to_type='document').
        const sel = 'id,entry_type,title,stage_name,date_end,date_start,date_mode,date_ref_entry_id,date_ref_offset,date_ref_offset_type,exec_days,exec_type'

        const calQ = supabase.from('calendar_entries').select(sel)

        let docQ = supabase
          .from('documents')
          .select('id,title,letters(from_to)')
          .eq('type', 'ДОГОВОРА')
          .is('deleted_at', null)
        if (documentId) docQ = docQ.eq('id', documentId)

        // Маппинг calendar_entry → document_id из entity_links
        const linksQ = supabase
          .from('entity_links')
          .select('from_id,to_id')
          .eq('from_type', 'calendar_entry')
          .eq('to_type', 'document')

        const [calRes, docRes, linksRes] = await Promise.all([calQ, docQ, linksQ])

        const cal2doc = new Map<string, string>()
        for (const l of (linksRes.data ?? []) as { from_id: string; to_id: string }[]) {
          cal2doc.set(l.from_id, l.to_id)
        }

        // Адаптируем calendar_entries к старому формату EventRow:
        // entry_type → event_type, date_ref_entry_id → date_ref_event_id, entity_id ← cal2doc.
        type CalRow = {
          id: string; entry_type: string; title: string | null; stage_name: string | null;
          date_end: string | null; date_start: string | null;
          date_mode: string; date_ref_entry_id: string | null;
          date_ref_offset: number; date_ref_offset_type: string;
          exec_days: number | null; exec_type: string | null;
        }
        const calRows = (calRes.data ?? []) as unknown as CalRow[]
        const events: EventRow[] = calRows
          .map((c) => ({
            id: c.id,
            event_type: c.entry_type,
            title: c.title,
            stage_name: c.stage_name,
            entity_id: cal2doc.get(c.id) ?? '',
            date_end: c.date_end,
            date_start: c.date_start,
            date_mode: c.date_mode as 'absolute' | 'relative',
            date_ref_event_id: c.date_ref_entry_id,
            date_ref_offset: c.date_ref_offset,
            date_ref_offset_type: c.date_ref_offset_type as 'calendar' | 'working',
            exec_days: c.exec_days,
            exec_type: c.exec_type as 'calendar' | 'working' | null,
          }))
          .filter((e) => documentId ? e.entity_id === documentId : e.entity_id !== '')
        const docs = (docRes.data ?? []) as (Record<string, unknown> & { id: string; title: string })[]

        const docShort = new Map<string, string>()
        for (const d of docs) {
          const letters = d.letters as { from_to: string }[] | { from_to: string } | null
          const fromTo = Array.isArray(letters) ? (letters[0]?.from_to ?? '') : (letters?.from_to ?? '')
          docShort.set(d.id, fromTo?.slice(0, 8) || d.title.slice(0, 8))
        }

        const dates = resolveEventDates(events)

        // Filter for display only — contract_loaded is an anchor but not shown
        const displayEvents = events.filter(ev => ev.event_type !== 'contract_loaded')

        // Earliest resolved date per document — for sorting documents chronologically
        const docEarliest = new Map<string, string>()
        for (const ev of displayEvents) {
          const d = dates.get(ev.id)
          if (!d || !docShort.has(ev.entity_id)) continue
          const cur = docEarliest.get(ev.entity_id)
          if (!cur || d.start < cur) docEarliest.set(ev.entity_id, d.start)
        }

        const result: GanttStage[] = displayEvents
          .filter(ev => docShort.has(ev.entity_id) && dates.has(ev.id))
          .sort((a, b) => {
            const da = docEarliest.get(a.entity_id) ?? ''
            const db = docEarliest.get(b.entity_id) ?? ''
            if (da !== db) return da.localeCompare(db)
            return dates.get(a.id)!.start.localeCompare(dates.get(b.id)!.start)
          })
          .map(ev => {
            const d = dates.get(ev.id)!
            const icon = EVENT_TYPE_ICON[ev.event_type] ?? '◆'
            const name = ev.title?.replace(/^[^:]*:\s*/, '') ?? ev.stage_name ?? ev.event_type
            return {
              id:           ev.id,
              number:       docShort.get(ev.entity_id) ?? '',
              name,
              bars:         [{ layer: 'contract' as GanttLayer, start: d.start, end: d.end }],
              typeLabel:    icon,
              dependencies: ev.date_ref_event_id ? [ev.date_ref_event_id] : undefined,
            }
          })

        setStages(result)
      } catch (e) {
        console.error('[ProjectGanttView]', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [documentId])

  if (loading) return <p className="text-sm text-gray-400">Загрузка…</p>

  return (
    <GanttChart
      stages={stages}
      mode={mode}
      layers={['contract']}
      today={new Date().toISOString().split('T')[0]}
      showTypeLabels={showTypeLabels}
      onBarChange={onBarChange}
      className={className}
    />
  )
}
