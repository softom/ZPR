'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type GanttLayer = 'plan' | 'contract' | 'actual'

export type GanttBar = {
  layer: GanttLayer
  start: string  // YYYY-MM-DD
  end: string    // YYYY-MM-DD
}

export type GanttStage = {
  id: string
  number: string
  name: string
  bars: GanttBar[]
  issues?: number
  dependencies?: string[]  // ids of predecessor stages
  typeLabel?: string        // e.g. "💰 Аванс" — shown at bar end when showTypeLabels=true
  note?: string             // free-text remark shown in popup
  predecessorNames?: string[] // human-readable names of predecessor stages for popup
}

type Props = {
  stages: GanttStage[]
  mode?: 'view' | 'edit'
  today?: string
  layers?: GanttLayer[]
  onBarChange?: (id: string, layer: GanttLayer, start: string, end: string) => void
  showTypeLabels?: boolean  // show type label at end of each bar (default false)
  className?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = ['ЯНВ','ФЕВ','МАР','АПР','МАЙ','ИЮН','ИЮЛ','АВГ','СЕН','ОКТ','НОЯ','ДЕК']
const ROW_H  = 56
const BAR_H  = 11
const BAR_GAP = 3
const LEFT_W = 200

const LAYER_COLOR: Record<GanttLayer, string> = {
  plan:     '#d1d5db',
  contract: '#60a5fa',
  actual:   '#4ade80',
}

const LAYER_LABEL: Record<GanttLayer, string> = {
  plan:     'План',
  contract: 'Договорные даты',
  actual:   'Фактические',
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toDate(s: string): Date { return new Date(s + 'T12:00:00') }
function fromDate(d: Date): string { return d.toISOString().split('T')[0] }
function shiftDate(s: string, days: number): string {
  const d = toDate(s)
  d.setDate(d.getDate() + days)
  return fromDate(d)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GanttChart({
  stages,
  mode = 'view',
  today,
  layers = ['plan', 'contract', 'actual'],
  onBarChange,
  showTypeLabels = false,
  className = '',
}: Props) {
  const tlRef = useRef<HTMLDivElement>(null)

  const [drag, setDrag] = useState<{
    stageId: string
    layer: GanttLayer
    startX: number
    origStart: string
    origEnd: string
    delta: number
  } | null>(null)

  const [tooltip, setTooltip] = useState<{
    stage: GanttStage
    bar: GanttBar
    x: number
    y: number
  } | null>(null)

  const todayStr = today ?? new Date().toISOString().split('T')[0]

  function fmtD(s: string): string {
    if (!s) return ''
    const [y, m, d] = s.split('-')
    return `${d}.${m}.${y}`
  }

  // ─── Timeline bounds ──────────────────────────────────────────────────────

  const allDates: Date[] = [toDate(todayStr)]
  for (const s of stages) {
    for (const b of s.bars) {
      if (!layers.includes(b.layer)) continue
      if (b.start) allDates.push(toDate(b.start))
      if (b.end)   allDates.push(toDate(b.end))
    }
  }

  const minMs = Math.min(...allDates.map(d => d.getTime()))
  const maxMs = Math.max(...allDates.map(d => d.getTime()))
  const minDate = new Date(minMs)
  const maxDate = new Date(maxMs)

  // Snap to full months + 1-month buffer at end
  const tlStart = new Date(minDate.getFullYear(), minDate.getMonth(), 1)
  const tlEnd   = new Date(maxDate.getFullYear(), maxDate.getMonth() + 2, 0)
  const totalDays = Math.max(1, Math.round((tlEnd.getTime() - tlStart.getTime()) / 86400000))

  // ─── Month headers ────────────────────────────────────────────────────────

  type MonthCol = { label: string; year: number; l: number; w: number }
  const months: MonthCol[] = []
  let cur = new Date(tlStart)
  while (cur.getTime() <= tlEnd.getTime()) {
    const mStart = new Date(cur.getFullYear(), cur.getMonth(), 1)
    const mEnd   = new Date(cur.getFullYear(), cur.getMonth() + 1, 0)
    const c0 = mStart < tlStart ? tlStart : mStart
    const c1 = mEnd   > tlEnd   ? tlEnd   : mEnd
    const l = (c0.getTime() - tlStart.getTime()) / 86400000 / totalDays * 100
    const w = Math.max(0.1, (c1.getTime() - c0.getTime()) / 86400000 / totalDays * 100)
    months.push({ label: MONTH_NAMES[cur.getMonth()], year: cur.getFullYear(), l, w })
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
  }

  const todayPct = (toDate(todayStr).getTime() - tlStart.getTime()) / 86400000 / totalDays * 100

  // ─── Bar position with drag preview ──────────────────────────────────────

  function barPos(stage: GanttStage, bar: GanttBar): { l: number; w: number } {
    let s = bar.start, e = bar.end
    if (drag && drag.stageId === stage.id && drag.layer === bar.layer) {
      s = shiftDate(drag.origStart, drag.delta)
      e = shiftDate(drag.origEnd,   drag.delta)
    }
    const sPct = (toDate(s).getTime() - tlStart.getTime()) / 86400000 / totalDays * 100
    const ePct = (toDate(e).getTime() - tlStart.getTime()) / 86400000 / totalDays * 100
    return { l: Math.max(0, sPct), w: Math.max(0.3, ePct - sPct) }
  }

  // ─── Drag handlers ────────────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent, stageId: string, layer: GanttLayer, bar: GanttBar) {
    if (mode !== 'edit' || layer !== 'contract') return
    e.preventDefault()
    setTooltip(null)
    setDrag({ stageId, layer, startX: e.clientX, origStart: bar.start, origEnd: bar.end, delta: 0 })
  }

  function showTooltip(e: React.MouseEvent, stage: GanttStage, bar: GanttBar) {
    if (drag) return
    setTooltip({ stage, bar, x: e.clientX, y: e.clientY })
  }
  function moveTooltip(e: React.MouseEvent) {
    if (drag) return
    setTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null)
  }
  function hideTooltip() { setTooltip(null) }

  const onMove = useCallback((e: MouseEvent) => {
    if (!drag || !tlRef.current) return
    const pxPerDay = tlRef.current.offsetWidth / totalDays
    const delta = Math.round((e.clientX - drag.startX) / pxPerDay)
    setDrag(d => d ? { ...d, delta } : null)
  }, [drag, totalDays])

  const onUp = useCallback(() => {
    if (drag) {
      onBarChange?.(drag.stageId, drag.layer,
        shiftDate(drag.origStart, drag.delta),
        shiftDate(drag.origEnd,   drag.delta))
    }
    setDrag(null)
  }, [drag, onBarChange])

  useEffect(() => {
    if (!drag) return
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [drag, onMove, onUp])

  // ─── Derived ─────────────────────────────────────────────────────────────

  const visibleLayers = (['plan', 'contract', 'actual'] as GanttLayer[]).filter(l => layers.includes(l))
  const barsH = visibleLayers.length * BAR_H + Math.max(0, visibleLayers.length - 1) * BAR_GAP
  const barTop0 = (ROW_H - barsH) / 2

  // ─── Dependency arrows ───────────────────────────────────────────────────

  type ArrowLine = {
    srcPct:  number  // % position of source event date (bar start)
    srcRowY: number  // px: center Y of source row
    tgtPct:  number  // % position of target event date (bar start)
    tgtRowY: number  // px: center Y of target row
  }

  const stageRowMap = new Map(stages.map((s, i) => [s.id, i]))
  const arrowLines: ArrowLine[] = []

  for (let ti = 0; ti < stages.length; ti++) {
    const tgt = stages[ti]
    if (!tgt.dependencies?.length) continue
    const tgtBar = tgt.bars.find(b => layers.includes(b.layer))
    if (!tgtBar) continue
    for (const depId of tgt.dependencies) {
      const si = stageRowMap.get(depId)
      if (si === undefined) continue
      const src = stages[si]
      const srcBar = src.bars.find(b => layers.includes(b.layer))
      if (!srcBar) continue
      const { l: sl } = barPos(src, srcBar)
      const { l: tl } = barPos(tgt, tgtBar)
      arrowLines.push({
        srcPct:  sl,
        srcRowY: si * ROW_H + ROW_H / 2,
        tgtPct:  tl,
        tgtRowY: ti * ROW_H + ROW_H / 2,
      })
    }
  }

  if (stages.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-10 text-center">
        Нет этапов с датами для отображения на графике.
      </p>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`gantt-root text-xs select-none ${drag ? 'cursor-ew-resize' : ''} ${className}`}>

      {/* Legend */}
      <div className="gantt-controls flex items-center gap-5 mb-3 print:hidden">
        {visibleLayers.map(l => (
          <div key={l} className="flex items-center gap-1.5">
            <div className="w-7 h-2.5 rounded-sm" style={{ background: LAYER_COLOR[l] }} />
            <span className="text-[11px] text-gray-600">{LAYER_LABEL[l]}</span>
          </div>
        ))}
        {mode === 'edit' && (
          <span className="text-[10px] text-gray-400 ml-auto print:hidden">
            Тяните синий бар для изменения даты
          </span>
        )}
      </div>

      {/* Scrollable chart */}
      <div className="gantt-scroll overflow-x-auto border border-gray-200 rounded-lg print:overflow-visible">
        <div style={{ minWidth: '520px' }}>

          {/* Header row */}
          <div className="flex border-b border-gray-200 bg-gray-50">
            <div
              className="shrink-0 border-r border-gray-200 px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center"
              style={{ width: LEFT_W }}>
              Этап / Задача
            </div>
            <div ref={tlRef} className="flex-1 relative" style={{ height: 36 }}>
              {months.map((m, i) => (
                <div key={i}
                  className="absolute inset-y-0 flex flex-col items-center justify-center border-r border-gray-200 last:border-r-0 overflow-hidden"
                  style={{ left: `${m.l}%`, width: `${m.w}%` }}>
                  <span className="text-[11px] font-semibold text-gray-600 leading-tight">{m.label}</span>
                  <span className="text-[9px] text-gray-400 leading-none">{m.year}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Stage rows + arrow overlay */}
          <div className="relative">
          {stages.map((stage, si) => {
            const visibleBars = stage.bars.filter(b => layers.includes(b.layer))
            return (
              <div key={stage.id}
                className={`flex border-b border-gray-100 last:border-b-0 ${si % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}
                style={{ height: ROW_H }}>

                {/* Name column */}
                <div
                  className="shrink-0 border-r border-gray-200 px-3 flex items-center gap-2 overflow-hidden"
                  style={{ width: LEFT_W }}>
                  <span className="text-[11px] font-mono text-gray-400 shrink-0">{stage.number}</span>
                  <span className="text-[11px] text-gray-700 truncate flex-1">{stage.name}</span>
                  {!!stage.issues && (
                    <span className="shrink-0 text-[9px] bg-red-50 text-red-500 border border-red-200 rounded-full px-1 font-medium leading-4">
                      ·{stage.issues}
                    </span>
                  )}
                </div>

                {/* Timeline column */}
                <div className="flex-1 relative overflow-hidden" style={{ height: ROW_H }}>

                  {/* Month grid lines */}
                  {months.map((m, i) => (
                    <div key={i} className="absolute inset-y-0 border-r border-gray-100 last:border-r-0"
                      style={{ left: `${m.l}%`, width: `${m.w}%` }} />
                  ))}

                  {/* Today line */}
                  {todayPct >= 0 && todayPct <= 100 && (
                    <div className="absolute inset-y-0 z-10 pointer-events-none" style={{ left: `${todayPct}%` }}>
                      <div className="absolute inset-y-0 w-px bg-red-400" />
                      <div className="absolute w-2 h-2 rounded-full bg-red-400 -translate-x-1/2 -translate-y-1/2"
                        style={{ top: '50%' }} />
                    </div>
                  )}

                  {/* Bars & Milestones */}
                  {visibleBars.map((bar, bi) => {
                    const layerIdx  = visibleLayers.indexOf(bar.layer)
                    const top       = barTop0 + layerIdx * (BAR_H + BAR_GAP)
                    const { l, w }  = barPos(stage, bar)
                    const isDragging = drag?.stageId === stage.id && drag?.layer === bar.layer
                    const canDrag   = mode === 'edit' && bar.layer === 'contract'
                    const durationDays = Math.round(
                      (toDate(bar.end).getTime() - toDate(bar.start).getTime()) / 86400000
                    )
                    const isPoint = durationDays <= 1

                    if (isPoint) {
                      // Diamond milestone marker centered at bar.start
                      const D = 12  // diamond size px
                      const cx = l + (durationDays === 1 ? w / 2 : 0)  // center on start date
                      return (
                        <div key={bi} className="absolute"
                          style={{ left: `${cx}%`, top: top + (BAR_H - D) / 2, padding: 4, margin: -4 }}
                          onMouseEnter={e => showTooltip(e, stage, bar)}
                          onMouseMove={moveTooltip}
                          onMouseLeave={hideTooltip}
                        >
                          <div
                            className={`absolute transition-none ${canDrag ? 'cursor-ew-resize' : ''} ${isDragging ? 'opacity-60' : ''}`}
                            style={{ width: D, height: D, transform: 'translateX(-50%) rotate(45deg)', background: LAYER_COLOR[bar.layer] }}
                            onMouseDown={e => handleMouseDown(e, stage.id, bar.layer, bar)}
                          />
                          {showTypeLabels && stage.typeLabel && (
                            <span className="absolute left-3 top-0 text-[9px] text-gray-500 whitespace-nowrap leading-3 pointer-events-none">
                              {stage.typeLabel}
                            </span>
                          )}
                        </div>
                      )
                    }

                    return (
                      <div key={bi} className="absolute"
                        style={{ top, height: BAR_H, left: `${l}%`, width: `${w}%` }}
                        onMouseEnter={e => showTooltip(e, stage, bar)}
                        onMouseMove={moveTooltip}
                        onMouseLeave={hideTooltip}
                      >
                        <div
                          className={`absolute inset-0 rounded-sm transition-none ${canDrag ? 'cursor-ew-resize hover:brightness-90' : ''} ${isDragging ? 'opacity-70' : ''}`}
                          style={{ background: LAYER_COLOR[bar.layer] }}
                          onMouseDown={e => handleMouseDown(e, stage.id, bar.layer, bar)}
                        />
                        {showTypeLabels && stage.typeLabel && (
                          <span className="absolute left-full ml-1 top-0 text-[9px] text-gray-500 whitespace-nowrap leading-[11px] pointer-events-none">
                            {stage.typeLabel}
                          </span>
                        )}
                      </div>
                    )
                  })}

                </div>
              </div>
            )
          })}

          {/* Dependency arrow overlay (over timeline column only) */}
          {arrowLines.length > 0 && (
            <div className="absolute inset-y-0 pointer-events-none z-20 overflow-hidden"
              style={{ left: LEFT_W, right: 0 }}>
              {arrowLines.map((a, i) => {
                const clr = '#94a3b8'  // slate-400
                const minY = Math.min(a.srcRowY, a.tgtRowY)
                const maxY = Math.max(a.srcRowY, a.tgtRowY)
                const leftPct  = Math.min(a.srcPct, a.tgtPct)
                const rightPct = Math.max(a.srcPct, a.tgtPct)

                return (
                  <div key={i}>
                    {/* Horizontal: srcPct → tgtPct at source row */}
                    {rightPct > leftPct && (
                      <div className="absolute h-px"
                        style={{ background: clr, top: a.srcRowY - 0.5,
                          left: `${leftPct}%`, width: `${rightPct - leftPct}%` }} />
                    )}
                    {/* Vertical: at tgtPct from srcRowY down to tgtRowY */}
                    <div className="absolute w-px"
                      style={{ background: clr, left: `${a.tgtPct}%`, top: minY, height: maxY - minY }} />
                    {/* Downward arrowhead at (tgtPct, tgtRowY) */}
                    <div className="absolute"
                      style={{ left: `${a.tgtPct}%`, top: a.tgtRowY - 1, transform: 'translateX(-4px)' }}>
                      <div style={{ width: 0, height: 0,
                        borderLeft: '4px solid transparent', borderRight: '4px solid transparent',
                        borderTop: `5px solid ${clr}` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          </div>

        </div>
      </div>

      {/* Hover tooltip */}
      {tooltip && (() => {
        const { stage, bar, x, y } = tooltip
        const days = Math.round((toDate(bar.end).getTime() - toDate(bar.start).getTime()) / 86400000)
        const isPoint = days <= 1
        const flipX = typeof window !== 'undefined' && x > window.innerWidth - 280
        const hasPredecessors = stage.predecessorNames && stage.predecessorNames.length > 0
        return (
          <div
            className="fixed z-[9999] pointer-events-none print:hidden"
            style={{ left: flipX ? x - 14 : x + 14, top: y - 8, transform: flipX ? 'translateX(-100%)' : undefined }}
          >
            <div className="bg-white border border-gray-200 rounded-lg shadow-xl px-3 py-2.5 text-xs min-w-[190px] max-w-[300px]">

              {/* Header: number + name */}
              <div className="flex items-start gap-2 mb-1">
                <span className="font-mono text-[10px] text-gray-400 shrink-0 mt-px">{stage.number}</span>
                <span className="font-semibold text-gray-800 leading-snug">{stage.name}</span>
              </div>

              {/* Type label */}
              {stage.typeLabel && (
                <div className="text-[10px] text-gray-500 mb-1.5 pl-5">{stage.typeLabel}</div>
              )}

              {/* Dates */}
              <div className="border-t border-gray-100 pt-1.5 text-gray-600">
                {isPoint ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-400 text-[10px]">📅</span>
                    <span className="font-medium">{fmtD(bar.start)}</span>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-[10px] w-6 shrink-0">Нач</span>
                      <span className="font-medium">{fmtD(bar.start)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-[10px] w-6 shrink-0">Кон</span>
                      <span className="font-medium">{fmtD(bar.end)}</span>
                    </div>
                    <div className="text-gray-400 text-[10px] pt-0.5">{days} к.д.</div>
                  </div>
                )}
              </div>

              {/* Predecessors */}
              {hasPredecessors && (
                <div className="border-t border-gray-100 pt-1.5 mt-1.5">
                  <div className="text-[10px] font-medium text-gray-500 mb-0.5">Предшественники</div>
                  {stage.predecessorNames!.map((p, i) => (
                    <div key={i} className="text-[10px] text-gray-600 flex items-start gap-1">
                      <span className="text-gray-300 shrink-0">→</span>
                      <span>{p}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Note */}
              {stage.note && (
                <div className="border-t border-gray-100 pt-1.5 mt-1.5">
                  <div className="text-[10px] font-medium text-gray-500 mb-0.5">Примечание</div>
                  <div className="text-[10px] text-gray-600 leading-snug italic whitespace-pre-wrap">{stage.note}</div>
                </div>
              )}

            </div>
          </div>
        )
      })()}

      {/* Print styles */}
      <style>{`
        @media print {
          .gantt-controls { display: none !important; }
          .gantt-scroll { overflow: visible !important; }
          .gantt-root { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}
