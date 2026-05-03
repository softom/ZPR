/**
 * dateFormula.ts — pure date arithmetic for the event chain.
 *
 * Rules:
 * - No text parsing here. Text → structured fields happens ONCE at ingestion
 *   (normalizeMilestones for LLM output, loadContract for DB load).
 * - All computation works on structured fields:
 *     _ref_days / _ref_type / _ref_event_id  (UI state, MilestoneEvent)
 *     date_ref_offset / date_ref_offset_type (DB, events table)
 * - Used by: ContractModal.tsx, page.tsx, future objects/page.tsx
 */

// ─── Base arithmetic ──────────────────────────────────────────────────────────

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

/** Convert working days to calendar-day equivalent (approx ×1.4). */
export function toCalendarDays(n: number, type: 'working' | 'calendar'): number {
  return type === 'working' ? Math.round(n * 1.4) : n
}

// ─── DB event resolution ──────────────────────────────────────────────────────

export type DBEventForResolution = {
  id: string
  date_mode: string | null
  date_end: string | null
  date_start: string | null
  date_ref_event_id: string | null
  date_ref_offset: number | null
  date_ref_offset_type: string | null
  exec_days: number | null
  exec_type: string | null
}

/**
 * Resolve absolute {start, end} dates for every event, including
 * relative ones that point to other events (multi-level chains supported).
 *
 * Input:  raw DB rows (date_end may be null for relative events).
 * Output: Map<eventId, { start, end }> — only events with a resolvable date.
 */
export function resolveEventDates(
  events: DBEventForResolution[],
): Map<string, { start: string; end: string }> {
  const resolved = new Map<string, { start: string; end: string }>()

  // Pass 1: absolute events that already have date_end
  for (const ev of events) {
    if (!ev.date_end) continue
    const execDays = ev.exec_days ?? 0
    const execEnd = execDays > 0
      ? addDays(ev.date_end, toCalendarDays(execDays, (ev.exec_type ?? 'calendar') as 'working' | 'calendar'))
      : null
    resolved.set(ev.id, { start: ev.date_start ?? ev.date_end, end: execEnd ?? ev.date_end })
  }

  // Iterative passes: resolve relative events whose reference is now resolved
  let changed = true
  while (changed) {
    changed = false
    for (const ev of events) {
      if (resolved.has(ev.id)) continue
      if (ev.date_mode !== 'relative' || !ev.date_ref_event_id) continue
      const ref = resolved.get(ev.date_ref_event_id)
      if (!ref) continue

      const offset = ev.date_ref_offset ?? 0
      const calOffset = toCalendarDays(offset, (ev.date_ref_offset_type ?? 'calendar') as 'working' | 'calendar')
      const computed = addDays(ref.end, calOffset)
      const execDays = ev.exec_days ?? 0
      const execEnd = execDays > 0
        ? addDays(computed, toCalendarDays(execDays, (ev.exec_type ?? 'calendar') as 'working' | 'calendar'))
        : null
      resolved.set(ev.id, { start: computed, end: execEnd ?? computed })
      changed = true
    }
  }

  // Fallback pass: old events that have date_start stored but couldn't be chain-resolved
  for (const ev of events) {
    if (resolved.has(ev.id)) continue
    if (!ev.date_start) continue
    const execDays = ev.exec_days ?? 0
    const execEnd = execDays > 0
      ? addDays(ev.date_start, toCalendarDays(execDays, (ev.exec_type ?? 'calendar') as 'working' | 'calendar'))
      : null
    resolved.set(ev.id, { start: ev.date_start, end: execEnd ?? ev.date_start })
  }

  return resolved
}
