'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

type Props = {
  open: boolean
  onClose: () => void
  onCreated?: (code: string) => void
}

const OBJECT_TYPES = ['ГОСТИНИЦА', 'АПАРТ', 'SELECT', 'ДПТ', 'ИНФРА', 'ПЕРСОНАЛ']
const CONTRACTORS = ['ХГ', '8D', 'МЛА+', 'Б82', 'Акулова', 'Космос']

export default function ObjectModal({ open, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    code: '',
    type: '',
    capacity: '',
    current_name: '',
    contractor: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  const folderCode = form.code && form.type && form.capacity
    ? `${form.code}_${form.type}_${form.capacity}`
    : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!form.code || !form.type || !form.capacity || !form.current_name) {
      setError('Заполните обязательные поля')
      return
    }
    setSaving(true)
    try {
      const { error: objErr } = await supabase.from('objects').insert({
        code: form.code,
        current_name: form.current_name,
        contractor: form.contractor || null,
        aliases: [],
      })
      if (objErr) throw objErr

      const folderRows = [
        { entity_type: 'object', entity_code: form.code, storage: 'хранилище', folder_name: folderCode },
        {
          entity_type: 'object',
          entity_code: form.code,
          storage: 'obsidian',
          folder_name: form.contractor ? `${folderCode}_(${form.contractor})` : folderCode,
        },
      ]
      const { error: fldErr } = await supabase.from('folders').insert(folderRows)
      if (fldErr) throw fldErr

      onCreated?.(form.code)
      onClose()
      setForm({ code: '', type: '', capacity: '', current_name: '', contractor: '' })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Новый объект</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Код *</label>
              <input
                value={form.code}
                onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="006"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Тип *</label>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">—</option>
                {OBJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Ёмкость *</label>
              <input
                value={form.capacity}
                onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
                placeholder="400"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          </div>

          {folderCode && (
            <p className="text-xs text-gray-400">
              Папка в хранилище: <span className="font-mono text-gray-600">{folderCode}</span>
            </p>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Официальное название *</label>
            <input
              value={form.current_name}
              onChange={e => setForm(f => ({ ...f, current_name: e.target.value }))}
              placeholder="Отель 5★ Health"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Подрядчик</label>
            <select
              value={form.contractor}
              onChange={e => setForm(f => ({ ...f, contractor: e.target.value }))}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="">— не указан —</option>
              {CONTRACTORS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Сохранение…' : 'Создать объект'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
