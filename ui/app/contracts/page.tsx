'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/lib/useRole'
import ObjectModal from '@/components/ObjectModal'

type ObjectRow = { code: string; current_name: string; contractor: string | null }

const METHODS = ['Электронная_почта', 'ЭДО', 'Курьер', 'Скан', 'Факс', 'Лично', 'Инициализация']
const CONTRACT_TYPES = ['Договор', 'ДС', 'Акт']

export default function ContractsPage() {
  const { isAdmin } = useRole()
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [objectModalOpen, setObjectModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    file: null as File | null,
    date: '',
    direction: 'incoming',
    from_to: '',
    method: 'ЭДО',
    contract_type: 'Договор',
    version: 'v1',
    title: '',
    object_codes: [] as string[],
  })

  async function loadObjects() {
    const { data } = await supabase.from('objects').select('code,current_name,contractor').order('code')
    setObjects(data ?? [])
  }

  useEffect(() => { loadObjects() }, [])

  function toggleObject(code: string) {
    setForm(f => ({
      ...f,
      object_codes: f.object_codes.includes(code)
        ? f.object_codes.filter(c => c !== code)
        : [...f.object_codes, code],
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!form.file || !form.date || !form.from_to || !form.title) {
      setError('Заполните обязательные поля и прикрепите файл')
      return
    }
    setSaving(true)
    try {
      const dateSlug = form.date.replaceAll('-', '_')
      const titleSlug = form.title.replaceAll(' ', '_')
      const letterFolder = `ВХОДЯЩИЕ\\${dateSlug}_${form.from_to}_Договор__${form.method}`
      const docFolder = `ДОГОВОРА\\${dateSlug}_${titleSlug}_${form.version}__${form.method}`

      const { data: letter, error: lErr } = await supabase
        .from('letters')
        .insert({ date: form.date, direction: form.direction, from_to: form.from_to, method: form.method, folder_path: letterFolder })
        .select('id')
        .single()
      if (lErr) throw lErr

      const { error: dErr } = await supabase.from('documents').insert({
        letter_id: letter.id,
        object_codes: form.object_codes,
        type: 'ДОГОВОРА',
        title: form.title,
        version: form.version,
        folder_path: docFolder,
      })
      if (dErr) throw dErr

      setDone(true)
      setForm({ file: null, date: '', direction: 'incoming', from_to: '', method: 'ЭДО', contract_type: 'Договор', version: 'v1', title: '', object_codes: [] })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  if (done) return (
    <div className="max-w-lg">
      <div className="p-6 bg-green-50 border border-green-200 rounded-lg text-center">
        <p className="text-green-700 font-medium">Договор зарегистрирован ✓</p>
        <button onClick={() => setDone(false)} className="mt-4 text-sm text-blue-600 hover:underline">
          Загрузить ещё
        </button>
      </div>
    </div>
  )

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Загрузка договора</h1>

      <form onSubmit={handleSubmit} className="space-y-5 bg-white border border-gray-200 rounded-lg p-6">

        {/* Файл */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Файл PDF *</label>
          <input
            type="file"
            accept=".pdf"
            onChange={e => setForm(f => ({ ...f, file: e.target.files?.[0] ?? null }))}
            className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>

        {/* Дата и направление */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Дата документа *</label>
            <input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Направление</label>
            <select
              value={form.direction}
              onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="incoming">Входящий</option>
              <option value="outgoing">Исходящий</option>
            </select>
          </div>
        </div>

        {/* Контрагент и метод */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Контрагент *</label>
            <input
              value={form.from_to}
              onChange={e => setForm(f => ({ ...f, from_to: e.target.value }))}
              placeholder="ХГ / МЛА+"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Метод получения</label>
            <select
              value={form.method}
              onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {METHODS.map(m => <option key={m} value={m}>{m.replaceAll('_', ' ')}</option>)}
            </select>
          </div>
        </div>

        {/* Тип, версия, название */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Тип</label>
            <select
              value={form.contract_type}
              onChange={e => setForm(f => ({ ...f, contract_type: e.target.value }))}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {CONTRACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Версия</label>
            <input
              value={form.version}
              onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
              placeholder="v1 / ДС1"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div className="col-span-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Название *</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Договор ХГ-2026-003"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
        </div>

        {/* Объекты */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-gray-600">Объекты</label>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setObjectModalOpen(true)}
                className="text-xs text-blue-600 hover:underline"
              >
                + Создать объект
              </button>
            )}
          </div>
          {objects.length === 0 ? (
            <p className="text-sm text-gray-400">Нет объектов. Создайте первый.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {objects.map(obj => (
                <button
                  key={obj.code}
                  type="button"
                  onClick={() => toggleObject(obj.code)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                    form.object_codes.includes(obj.code)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                  }`}
                >
                  {obj.code} {obj.contractor ? `(${obj.contractor})` : ''}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Сохранение…' : 'Зарегистрировать договор'}
          </button>
        </div>
      </form>

      <ObjectModal
        open={objectModalOpen}
        onClose={() => setObjectModalOpen(false)}
        onCreated={() => { loadObjects() }}
      />
    </div>
  )
}
