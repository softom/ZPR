'use client'

import { useEffect, useRef } from 'react'
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css'

export default function GanttDemoPage() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let ganttInstance: typeof import('dhtmlx-gantt').gantt | null = null

    import('dhtmlx-gantt').then(({ gantt }) => {
      if (cancelled || !containerRef.current) return
      ganttInstance = gantt

      gantt.config.date_format = '%Y-%m-%d'
      gantt.config.scale_height = 50
      gantt.config.row_height = 30
      gantt.config.grid_width = 380
      gantt.i18n.setLocale('ru')

      gantt.init(containerRef.current)

      gantt.parse({
        data: [
          { id: 1, text: 'Подготовка участка', type: 'project', start_date: '2026-04-01', duration: 18, progress: 0.4, open: true },
          { id: 2, text: 'Расчистка территории', start_date: '2026-04-01', duration: 5, progress: 0.8, parent: 1 },
          { id: 3, text: 'Земляные работы', start_date: '2026-04-06', duration: 8, progress: 0.5, parent: 1 },
          { id: 4, text: 'Фундамент', start_date: '2026-04-14', duration: 10, progress: 0.1, parent: 1 },
          { id: 5, text: 'Стены', start_date: '2026-04-24', duration: 14, progress: 0 },
          { id: 6, text: 'Кровля', start_date: '2026-05-08', duration: 7, progress: 0 },
        ],
        links: [
          { id: 1, source: 2, target: 3, type: '0' },
          { id: 2, source: 3, target: 4, type: '0' },
          { id: 3, source: 4, target: 5, type: '0' },
          { id: 4, source: 5, target: 6, type: '0' },
        ],
      })
    })

    return () => {
      cancelled = true
      ganttInstance?.clearAll()
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">DHTMLX Gantt — smoke test</h1>
        <p className="text-sm text-gray-600">
          Проверка интеграции <code>dhtmlx-gantt@9.1.3</code> (GPL Standard) с Next.js 16 / React 19.
          Данные захардкожены, БД не подключена.
        </p>
      </header>
      <div ref={containerRef} style={{ width: '100%', height: '600px' }} />
    </div>
  )
}
