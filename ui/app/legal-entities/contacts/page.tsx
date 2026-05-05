'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import ContactFormModal, {
  ContactFormValues,
  EMPTY_CONTACT,
} from '../_components/ContactFormModal'

type Contact = {
  id: string
  legal_entity_id: string | null
  last_name: string
  first_name: string
  middle_name: string | null
  job_title: string | null
  email: string | null
  phone: string | null
  is_active: boolean
  notes: string | null
}

type LegalEntityOption = {
  id: string
  name: string
}

export default function ContactsPage() {
  const [items, setItems] = useState<Contact[]>([])
  const [orgs, setOrgs] = useState<LegalEntityOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // фильтры
  const [search, setSearch] = useState('')
  const [filterOrg, setFilterOrg] = useState<string>('')
  const [showInactive, setShowInactive] = useState(false)

  // модал
  const [modal, setModal] = useState<{
    mode: 'create' | 'edit'
    initial: ContactFormValues
    editingId: string | null
  } | null>(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    const [orgsRes, contactsRes] = await Promise.all([
      supabase.from('legal_entities').select('id,name').order('name'),
      supabase
        .from('contacts')
        .select('*')
        .order('last_name'),
    ])
    if (orgsRes.error) setError(orgsRes.error.message)
    if (contactsRes.error) setError(contactsRes.error.message)
    setOrgs((orgsRes.data || []) as LegalEntityOption[])
    setItems((contactsRes.data || []) as Contact[])
    setLoading(false)
  }

  const orgName = (id: string | null) => orgs.find((o) => o.id === id)?.name ?? '—'

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((c) => {
      if (!showInactive && !c.is_active) return false
      if (filterOrg && c.legal_entity_id !== filterOrg) return false
      if (q) {
        const fio = `${c.last_name} ${c.first_name} ${c.middle_name ?? ''}`.toLowerCase()
        if (!fio.includes(q)) return false
      }
      return true
    })
  }, [items, search, filterOrg, showInactive])

  function openCreate() {
    setModal({
      mode: 'create',
      initial: { ...EMPTY_CONTACT, legal_entity_id: filterOrg || null },
      editingId: null,
    })
  }

  function openEdit(c: Contact) {
    setModal({
      mode: 'edit',
      initial: {
        legal_entity_id: c.legal_entity_id,
        last_name: c.last_name,
        first_name: c.first_name,
        middle_name: c.middle_name ?? '',
        job_title: c.job_title ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
        is_active: c.is_active,
        notes: c.notes ?? '',
      },
      editingId: c.id,
    })
  }

  async function deactivate(c: Contact) {
    if (!confirm(`Деактивировать «${c.last_name} ${c.first_name}»?`)) return
    const { error: e } = await supabase
      .from('contacts')
      .update({ is_active: false })
      .eq('id', c.id)
    if (e) {
      alert(e.message)
      return
    }
    load()
  }

  async function activate(c: Contact) {
    const { error: e } = await supabase
      .from('contacts')
      .update({ is_active: true })
      .eq('id', c.id)
    if (e) {
      alert(e.message)
      return
    }
    load()
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Контакты</h1>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Добавить
        </button>
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Поиск по ФИО…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
        />
        <select
          value={filterOrg}
          onChange={(e) => setFilterOrg(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Все организации</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded"
          />
          Показать неактивных
        </label>
        <span className="text-sm text-gray-400 ml-auto">
          {filtered.length} из {items.length}
        </span>
      </div>

      {error && !modal && (
        <div className="p-3 mb-4 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div>Загрузка…</div>
      ) : (
        <div className="overflow-x-auto bg-white rounded shadow">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left text-gray-700">
                <th className="px-4 py-3">Организация</th>
                <th className="px-4 py-3">Фамилия</th>
                <th className="px-4 py-3">Имя</th>
                <th className="px-4 py-3">Отчество</th>
                <th className="px-4 py-3">Должность</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Телефон</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  className={`border-b hover:bg-gray-50 ${
                    c.is_active ? '' : 'text-gray-400'
                  }`}
                >
                  <td className="px-4 py-3 text-gray-700">
                    {orgName(c.legal_entity_id)}
                  </td>
                  <td className="px-4 py-3 font-medium">{c.last_name}</td>
                  <td className="px-4 py-3">{c.first_name}</td>
                  <td className="px-4 py-3 text-gray-600">{c.middle_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{c.job_title || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                    {c.email || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                    {c.phone || '—'}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => openEdit(c)}
                      className="text-blue-600 hover:text-blue-800 mr-3"
                    >
                      Изменить
                    </button>
                    {c.is_active ? (
                      <button
                        onClick={() => deactivate(c)}
                        className="text-gray-500 hover:text-gray-700"
                      >
                        Деактивировать
                      </button>
                    ) : (
                      <button
                        onClick={() => activate(c)}
                        className="text-green-600 hover:text-green-800"
                      >
                        Активировать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-400">
                    {items.length === 0
                      ? 'Контактов ещё нет'
                      : 'Ни один контакт не подходит под фильтры'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <ContactFormModal
          mode={modal.mode}
          initial={modal.initial}
          editingId={modal.editingId}
          orgs={orgs}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            load()
          }}
        />
      )}
    </div>
  )
}
