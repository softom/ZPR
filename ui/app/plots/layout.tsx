'use client'

// Раздел «Карта» (бывш. «Участки»). Сайдбар верхнего уровня ведёт сразу
// на /plots → /plots/map. Альтернативные представления (/plots/zones,
// /plots/staging, /plots/cadastrals) остаются доступны напрямую по URL,
// но из основного сценария их заменяет переключатель режима в правой
// панели карты.
export default function PlotsLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
}
