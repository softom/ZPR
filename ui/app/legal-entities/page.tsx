'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import ContactFormModal, {
  ContactFormValues,
  EMPTY_CONTACT,
} from './_components/ContactFormModal'

type LegalEntity = {
  id: string
  name: string
  inn: string | null
  kpp: string | null
  ogrn: string | null
  address: string | null
  signatory_name: string | null
  signatory_position: string | null
  aliases: string[]
  created_at: string
  updated_at: string
  tasks_count?: number
  contacts_count?: number
}

type Contact = {
  id: string
  last_name: string
  first_name: string
  middle_name: string | null
  job_title: string | null
  email: string | null
  phone: string | null
  is_active: boolean
  notes: string | null
}

const EMPTY: Omit<LegalEntity, 'id' | 'created_at' | 'updated_at'> = {
  name: '',
  inn: '',
  kpp: '',
  ogrn: '',
  address: '',
  signatory_name: '',
  signatory_position: '',
  aliases: [],
}

export default function LegalEntitiesPage() {
  const [items, setItems] = useState<LegalEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<LegalEntity | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [aliasesText, setAliasesText] = useState('')
  const [saving, setSaving] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactModal, setContactModal] = useState<{
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
    const { data, error: e1 } = await supabase
      .from('legal_entities')
      .select('*')
      .order('name')
    if (e1) {
      setError(e1.message)
      setLoading(false)
      return
    }
    // Подсчёт задач и контактов — параллельно для каждого юр.лица
    const withCounts = await Promise.all(
      (data || []).map(async (le) => {
        const [tasksRes, contactsRes] = await Promise.all([
          supabase
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('assignee_entity_id', le.id),
          supabase
            .from('contacts')
            .select('id', { count: 'exact', head: true })
            .eq('legal_entity_id', le.id),
        ])
        return {
          ...le,
          aliases: Array.isArray(le.aliases) ? le.aliases : [],
          tasks_count: tasksRes.count ?? 0,
          contacts_count: contactsRes.count ?? 0,
        }
      })
    )
    setItems(withCounts)
    setLoading(false)
  }

  async function loadContactsFor(legalEntityId: string) {
    setContactsLoading(true)
    const { data, error: e } = await supabase
      .from('contacts')
      .select('id,last_name,first_name,middle_name,job_title,email,phone,is_active,notes')
      .eq('legal_entity_id', legalEntityId)
      .order('last_name')
    setContactsLoading(false)
    if (e) {
      console.error('Failed to load contacts', e)
      setContacts([])
      return
    }
    setContacts((data || []) as Contact[])
  }

  function openCreateContact() {
    if (!editing) return
    setContactModal({
      mode: 'create',
      initial: { ...EMPTY_CONTACT, legal_entity_id: editing.id },
      editingId: null,
    })
  }

  function openEditContact(c: Contact) {
    setContactModal({
      mode: 'edit',
      initial: {
        legal_entity_id: editing?.id ?? null,
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

  async function deactivateContact(c: Contact) {
    if (!confirm(`Деактивировать «${c.last_name} ${c.first_name}»?`)) return
    const { error: e } = await supabase
      .from('contacts')
      .update({ is_active: false })
      .eq('id', c.id)
    if (e) {
      alert(e.message)
      return
    }
    if (editing) loadContactsFor(editing.id)
  }

  async function activateContact(c: Contact) {
    const { error: e } = await supabase
      .from('contacts')
      .update({ is_active: true })
      .eq('id', c.id)
    if (e) {
      alert(e.message)
      return
    }
    if (editing) loadContactsFor(editing.id)
  }

  function openCreate() {
    setForm(EMPTY)
    setAliasesText('')
    setContacts([])
    setEditing(null)
    setCreating(true)
  }

  function openEdit(item: LegalEntity) {
    setForm({
      name: item.name,
      inn: item.inn ?? '',
      kpp: item.kpp ?? '',
      ogrn: item.ogrn ?? '',
      address: item.address ?? '',
      signatory_name: item.signatory_name ?? '',
      signatory_position: item.signatory_position ?? '',
      aliases: item.aliases ?? [],
    })
    setAliasesText((item.aliases ?? []).join('\n'))
    setEditing(item)
    setCreating(false)
    setContacts([])
    loadContactsFor(item.id)
  }

  function close() {
    setEditing(null)
    setCreating(false)
    setForm(EMPTY)
    setAliasesText('')
    setContacts([])
    setError('')
    setContactModal(null)
    // обновим основной список — счётчики контактов могли измениться
    load()
  }

  async function save() {
    setSaving(true)
    setError('')
    // aliases: одна строка = один alias, пустые игнорируем, дедуп
    const aliases = Array.from(
      new Set(
        aliasesText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    )
    const payload = {
      name: form.name.trim(),
      inn: form.inn?.trim() || null,
      kpp: form.kpp?.trim() || null,
      ogrn: form.ogrn?.trim() || null,
      address: form.address?.trim() || null,
      signatory_name: form.signatory_name?.trim() || null,
      signatory_position: form.signatory_position?.trim() || null,
      aliases,
    }
    if (!payload.name) {
      setError('Поле «Название» обязательно')
      setSaving(false)
      return
    }
    if (editing) {
      const { error: e } = await supabase
        .from('legal_entities')
        .update(payload)
        .eq('id', editing.id)
      if (e) {
        setError(e.message)
        setSaving(false)
        return
      }
    } else {
      const { error: e } = await supabase.from('legal_entities').insert(payload)
      if (e) {
        setError(e.message)
        setSaving(false)
        return
      }
    }
    setSaving(false)
    close()
  }

  async function remove(item: LegalEntity) {
    if (item.tasks_count && item.tasks_count > 0) {
      if (
        !confirm(
          `К этой организации привязано ${item.tasks_count} задач. Они потеряют связь. Удалить всё равно?`
        )
      ) {
        return
      }
    } else {
      if (!confirm(`Удалить «${item.name}»?`)) return
    }
    const { error: e } = await supabase
      .from('legal_entities')
      .delete()
      .eq('id', item.id)
    if (e) {
      alert(e.message)
      return
    }
    load()
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Юридические лица</h1>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Добавить
        </button>
      </div>

      {error && !editing && !creating && (
        <div className="p-3 mb-4 bg-red-50 text-red-700 border border-red-200 rounded">
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
                <th className="px-4 py-3">Название</th>
                <th className="px-4 py-3">ИНН</th>
                <th className="px-4 py-3">Алиасы</th>
                <th className="px-4 py-3">Подписант</th>
                <th className="px-4 py-3 text-center">Контактов</th>
                <th className="px-4 py-3 text-center">Задач</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{it.name}</td>
                  <td className="px-4 py-3 font-mono text-gray-700">{it.inn || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-xs">
                    {it.aliases && it.aliases.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {it.aliases.slice(0, 4).map((a, i) => (
                          <span
                            key={i}
                            className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs"
                          >
                            {a}
                          </span>
                        ))}
                        {it.aliases.length > 4 && (
                          <span className="text-xs text-gray-400">
                            +{it.aliases.length - 4}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {it.signatory_name ? (
                      <>
                        {it.signatory_name}
                        {it.signatory_position && (
                          <span className="block text-xs text-gray-400">
                            {it.signatory_position}
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={
                        it.contacts_count
                          ? 'inline-block px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium'
                          : 'text-gray-400'
                      }
                    >
                      {it.contacts_count || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={
                        it.tasks_count
                          ? 'inline-block px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium'
                          : 'text-gray-400'
                      }
                    >
                      {it.tasks_count || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEdit(it)}
                      className="text-blue-600 hover:text-blue-800 mr-3"
                    >
                      Изменить
                    </button>
                    <button
                      onClick={() => remove(it)}
                      className="text-red-600 hover:text-red-800"
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                    Юридических лиц ещё нет
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {(editing || creating) && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={close}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold">
                {creating ? 'Новое юр.лицо' : 'Изменить'}
              </h2>
            </div>
            <div className="p-6 space-y-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
                  {error}
                </div>
              )}
              <Field
                label="Название *"
                value={form.name}
                onChange={(v) => setForm({ ...form, name: v })}
                placeholder="ООО «...»"
                hint="Официальное название как в реквизитах/договоре"
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Альтернативные названия
                </label>
                <textarea
                  value={aliasesText}
                  onChange={(e) => setAliasesText(e.target.value)}
                  placeholder={'Бренд / латиница / сокращение / прежнее имя\nОдна строка = один вариант'}
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Используется при импорте контактов и задач для разрешения
                  разных написаний (Хэдс Групп / Heads Group / ХГ)
                </p>
              </div>
              <Field
                label="ИНН"
                value={form.inn || ''}
                onChange={(v) => setForm({ ...form, inn: v })}
                placeholder="10–12 цифр (опционально)"
                hint="Уникален. Может быть пустым для организаций до загрузки договора"
              />
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="КПП"
                  value={form.kpp || ''}
                  onChange={(v) => setForm({ ...form, kpp: v })}
                  placeholder="9 цифр"
                />
                <Field
                  label="ОГРН"
                  value={form.ogrn || ''}
                  onChange={(v) => setForm({ ...form, ogrn: v })}
                  placeholder="13 или 15 цифр"
                />
              </div>
              <Field
                label="Адрес"
                value={form.address || ''}
                onChange={(v) => setForm({ ...form, address: v })}
                placeholder="Юридический адрес"
                multiline
              />
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Подписант — ФИО"
                  value={form.signatory_name || ''}
                  onChange={(v) => setForm({ ...form, signatory_name: v })}
                  placeholder="Иванов И.И."
                />
                <Field
                  label="Подписант — должность"
                  value={form.signatory_position || ''}
                  onChange={(v) => setForm({ ...form, signatory_position: v })}
                  placeholder="Генеральный директор"
                />
              </div>

              {editing && (
                <div className="pt-4 border-t">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-700">
                      Контакты ({contacts.length})
                    </h3>
                    <button
                      onClick={openCreateContact}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                    >
                      + Добавить контакт
                    </button>
                  </div>
                  {contactsLoading ? (
                    <div className="text-sm text-gray-500">Загрузка контактов…</div>
                  ) : contacts.length === 0 ? (
                    <div className="text-sm text-gray-400">
                      Контактов нет. Можно также импортировать скриптом{' '}
                      <span className="font-mono">contacts_importer.py</span>.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border rounded">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr className="text-left text-gray-600 text-xs">
                            <th className="px-3 py-2">ФИО</th>
                            <th className="px-3 py-2">Должность</th>
                            <th className="px-3 py-2">Email</th>
                            <th className="px-3 py-2">Телефон</th>
                            <th className="px-3 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {contacts.map((c) => {
                            const fio = [c.last_name, c.first_name, c.middle_name]
                              .filter(Boolean)
                              .join(' ')
                            return (
                              <tr
                                key={c.id}
                                className={`border-t ${
                                  c.is_active ? '' : 'text-gray-400'
                                }`}
                              >
                                <td className="px-3 py-2 font-medium">{fio}</td>
                                <td className="px-3 py-2 text-gray-600">
                                  {c.job_title || '—'}
                                </td>
                                <td className="px-3 py-2 text-gray-600 font-mono text-xs">
                                  {c.email || '—'}
                                </td>
                                <td className="px-3 py-2 text-gray-600 font-mono text-xs">
                                  {c.phone || '—'}
                                </td>
                                <td className="px-3 py-2 text-right whitespace-nowrap">
                                  <button
                                    onClick={() => openEditContact(c)}
                                    className="text-blue-600 hover:text-blue-800 text-xs mr-2"
                                  >
                                    Изменить
                                  </button>
                                  {c.is_active ? (
                                    <button
                                      onClick={() => deactivateContact(c)}
                                      className="text-gray-500 hover:text-gray-700 text-xs"
                                    >
                                      Деактивировать
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => activateContact(c)}
                                      className="text-green-600 hover:text-green-800 text-xs"
                                    >
                                      Активировать
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-6 border-t bg-gray-50 flex justify-end gap-3">
              <button
                onClick={close}
                disabled={saving}
                className="px-4 py-2 bg-white border rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {contactModal && editing && (
        <ContactFormModal
          mode={contactModal.mode}
          initial={contactModal.initial}
          editingId={contactModal.editingId}
          orgs={[]}
          lockedLegalEntityId={editing.id}
          lockedLegalEntityName={editing.name}
          nested
          onClose={() => setContactModal(null)}
          onSaved={() => {
            setContactModal(null)
            loadContactsFor(editing.id)
          }}
        />
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  multiline?: boolean
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      )}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  )
}
