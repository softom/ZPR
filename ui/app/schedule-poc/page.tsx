'use client'

/**
 * /schedule-poc — страница-обёртка для read-only PoC гантта (DHTMLX Community).
 *
 * Next 16: dynamic(() => import(...), { ssr: false }) допустим ТОЛЬКО внутри
 * клиентской границы, поэтому страница помечена 'use client'. Сам GanttPoc
 * грузится без SSR — dhtmlx-gantt обращается к window/document и на сервере
 * рендериться не может.
 *
 * Контейнер высотой 80vh — DHTMLX занимает всю высоту родителя.
 */

import dynamic from 'next/dynamic'

const GanttPoc = dynamic(() => import('@/components/GanttPoc'), { ssr: false })

export default function SchedulePocPage() {
  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
        График — PoC (DHTMLX Gantt, read-only)
      </h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
        Активная версия графика из <code>schedule_imports (is_active=true)</code>.
        Только чтение: правки в гантте пока не сохраняются.
      </p>
      <div
        style={{
          height: '80vh',
          width: '100%',
          border: '1px solid #e2e2e2',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <GanttPoc />
      </div>
    </main>
  )
}
