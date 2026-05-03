'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type LegalEntity = {
  id: string
  name: string
  inn: string
  kpp: string | null
  ogrn: string | null
  address: string | null
  signatory_name: string | null
  signatory_position: string | null
  created_at: string
  updated_at: string
  tasks_count?: number
}

const EMPTY: Omit<LegalEntity, 'id' | 'created_at' | 'updated_at'> = {
  name: '',
  inn: '',
  kpp: '',
  ogrn: '',
  address: '',
  signatory_name: '',
  signatory_position: '',
}

export default function LegalEntitiesPage() {
  const [items, setItems] = useState<LegalEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<LegalEntity | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    setError('')
    // Подгружаем юр.лица + количество связанных задач (через подзапрос)
    const { data, error: e1 } = await supabase
      .from('legal_entities')
      .select('*')
      .order('name')
    if (e1) {
      setError(e1.message)
      setLoading(false)
      return
    }
    // Подсчёт задач — через RPC или отдельный count-запрос на каждый id
    const withCounts = await Promise.all(
      (data || []).map(async (le) => {
        const { count } = await supabase
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('assignee_entity_id', le.id)
        return { ...le, tasks_count: count ?? 0 }
      })
    )
    setItems(withCounts)
    setLoading(false)
  }

  function openCreate() {
    setForm(EMPTY)
    setEditing(null)
    setCreating(true)
  }

  function openEdit(item: LegalEntity) {
    setForm({
      name: item.name,
      inn: item.inn,
      kpp: item.kpp ?? '',
      ogrn: item.ogrn ?? '',
      address: item.address ?? '',
      signatory_name: item.signatory_name ?? '',
      signatory_position: item.signatory_position ?? '',
    })
    setEditing(item)
    setCreating(false)
  }

  function close() {
    setEditing(null)
    setCreating(false)
    setForm(EMPTY)
    setError('')
  }

  async function save() {
    setSaving(true)
    setError('')
    const payload = {
      name: form.name.trim(),
      inn: form.inn.trim(),
      kpp: form.kpp?.trim() || null,
      ogrn: form.ogrn?.trim() || null,
      address: form.address?.trim() || null,
      signatory_name: form.signatory_name?.trim() || null,
      signatory_position: form.signatory_position?.trim() || null,
    }
    if (!payload.name || !payload.inn) {
      setError('Поля «Название» и «ИНН» обязательны')
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
    load()
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
                <th className="px-4 py-3">КПП</th>
                <th className="px-4 py-3">Адрес</th>
                <th className="px-4 py-3">Подписант</th>
                <th className="px-4 py-3 text-center">Задач</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{it.name}</td>
                  <td className="px-4 py-3 font-mono text-gray-700">{it.inn}</td>
                  <td className="px-4 py-3 text-gray-600">{it.kpp || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-xs truncate">
                    {it.address || '—'}
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
              />
              <Field
                label="ИНН *"
                value={form.inn}
                onChange={(v) => setForm({ ...form, inn: v })}
                placeholder="10–12 цифр"
                hint="Уникален. При совпадении с существующим ИНН — будет ошибка"
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
