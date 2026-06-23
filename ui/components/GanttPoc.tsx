'use client'

/**
 * GanttPoc — read-only PoC рендера активной версии графика в DHTMLX Gantt
 * (Community/MIT, пакет 'dhtmlx-gantt').
 *
 * Тянет /api/schedule/gantt → { data: GanttTask[], links: GanttLink[] } и
 * скармливает в gantt.parse. Это B-слайс: чтение работает, write-path только
 * заготовлен (см. контракт OWNED_PATCH_FIELDS в lib/schedule/ganttModel.ts —
 * PATCH сюда ещё не подключён).
 *
 * Конфиг дат фиксирован '%Y-%m-%d %H:%i' — ровно формат start_date, который
 * отдаёт entryToGanttTask ('YYYY-MM-DD HH:mm'). work_time ВЫКЛЮЧЕН: маппер
 * считает duration как календарную (inclusive) длительность, поэтому полоса
 * должна совпадать с диапазоном дат, не «растягиваясь» через выходные.
 *
 * ВАЖНО: gantt — глобальный синглтон внутри пакета. Поэтому при размонтировании
 * обязателен gantt.clearAll(), иначе при повторном маунте (HMR/навигация)
 * остаются старые задачи и обработчики.
 */

import { useEffect, useRef, useState } from 'react'
import { gantt } from 'dhtmlx-gantt'
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css'
import type { GanttTask, GanttLink } from '@/lib/schedule/ganttModel'

interface GanttResponse {
  data: GanttTask[]
  links: GanttLink[]
  version?: { id: string; name: string | null } | null
  error?: string
}

export default function GanttPoc() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // ─── Конфиг gantt (до init) ────────────────────────────────────────────
    // readonly:false — B-слайс готовит почву под write-path, но drag/edit пока
    // никуда не сохраняется (PATCH не подключён). Формат дат совпадает с тем,
    // что отдаёт API (entryToGanttTask: 'YYYY-MM-DD HH:mm').
    gantt.config.readonly = false
    gantt.config.date_format = '%Y-%m-%d %H:%i'
    // work_time=false: duration из маппера — календарная (inclusive), полоса
    // должна совпадать с date_start..date_end, а не растягиваться через выходные.
    gantt.config.work_time = false
    gantt.config.fit_tasks = true
    // Колонки таблицы слева: имя + даты начала/окончания.
    gantt.config.columns = [
      { name: 'text', label: 'Задача', tree: true, width: '*', min_width: 220 },
      { name: 'start_date', label: 'Начало', align: 'center', width: 90 },
      { name: 'duration', label: 'Дн.', align: 'center', width: 50 },
    ]

    let cancelled = false

    gantt.init(container)

    // ─── Загрузка датасета активной версии ─────────────────────────────────
    setLoading(true)
    setError(null)
    fetch('/api/schedule/gantt')
      .then(async (res) => {
        const body = (await res.json()) as GanttResponse
        if (!res.ok || body.error) {
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        return body
      })
      .then((body) => {
        if (cancelled) return
        gantt.clearAll()
        // body.data/links — GanttTask[]/GanttLink[]; каст к внутреннему типу
        // dhtmlx-gantt (NewTask[]/Link[]), форма полей совпадает.
        gantt.parse({ data: body.data, links: body.links } as unknown as Parameters<typeof gantt.parse>[0])
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })

    // ─── Cleanup ───────────────────────────────────────────────────────────
    // gantt — глобальный синглтон: чистим данные и снимаем привязку к DOM,
    // чтобы повторный маунт начинал с чистого листа.
    return () => {
      cancelled = true
      gantt.clearAll()
      try {
        gantt.destructor()
      } catch {
        // destructor может бросить, если init не завершился — не критично для PoC.
      }
    }
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {loading && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 10,
            padding: '4px 10px',
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid #ddd',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          Загрузка графика…
        </div>
      )}
      {error && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 10,
            padding: '8px 12px',
            background: '#fde8e8',
            border: '1px solid #f5b5b5',
            borderRadius: 4,
            color: '#9b1c1c',
            fontSize: 13,
            maxWidth: '90%',
          }}
        >
          Ошибка загрузки графика: {error}
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}
