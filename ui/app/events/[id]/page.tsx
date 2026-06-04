'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

// /events/[id] — shareable URL для одного события.
// Редирект на /events?open={id}, где основная страница автоматически
// откроет модалку EventLinkModal для этого события.
//
// Зачем редирект, а не полноценная отдельная карточка: EventLinkModal
// уже содержит всю логику просмотра/редактирования (title, date, объекты,
// юр.лица, файлы, LLM-операции). Дублировать её отдельно ради «красивой»
// карточки = ~600 строк копипасты. Текущий компромисс: URL красивый
// (можно копировать и кидать коллегам), а внутри открывается уже знакомая
// модалка поверх списка.
export default function EventByIdPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  useEffect(() => {
    if (id) {
      router.replace(`/events?open=${encodeURIComponent(id)}`)
    }
  }, [id, router])

  return (
    <div className="p-8 text-sm text-gray-500">
      Открываю событие…
    </div>
  )
}
