'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export type ContactFormValues = {
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

export const EMPTY_CONTACT: ContactFormValues = {
  legal_entity_id: null,
  last_name: '',
  first_name: '',
  middle_name: '',
  job_title: '',
  email: '',
  phone: '',
  is_active: true,
  notes: '',
}

type Props = {
  mode: 'create' | 'edit'
  initial: ContactFormValues
  editingId: string | null
  orgs: { id: string; name: string }[]
  lockedLegalEntityId?: string
  lockedLegalEntityName?: string
  nested?: boolean
  onClose: () => void
  onSaved: () => void
}

export default function ContactFormModal({
  mode,
  initial,
  editingId,
  orgs,
  lockedLegalEntityId,
  lockedLegalEntityName,
  nested,
  onClose,
  onSaved,
}: Props) {
  const [form, setForm] = useState<ContactFormValues>({
    ...initial,
    legal_entity_id: lockedLegalEntityId ?? initial.legal_entity_id,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    const payload = {
      legal_entity_id: lockedLegalEntityId ?? form.legal_entity_id ?? null,
      last_name: form.last_name.trim(),
      first_name: form.first_name.trim(),
      middle_name: form.middle_name?.trim() || null,
      job_title: form.job_title?.trim() || null,
      email: form.email?.trim() || null,
      phone: form.phone?.trim() || null,
      is_active: form.is_active,
      notes: form.notes?.trim() || null,
    }
    if (!payload.last_name || !payload.first_name) {
      setError('Поля «Фамилия» и «Имя» обязательны')
      setSaving(false)
      return
    }
    if (!payload.legal_entity_id) {
      setError('Выберите организацию')
      setSaving(false)
      return
    }
    let err
    if (mode === 'edit' && editingId) {
      ;({ error: err } = await supabase
        .from('contacts')
        .update(payload)
        .eq('id', editingId))
    } else {
      ;({ error: err } = await supabase.from('contacts').insert(payload))
    }
    setSaving(false)
    if (err) {
      console.error('[contact save]', err)
      if (err.code === '23505' || err.message.includes('contacts_unique_per_org_idx')) {
        setError('Контакт с таким ФИО уже существует в этой организации')
      } else if (err.message.includes('row-level security') || err.message.includes('row level security')) {
        setError('Нет прав. Сессия могла истечь — выйдите и войдите снова (нужна роль uploader / admin).')
      } else {
        setError(err.message)
      }
      return
    }
    onSaved()
  }

  const z = nested ? 'z-[60]' : 'z-50'

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 ${z}`}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b">
          <h2 className="text-xl font-semibold">
            {mode === 'create' ? 'Новый контакт' : 'Изменить контакт'}
          </h2>
        </div>
        <div className="p-6 space-y-4">
          {lockedLegalEntityId ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Организация
              </label>
              <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded text-gray-700">
                {lockedLegalEntityName ?? '—'}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Организация *
              </label>
              <select
                value={form.legal_entity_id ?? ''}
                onChange={(e) =>
                  setForm({ ...form, legal_entity_id: e.target.value || null })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— выбрать —</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <Field
              label="Фамилия *"
              value={form.last_name}
              onChange={(v) => setForm({ ...form, last_name: v })}
              placeholder="Антипов"
            />
            <Field
              label="Имя *"
              value={form.first_name}
              onChange={(v) => setForm({ ...form, first_name: v })}
              placeholder="Артемий"
            />
            <Field
              label="Отчество"
              value={form.middle_name || ''}
              onChange={(v) => setForm({ ...form, middle_name: v })}
              placeholder="Юрьевич"
            />
          </div>

          <Field
            label="Должность"
            value={form.job_title || ''}
            onChange={(v) => setForm({ ...form, job_title: v })}
            placeholder="Руководитель проекта"
          />

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Email"
              value={form.email || ''}
              onChange={(v) => setForm({ ...form, email: v })}
              placeholder="ivan@example.com"
            />
            <Field
              label="Телефон"
              value={form.phone || ''}
              onChange={(v) => setForm({ ...form, phone: v })}
              placeholder="+7 (999) 000-00-00"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
              className="rounded"
            />
            Активен
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Заметки
            </label>
            <textarea
              value={form.notes || ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Любая дополнительная информация"
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div className="p-6 border-t bg-gray-50">
          {error && (
            <div className="p-3 mb-3 bg-red-50 text-red-700 border border-red-200 rounded text-sm">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
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
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}
