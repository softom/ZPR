import { redirect } from 'next/navigation'

// Главная страница раздела «Участки». Основной экран — карта (target-режим +
// аудит-пресеты). Остальное (стейджинг, зоны ППТ) — дополнительные вкладки.
export default function PlotsIndexPage() {
  redirect('/plots/map')
}
