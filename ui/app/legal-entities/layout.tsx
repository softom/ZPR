'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const tabs = [
  { href: '/legal-entities',          label: 'Юр. лица' },
  { href: '/legal-entities/contacts', label: 'Контакты' },
]

export default function LegalEntitiesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div>
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-1 -mb-px">
          {tabs.map(({ href, label }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </nav>
      </div>
      {children}
    </div>
  )
}
