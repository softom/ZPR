'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type ObjectRow = {
  id: string
  code: string
  current_name: string
  contractor: string | null
  aliases: string[]
  active: boolean
}

type RelatedDoc = {
  id: string
  title: string
  type: string
  version: string | null
}

type Contractor = { code: string; full_name: string | null }

type Props = {
  open: boolean
  object?: ObjectRow | null       // null/undefined = режим создания
  onClose: () => void
  onCreated?: (code: string) => void
  onSaved?: () => void
}

const OBJECT_TYPES = ['ГОСТИНИЦА', 'АПАРТ', 'SELECT', 'ДПТ', 'ИНФРА', 'ПЕРСОНАЛ']

export default function ObjectModal({ open, object: obj, onClose, onCreated, onSaved }: Props) {
  const isEdit = !!obj

  const [contractors, setContractors] = useState<Contractor[]>([])
  const [form, setForm] = useState({ code: '', type: '', capacity: '', current_name: '', contractor: '' })
  const [aliases, setAliases] = useState<string[]>([])
  const [aliasInput, setAliasInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [relatedDocs, setRelatedDocs] = useState<RelatedDoc[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)

  useEffect(() => {
    if (!open) return
    supabase.from('contractors').select('code,full_name').order('code').then(({ data }) => {
      setContractors(data ?? [])
    })
    if (obj) {
      setForm({ code: obj.code, type: '', capacity: '', current_name: obj.current_name, contractor: obj.contractor ?? '' })
      setAliases(obj.aliases ?? [])
    } else {
      setForm({ code: '', type: '', capacity: '', current_name: '', contractor: '' })
      setAliases([])
    }
    setAliasInput('')
    setError('')
    setConfirmDeactivate(false)
    setRelatedDocs([])
  }, [open, obj])

  if (!open) return null

  const folderCode = !isEdit && form.code && form.type && form.capacity
    ? `${form.code}_${form.type}_${form.capacity}`
    : ''

  function addAlias() {
    const v = aliasInput.trim()
    if (v && !aliases.includes(v)) setAliases(a => [...a, v])
    setAliasInput('')
  }

  function handleAliasKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); addAlias() }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (isEdit) {
      if (!form.current_name.trim()) { setError('Название обязательно'); return }
      setSaving(true)
      try {
        const { error: err } = await supabase.from('objects').update({
          current_name: form.current_name.trim(),
          contractor: form.contractor || null,
          aliases,
        }).eq('id', obj!.id)
        if (err) throw err

        const { data: storageFolder } = await supabase
          .from('folders')
          .select('folder_name')
          .eq('entity_type', 'object')
          .eq('entity_code', obj!.code)
          .eq('storage', 'хранилище')
          .single()

        const folderBase = storageFolder?.folder_name ?? obj!.code
        const newObsidianName = form.contractor ? `${folderBase}_(${form.contractor})` : folderBase

        await supabase.from('folders').update({ folder_name: newObsidianName })
          .eq('entity_type', 'object').eq('entity_code', obj!.code).eq('storage', 'obsidian')

        onSaved?.()
        onClose()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Ошибка сохранения')
      } finally {
        setSaving(false)
      }
    } else {
      if (!form.code || !form.type || !form.capacity || !form.current_name) {
        setError('Заполните обязательные поля')
        return
      }
      setSaving(true)
      try {
        const { error: objErr } = await supabase.from('objects').insert({
          code: folderCode,   // полный код: NNN_ТИП_ЁМКОСТЬ
          current_name: form.current_name,
          contractor: form.contractor || null,
          aliases,
        })
        if (objErr) throw objErr

        const { error: fldErr } = await supabase.from('folders').insert([
          { entity_type: 'object', entity_code: folderCode, storage: 'хранилище', folder_name: folderCode },
          { entity_type: 'object', entity_code: folderCode, storage: 'obsidian',
            folder_name: form.contractor ? `${folderCode}_(${form.contractor})` : folderCode },
        ])
        if (fldErr) throw fldErr

        onCreated?.(form.code)
        onClose()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Ошибка сохранения')
      } finally {
        setSaving(false)
      }
    }
  }

  async function handleDeactivateClick() {
    setLoadingDocs(true)
    const { data } = await supabase.from('documents').select('id,title,type,version')
      .contains('object_codes', JSON.stringify([obj!.code]))
    setRelatedDocs(data ?? [])
    setLoadingDocs(false)
    setConfirmDeactivate(true)
  }

  async function handleConfirmDeactivate() {
    setSaving(true)
    try {
      const { error: err } = await supabase.from('objects').update({ active: false }).eq('id', obj!.id)
      if (err) throw err
      onSaved?.()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">

        {!confirmDeactivate ? (
          <>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-semibold">
                  {isEdit ? `Объект ${obj!.code}` : 'Новый объект'}
                </h2>
                {isEdit && !obj!.active && (
                  <span className="text-xs text-red-500 font-medium">Деактивирован</span>
                )}
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {isEdit ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Код объекта</label>
                  <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
                    <span className="font-mono text-gray-900 text-sm">{obj!.code}</span>
                    <span className="text-xs text-gray-400 ml-auto">неизменяемый</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Номер участка *</label>
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
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Код объекта (генерируется)</label>
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
                      <span className="font-mono text-sm text-gray-700">
                        {folderCode || <span className="text-gray-300">006_ГОСТИНИЦА_400</span>}
                      </span>
                      <span className="text-xs text-gray-400 ml-auto">станет неизменяемым</span>
                    </div>
                  </div>
                </>
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
                <label className="block text-xs font-medium text-gray-600 mb-1">Публичные имена</label>
                <div className="flex gap-2">
                  <input
                    value={aliasInput}
                    onChange={e => setAliasInput(e.target.value)}
                    onKeyDown={handleAliasKeyDown}
                    placeholder="Введите имя и нажмите Enter"
                    className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                  <button type="button" onClick={addAlias}
                    className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50">+</button>
                </div>
                {aliases.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {aliases.map(alias => (
                      <span key={alias} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700 border border-gray-200">
                        {alias}
                        <button type="button" onClick={() => setAliases(a => a.filter(x => x !== alias))}
                          className="text-gray-400 hover:text-gray-600 leading-none">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Подрядчик</label>
                <select
                  value={form.contractor}
                  onChange={e => setForm(f => ({ ...f, contractor: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">— не указан —</option>
                  {contractors.map(c => (
                    <option key={c.code} value={c.code}>
                      {c.code}{c.full_name ? ` — ${c.full_name}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {error && <p className="text-sm text-red-500">{error}</p>}

              <div className="flex items-center justify-between pt-2">
                {isEdit ? (
                  <button type="button" onClick={handleDeactivateClick}
                    disabled={!obj!.active || loadingDocs}
                    className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-40">
                    {loadingDocs ? 'Проверка…' : 'Деактивировать'}
                  </button>
                ) : <div />}
                <div className="flex gap-3">
                  <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                    Отмена
                  </button>
                  <button type="submit" disabled={saving}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                    {saving ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать объект'}
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Деактивировать {obj!.code}?</h2>
              <button onClick={() => setConfirmDeactivate(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Объект будет помечен как неактивный и скрыт из списков. Из базы данных не удаляется.
            </p>
            {relatedDocs.length > 0 ? (
              <>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Связанные документы ({relatedDocs.length})
                </p>
                <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100 mb-4">
                  {relatedDocs.map(doc => (
                    <div key={doc.id} className="px-3 py-2 text-sm">
                      <span className="text-gray-900">{doc.title}</span>
                      <span className="ml-2 text-xs text-gray-400">{doc.type} {doc.version ?? ''}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mb-4">Документы останутся в базе данных.</p>
              </>
            ) : (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2 mb-4">
                Связанных документов нет.
              </p>
            )}
            {error && <p className="text-sm text-red-500 mb-3">{error}</p>}
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setConfirmDeactivate(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Отмена</button>
              <button onClick={handleConfirmDeactivate} disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50">
                {saving ? 'Деактивация…' : 'Деактивировать'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
