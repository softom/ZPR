'use client'

import { useState } from 'react'
import ObjectSchema, { type MapGeoData } from './ObjectSchema'

// Обложка объекта для печатной формы отчёта.
// Источник — PNG в Supabase Storage, бакет `report-covers` (публичный).
// Имя файла = НОМЕР объекта (префикс кода до первого подчёркивания) —
// совпадает с номером в заголовке объекта (ObjectTitle):
//   "001_МАСТЕРПЛАН"    → .../report-covers/001.png
//   "101_ГОСТИНИЦА_350" → .../report-covers/101.png
//   "301_ОБЩЕЖИТИЕ_450" → .../report-covers/301.png
// Имя стабильно привязано к объекту (не зависит от состава/порядка отчёта).
// Если PNG не загружен (404) — откатываемся на авто-SVG-схему
// (ObjectSchema), чтобы лист объекта не остался без графики.

// База Supabase Storage (публичный URL объектов бакета report-covers).
const COVER_BASE =
  `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/storage/v1/object/public/report-covers`
export default function ObjectCover({
  code,
  objectName,
  geoData,
}: {
  code: string
  objectName?: string | null
  geoData: MapGeoData | null
}) {
  const [failed, setFailed] = useState(false)

  // Имя файла = префикс кода до первого подчёркивания: "101_ГОСТИНИЦА_350"
  // → "101". Если подчёркивания нет — код целиком (на всякий случай).
  const prefix = (code.split('_')[0] || code).trim()
  const src = `${COVER_BASE}/${encodeURIComponent(prefix)}.png`

  // Фолбэк: PNG нет → показываем SVG-схему (если есть гео-данные).
  if (failed) {
    return geoData ? (
      <ObjectSchema targetObjectCode={code} targetObjectName={objectName} geoData={geoData} />
    ) : null
  }

  return (
    <figure className="report-cover-figure my-3">
      {/* Статичный PNG для печати: next/image не нужен (оптимизация не
          помогает печати и усложняет фолбэк по onError). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`Обложка объекта ${code}`}
        onError={() => setFailed(true)}
        className="report-cover-img"
        style={{ width: '100%', height: 'auto', objectFit: 'contain' }}
      />
    </figure>
  )
}
