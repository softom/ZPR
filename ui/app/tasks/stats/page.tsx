'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// Раздел статистики переехал в /reports/stats — даём редирект
// для старых закладок и ссылок из /tasks.
export default function TasksStatsRedirectPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/reports/stats')
  }, [router])
  return (
    <div className="max-w-3xl mx-auto p-8 text-center">
      <p className="text-sm text-gray-500 mb-3">
        Раздел переехал — статистика теперь в Отчётах.
      </p>
      <Link
        href="/reports/stats"
        className="inline-block px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
      >
        Перейти к /reports/stats
      </Link>
    </div>
  )
}
