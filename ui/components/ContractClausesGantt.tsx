'use client'

/**
 * ContractClausesGantt — ленточная диаграмма «События договора» для карточки
 * договора (/contracts/[id]). Самостоятельно собирает данные из уже загруженных
 * на странице clauses + contract_stages + contract_event_types и передаёт
 * в самописный <GanttChart>.
 *
 * Компактный режим: rowHeight=28, leftWidth=320 — на странице договора
 * нужна плотная подача (50+ пунктов) с читаемыми заголовками.
 *
 * Группировка строк (left column = group):
 *   • Этап N · название этапа — для пунктов с stage_id
 *   • «Без этапа» — для пунктов с stage_id = NULL (включая якорь)
 *
 * Цвет бара (через bar.color override, чтобы не множить layer-слоты в строке):
 *   • date_source='contract' → синий (#60a5fa)
 *   • date_source='edited'   → зелёный (#4ade80)
 *   • date_mode='term'       → серый (#d1d5db) — расчётная (computed на лету)
 *
 * Все бары имеют layer='contract' — это даёт ровно ОДИН ромб/полосу на строку,
 * без вертикального стэкинга трёх слоёв. Стрелки зависимостей — term_ref_clause_id.
 * typeLabel — icon из contract_event_types по event_type_id.
 */

import { useMemo } from 'react'
import GanttChart, { type GanttLayer, type GanttStage } from '@/components/GanttChart'
import { computeAllClauseDates } from '@/lib/contracts/computeClauseDates'
import { computeStageDateRanges } from '@/lib/contracts/computeStageDates'

// Типы, совместимые с интерфейсом ClauseInput из computeClauseDates +
// дополнительными полями для отрисовки (id, description, stage_id, event_type_id, date_source).
export interface GanttClause {
  id: string
  order_index: number
  description: string
  clause_date: string | null
  term_days: number | null
  term_type: 'working' | 'calendar' | null
  term_base: 'clause' | null
  term_text: string | null
  term_ref_clause_id: string | null
  is_anchor: boolean
  date_mode: 'date' | 'term' | null
  stage_id: string | null
  event_type_id: string | null
  date_source: 'contract' | 'edited' | 'computed'
  note?: string | null
  source_quote?: string | null
}

export interface GanttContractStage {
  id: string
  stage_number: number
  stage_name: string
  sort_order: number
}

export interface GanttEventType {
  id: string
  code: string                // 'work_start' / 'work_result_delivery' / ...
  icon: string | null
  label: string
}

interface Props {
  clauses: GanttClause[]
  stages: GanttContractStage[]
  eventTypes: GanttEventType[]
  signedDate?: string | null
  className?: string
}

export default function ContractClausesGantt({
  clauses, stages, eventTypes, signedDate, className = '',
}: Props) {
  const typeById = useMemo(() => {
    const m = new Map<string, GanttEventType>()
    for (const t of eventTypes) m.set(t.id, t)
    return m
  }, [eventTypes])

  const stageById = useMemo(() => {
    const m = new Map<string, GanttContractStage>()
    for (const s of stages) m.set(s.id, s)
    return m
  }, [stages])

  // Резолв расчётных дат (для term-режима)
  const datesMap = useMemo(
    () => computeAllClauseDates(clauses, { signedDate }),
    [clauses, signedDate],
  )

  // Диапазоны дат этапов: явные work_start / work_result_delivery, иначе min/max
  const stageDateRanges = useMemo(
    () => computeStageDateRanges(clauses, eventTypes, signedDate ?? null),
    [clauses, eventTypes, signedDate],
  )

  const ganttStages: GanttStage[] = useMemo(() => {
    // Сортировка строк Gantt:
    //   1) stage.sort_order — этапы идут в правильной последовательности
    //      (без этапа = -1 → наверх, включая якорь)
    //   2) computed_date — внутри этапа строки идут по возрастанию даты
    //      (визуально монотонно слева-направо; иначе стрелки зависимостей рисуют зигзаги)
    //   3) order_index — стабильный tie-breaker для пунктов с одинаковой/пустой датой
    //
    // Пункты без resolved-даты получают синтетическую дату '9999-12-31', чтобы
    // отбрасываться в конец стейджа (там они отображаются строками без бара).
    const NO_DATE = '9999-12-31'
    const sortKey = (c: GanttClause) => {
      const st = c.stage_id ? stageById.get(c.stage_id) : null
      const stKey = st ? st.sort_order : -1
      const d = datesMap.get(c.id)?.date ?? NO_DATE
      return [stKey, d, c.order_index] as const
    }

    const sorted = clauses
      .slice()
      .sort((a, b) => {
        const [sa, da, oa] = sortKey(a)
        const [sb, db, ob] = sortKey(b)
        if (sa !== sb) return sa - sb
        if (da !== db) return da < db ? -1 : 1
        return oa - ob
      })

    const result: GanttStage[] = []
    const insertedStageBars = new Set<string>()

    const fmtShort = (s: string) => {
      const [y, m, d] = s.split('-')
      return `${d}.${m}.${y.slice(2)}`
    }

    // Если у этапа start === end (один день), искусственно расширяем end на +1 день
    // чтобы получилась полоса, а не ромб (group-bar должен быть «контейнером»).
    const widenIfSame = (start: string, end: string): { start: string; end: string } => {
      if (start !== end) return { start, end }
      const d = new Date(end + 'T12:00:00')
      d.setDate(d.getDate() + 1)
      return { start, end: d.toISOString().slice(0, 10) }
    }

    // Один проход. Если у клаузы есть дата — рисуем бар; если нет —
    // всё равно добавляем строку (без бара), чтобы оператор видел её в списке.
    // Это важно: события «5 раб. дн. с даты подписания» без resolved формулы
    // иначе исчезают с Gantt, при том что они есть в БД.
    for (const c of sorted) {
      const dr = datesMap.get(c.id)
      const hasDate = !!dr?.date

      // ─── group-bar перед первой клаузой этапа ───────────────────
      if (c.stage_id && !insertedStageBars.has(c.stage_id)) {
        insertedStageBars.add(c.stage_id)
        const stageInfo = stageById.get(c.stage_id)
        const range = stageDateRanges.get(c.stage_id)
        if (stageInfo && range && range.start && range.end) {
          const { start: rs, end: re } = widenIfSame(range.start, range.end)
          const startMark = range.startSource === 'explicit' ? '▶' : '↦'
          const endMark   = range.endSource   === 'explicit' ? '🏁' : '↤'
          result.push({
            id:     `__stage_${stageInfo.id}`,
            number: `Этап ${stageInfo.stage_number}`,
            name:   `${stageInfo.stage_name} · ${startMark} ${fmtShort(range.start)} — ${endMark} ${fmtShort(range.end)} · ${range.clausesCount} событ.`,
            bars:   [{
              layer: 'contract' as GanttLayer,
              start: rs,
              end:   re,
              color: 'rgba(167, 139, 250, 0.35)', // violet-400 с прозрачностью
            }],
            typeLabel: '🎯',
            date: `${fmtShort(range.start)}—${fmtShort(range.end)}`,
          })
        }
      }

      // ─── строка-клауза ──────────────────────────────────────────
      const stage = c.stage_id ? stageById.get(c.stage_id) : null
      const number = stage
        ? `${stage.stage_number}`
        : (c.is_anchor ? '📌' : '·')
      const groupName = stage
        ? `Этап ${stage.stage_number} · ${stage.stage_name}`
        : (c.is_anchor ? 'Дата заключения' : 'Без этапа')

      const type = c.event_type_id ? typeById.get(c.event_type_id) : null
      const typeLabel = type?.icon ?? undefined

      const noteParts: string[] = []
      if (c.note) noteParts.push(c.note)
      if (c.source_quote) noteParts.push(`📄 ${c.source_quote.slice(0, 200)}${c.source_quote.length > 200 ? '…' : ''}`)
      if (c.term_text) noteParts.push(`⏱ ${c.term_text}`)
      if (!hasDate && dr?.reason) noteParts.push(`⚠ ${dr.reason}`)
      const note = noteParts.join('\n') || undefined

      let bars: typeof result[number]['bars'] = []
      let dateShort: string

      if (hasDate) {
        const end = dr!.date!
        const start = end  // милстоун

        const isTermMode = c.date_mode === 'term'
        const effectiveSource: 'contract' | 'edited' | 'computed' =
          isTermMode ? 'computed' : c.date_source

        const layer: GanttLayer = 'contract'
        const color =
          effectiveSource === 'edited'   ? '#4ade80' :  // зелёный — изменённая
          effectiveSource === 'computed' ? '#d1d5db' :  // серый   — расчётная
                                           '#60a5fa'   // синий  — договорная

        bars = [{ layer, start, end, color }]
        const [yy, mm, dd] = end.split('-')
        dateShort = `${dd}.${mm}.${yy.slice(2)}`
      } else {
        // Дата не разрешена (формула без term_ref_clause_id, пустые поля, и т.п.)
        // Показываем строку с прочерком — оператор видит, что событие есть.
        dateShort = '—'
      }

      result.push({
        id:           c.id,
        number,
        name:         `${groupName} — ${c.description}`.slice(0, 160),
        bars,
        typeLabel,
        note,
        dependencies: c.term_ref_clause_id ? [c.term_ref_clause_id] : undefined,
        date:         dateShort,
      })
    }

    return result
  }, [clauses, stageById, typeById, datesMap, stageDateRanges])

  if (ganttStages.length === 0) {
    return (
      <div className={`p-6 text-center text-gray-400 text-sm border rounded ${className}`}>
        Нет событий договора. Нажмите «🎯 Выделить события договора» — LLM разберёт пункты из текста.
      </div>
    )
  }

  return (
    <GanttChart
      stages={ganttStages}
      mode="view"
      layers={['contract']}
      today={new Date().toISOString().split('T')[0]}
      showTypeLabels={true}
      rowHeight={28}
      leftWidth={425}
      className={className}
    />
  )
}
