'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import PlotsTab from './PlotsTab'
import EngineeringLoadsTab from './EngineeringLoadsTab'

type TabId = 'main' | 'plots' | 'loads'

type ObjectRow = {
  id: string
  code: string
  current_name: string
  contractor: string | null
  aliases: string[]
  active: boolean
  color: string | null
  icon: string | null
  icon_small: string | null
}

type RelatedDoc = {
  id: string
  title: string
  type: string
  version: string | null
}

type Contractor = { code: string; full_name: string | null }

type TgChat = {
  chat_id: number
  title: string | null
  username: string | null
  kind: string | null
  object_id: string | null
}

type Props = {
  open: boolean
  object?: ObjectRow | null       // null/undefined = режим создания
  onClose: () => void
  onCreated?: (code: string) => void
  onSaved?: () => void
}

const OBJECT_TYPES = ['ГОСТИНИЦА', 'АПАРТ', 'SELECT', 'ДПТ', 'ИНФРА', 'ПЕРСОНАЛ', 'МАСТЕРПЛАН']
// Типы, для которых ёмкость не имеет смысла (мастерплан / верхний проект).
// Код объекта генерируется без сегмента ёмкости: NNN_ТИП.
const TYPES_WITHOUT_CAPACITY = ['МАСТЕРПЛАН']

// Логотип объекта: либо эмодзи (1-4 символа), либо data-URL картинки.
// При загрузке файла / paste / drop генерируем ДВА варианта:
//   • icon (полный): 256×256 PNG — для крупных шапок, отчётов
//   • icon_small:    32×32  PNG — для чипов в списках (быстрая загрузка)
const LOGO_FULL_SIDE = 256
const LOGO_SMALL_SIDE = 32

function isImageLogo(s: string | null | undefined): boolean {
  if (!s) return false
  return s.startsWith('data:image/') || /^https?:\/\//.test(s)
}

async function fileToLogoVariants(file: File): Promise<{ full: string; small: string }> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(file)
  })
  const full = await resizeDataUrl(raw, LOGO_FULL_SIDE)
  const small = await resizeDataUrl(raw, LOGO_SMALL_SIDE)
  return { full, small }
}

async function resizeDataUrl(dataUrl: string, maxSide: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let w = img.width
      let h = img.height
      if (w > maxSide || h > maxSide) {
        const k = Math.min(maxSide / w, maxSide / h)
        w = Math.round(w * k)
        h = Math.round(h * k)
      }
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('Canvas 2D context недоступен'))
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('Не удалось загрузить изображение'))
    img.src = dataUrl
  })
}

export default function ObjectModal({ open, object: obj, onClose, onCreated, onSaved }: Props) {
  const isEdit = !!obj

  const [contractors, setContractors] = useState<Contractor[]>([])
  const [form, setForm] = useState({ code: '', type: '', capacity: '', current_name: '', contractor: '', color: '#64748b', icon: '', icon_small: '' })
  const [logoUploading, setLogoUploading] = useState(false)

  // Обработка вставки картинки из буфера обмена (Ctrl+V на модал)
  useEffect(() => {
    if (!open) return
    const handler = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            setLogoUploading(true)
            try {
              const { full, small } = await fileToLogoVariants(file)
              setForm(f => ({ ...f, icon: full, icon_small: small }))
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Не удалось вставить картинку')
            } finally {
              setLogoUploading(false)
            }
            return
          }
        }
      }
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [open])

  async function handleLogoFile(file: File | null | undefined) {
    if (!file) return
    setLogoUploading(true)
    setError('')
    try {
      const { full, small } = await fileToLogoVariants(file)
      setForm(f => ({ ...f, icon: full, icon_small: small }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обработать файл')
    } finally {
      setLogoUploading(false)
    }
  }
  const [aliases, setAliases] = useState<string[]>([])
  const [aliasInput, setAliasInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)
  const [relatedDocs, setRelatedDocs] = useState<RelatedDoc[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  // Telegram-чаты: доступны только в edit (на момент создания id ещё нет).
  const [tgChats, setTgChats] = useState<TgChat[]>([])
  const [selectedTgChat, setSelectedTgChat] = useState<number | ''>('')
  const [initialTgChat, setInitialTgChat] = useState<number | null>(null)
  // Активная вкладка. «plots» доступна только в edit-режиме (нужен obj.id).
  const [tab, setTab] = useState<TabId>('main')

  useEffect(() => {
    if (!open) return
    supabase.from('contractors').select('code,full_name').order('code').then(({ data }) => {
      setContractors(data ?? [])
    })
    if (obj) {
      setForm({
        code: obj.code,
        type: '',
        capacity: '',
        current_name: obj.current_name,
        contractor: obj.contractor ?? '',
        color: obj.color ?? '#64748b',
        icon: obj.icon ?? '',
        icon_small: obj.icon_small ?? '',
      })
      setAliases(obj.aliases ?? [])
    } else {
      setForm({ code: '', type: '', capacity: '', current_name: '', contractor: '', color: '#64748b', icon: '', icon_small: '' })
      setAliases([])
    }
    setAliasInput('')
    setError('')
    setConfirmDeactivate(false)
    setRelatedDocs([])
    setTgChats([])
    setSelectedTgChat('')
    setInitialTgChat(null)
    setTab('main') // при каждом открытии возвращаемся на основную вкладку

    // Telegram-чаты: только в edit. Доступны свободные (object_id=null) и
    // уже привязанные к этому объекту.
    if (obj) {
      ;(async () => {
        const { data } = await supabase
          .from('tg_chats')
          .select('chat_id,title,username,kind,object_id')
          .eq('is_whitelisted', true)
          .or(`object_id.is.null,object_id.eq.${obj.id}`)
          .order('title', { nullsFirst: false })
        const rows = (data ?? []) as TgChat[]
        setTgChats(rows)
        const linked = rows.find(c => c.object_id === obj.id)
        if (linked) {
          setSelectedTgChat(linked.chat_id)
          setInitialTgChat(linked.chat_id)
        } else {
          setSelectedTgChat('')
          setInitialTgChat(null)
        }
      })()
    }
  }, [open, obj])

  if (!open) return null

  const skipCapacity = TYPES_WITHOUT_CAPACITY.includes(form.type)
  const folderCode = !isEdit && form.code && form.type && (skipCapacity || form.capacity)
    ? (skipCapacity ? `${form.code}_${form.type}` : `${form.code}_${form.type}_${form.capacity}`)
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
          color: form.color || null,
          icon: form.icon.trim() || null,
          icon_small: form.icon_small || null,
        }).eq('id', obj!.id)
        if (err) throw err

        // Telegram-чат: синхронизируем привязку (один объект → один чат для MVP).
        const newTg = selectedTgChat === '' ? null : Number(selectedTgChat)
        if (newTg !== initialTgChat) {
          // Снять привязку у чата, который был привязан, но больше не выбран.
          if (initialTgChat !== null && initialTgChat !== newTg) {
            const { error: e1 } = await supabase
              .from('tg_chats')
              .update({ object_id: null })
              .eq('chat_id', initialTgChat)
            if (e1) throw e1
          }
          // Привязать новый чат к объекту.
          if (newTg !== null) {
            const { error: e2 } = await supabase
              .from('tg_chats')
              .update({ object_id: obj!.id })
              .eq('chat_id', newTg)
            if (e2) throw e2
          }
        }

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
      if (!form.code || !form.type || !form.current_name || (!skipCapacity && !form.capacity)) {
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
          color: form.color || null,
          icon: form.icon.trim() || null,
          icon_small: form.icon_small || null,
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

  // Вкладки «plots» и «loads» — широкие (карта / таблицы), основная — компактная.
  const modalWidthClass = tab === 'plots' || tab === 'loads' ? 'max-w-6xl' : 'max-w-md'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className={`bg-white rounded-xl shadow-xl w-full ${modalWidthClass} p-6 max-h-[95vh] overflow-y-auto`}>

        {!confirmDeactivate ? (
          <>
            <div className="flex items-start justify-between mb-4 gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
                  {isEdit ? `Объект ${obj!.code}` : 'Новый объект'}
                  {/* Привязанный Telegram-чат — заметная плашка возле названия */}
                  {isEdit && initialTgChat !== null && (() => {
                    const linked = tgChats.find(c => c.chat_id === initialTgChat)
                    if (!linked) return null
                    return (
                      <span
                        title={`Telegram chat_id ${linked.chat_id}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-100 text-sky-800 text-xs font-medium rounded"
                      >
                        💬 {linked.title ?? '(без названия)'}
                        {linked.username && <span className="text-sky-600">@{linked.username}</span>}
                      </span>
                    )
                  })()}
                </h2>
                {isEdit && !obj!.active && (
                  <span className="text-xs text-red-500 font-medium">Деактивирован</span>
                )}
              </div>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">✕</button>
            </div>

            {/* ─── Вкладки. Видны только в режиме редактирования (новому объекту
                 ещё нечего привязывать). ───────────────────────────────────── */}
            {isEdit && (
              <div className="flex gap-1 mb-4 border-b border-gray-200">
                <button
                  type="button"
                  onClick={() => setTab('main')}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === 'main'
                      ? 'border-blue-600 text-blue-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Основное
                </button>
                <button
                  type="button"
                  onClick={() => setTab('plots')}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === 'plots'
                      ? 'border-blue-600 text-blue-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                  title="Земельные участки и ОКС, привязанные к этому объекту"
                >
                  Участки и ОКС
                </button>
                <button
                  type="button"
                  onClick={() => setTab('loads')}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === 'loads'
                      ? 'border-blue-600 text-blue-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                  title="Расчётные нагрузки по инженерным сетям из Тома 2.2 ППТ"
                >
                  Нагрузки
                </button>
              </div>
            )}

            {/* Таб «Участки и ОКС» — отдельный компонент. Монтируется (и
                 размонтируется) при переключении вкладок, чтобы карта инициализировалась
                 чисто. Привязки применяются сразу через PATCH; кнопка «Сохранить» внизу
                 закрывает модалку и триггерит обновление родительского списка. */}
            {isEdit && tab === 'plots' && (
              <>
                <PlotsTab
                  ownerType="object"
                  ownerId={obj!.id}
                  ownerCode={obj!.code}
                  ownerColor={obj!.color}
                  active={true}
                />
                <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={() => { onSaved?.(); onClose() }}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
                  >
                    Сохранить
                  </button>
                </div>
              </>
            )}

            {/* Таб «Нагрузки» — read-only вид (плитки по сетям + сводная таблица). */}
            {isEdit && tab === 'loads' && (
              <>
                <EngineeringLoadsTab objectId={obj!.id} />
                <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
                  >
                    Закрыть
                  </button>
                </div>
              </>
            )}

            {/* Основная вкладка — существующая форма */}
            <form onSubmit={handleSubmit} className="space-y-4" style={tab === 'plots' || tab === 'loads' ? { display: 'none' } : undefined}>
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
                  <div className={`grid gap-3 ${skipCapacity ? 'grid-cols-2' : 'grid-cols-3'}`}>
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
                        onChange={e => setForm(f => ({ ...f, type: e.target.value, capacity: TYPES_WITHOUT_CAPACITY.includes(e.target.value) ? '' : f.capacity }))}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                      >
                        <option value="">—</option>
                        {OBJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    {!skipCapacity && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Ёмкость *</label>
                        <input
                          value={form.capacity}
                          onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
                          placeholder="400"
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Код объекта (генерируется)</label>
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
                      <span className="font-mono text-sm text-gray-700">
                        {folderCode || <span className="text-gray-300">{skipCapacity ? '001_МАСТЕРПЛАН' : '107_ГОСТИНИЦА_400'}</span>}
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

              {/* Telegram-чат — доступно только в режиме редактирования (нужен obj.id) */}
              {isEdit && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Telegram-чат
                    <span className="ml-1 text-gray-400 font-normal">
                      (из whitelist; общий список — `python telegram_listener.py --list-folders`)
                    </span>
                  </label>
                  {tgChats.length === 0 ? (
                    <p className="text-xs text-gray-400 italic px-3 py-2 bg-gray-50 border border-gray-200 rounded-md">
                      Нет доступных чатов. Все привязаны к другим объектам, либо whitelist пуст.
                    </p>
                  ) : (
                    <select
                      value={selectedTgChat === '' ? '' : String(selectedTgChat)}
                      onChange={e => setSelectedTgChat(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      <option value="">— не привязан —</option>
                      {tgChats.map(c => (
                        <option key={c.chat_id} value={String(c.chat_id)}>
                          {c.title ?? '(без названия)'}
                          {c.username ? ` @${c.username}` : ''}
                          {c.kind ? ` · ${c.kind}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Логотип + Цвет — маркеры объекта в фильтрах, чипах, календаре, отчётах */}
              <div className="grid grid-cols-[1fr_140px] gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Логотип
                  </label>

                  {/* Drag&Drop / file input / paste — все варианты в одной зоне */}
                  <div
                    onDragOver={(e) => { e.preventDefault() }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const file = e.dataTransfer.files?.[0]
                      if (file?.type.startsWith('image/')) void handleLogoFile(file)
                    }}
                    className="border-2 border-dashed border-gray-200 rounded-md p-2 bg-gray-50/50"
                  >
                    <div className="flex items-start gap-3">
                      {/* Превью: 128×128 для картинок (видно качество 256-полного), 64 для эмодзи */}
                      <div className={`${isImageLogo(form.icon) ? 'w-32 h-32' : 'w-16 h-16'} border border-gray-200 rounded bg-white flex items-center justify-center overflow-hidden shrink-0`}>
                        {logoUploading
                          ? <span className="text-xs text-gray-400">…</span>
                          : isImageLogo(form.icon)
                            ? <img src={form.icon} alt="logo" className="max-w-full max-h-full object-contain" />
                            : form.icon
                              ? <span className="text-4xl">{form.icon}</span>
                              : <span className="text-xs text-gray-300">пусто</span>
                        }
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <div className="flex flex-wrap gap-2 text-xs">
                          <label className="px-2 py-1 bg-white border border-gray-300 rounded cursor-pointer hover:bg-gray-50">
                            📎 Выбрать файл
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0]
                                if (f) void handleLogoFile(f)
                                e.currentTarget.value = ''
                              }}
                            />
                          </label>
                          <span className="text-gray-500 self-center">или Ctrl+V из буфера / drag&drop</span>
                          {form.icon && (
                            <button
                              type="button"
                              onClick={() => setForm(f => ({ ...f, icon: '', icon_small: '' }))}
                              className="px-2 py-1 text-red-600 hover:bg-red-50 rounded"
                            >
                              Очистить
                            </button>
                          )}
                        </div>
                        {/* Текстовое поле — для прямого ввода эмодзи или вставки текста */}
                        {!isImageLogo(form.icon) && (
                          <input
                            value={form.icon}
                            onChange={(e) => setForm(f => ({ ...f, icon: e.target.value, icon_small: '' }))}
                            placeholder="или эмодзи: 🏨"
                            className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        )}
                      </div>
                    </div>

                    {/* Палитра эмодзи — для быстрого выбора */}
                    {!isImageLogo(form.icon) && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {['🏨','🏢','🏠','🏖️','🌊','☀️','🌴','🚀','📋','👪','🩺','💚','🎉','🛏️','🍽️'].map(em => (
                          <button
                            key={em}
                            type="button"
                            onClick={() => setForm(f => ({ ...f, icon: em, icon_small: '' }))}
                            className="text-base w-7 h-7 border border-gray-200 rounded hover:bg-white"
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Цвет</label>
                  {/* Большой колор-пикер с цветным образцом и hex-подписью внизу */}
                  <label className="block cursor-pointer">
                    <div
                      className="w-full h-14 rounded-md border border-gray-300 shadow-inner"
                      style={{ backgroundColor: form.color }}
                      title="Кликнуть для выбора цвета"
                    />
                    <input
                      type="color"
                      value={form.color}
                      onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                      className="sr-only"
                    />
                    <div className="text-center text-[11px] font-mono text-gray-500 mt-1">
                      {form.color || '—'}
                    </div>
                  </label>
                </div>
              </div>

              {/* Preview как будет выглядеть чип */}
              {(form.icon || form.color) && (
                <div className="bg-gray-50 border border-gray-200 rounded-md p-2 flex items-center gap-2">
                  <span className="text-xs text-gray-500">Превью чипа:</span>
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-700 text-[11px] font-mono rounded whitespace-nowrap border-l-2"
                    style={{ borderLeftColor: form.color || '#cbd5e1' }}
                  >
                    {isImageLogo(form.icon)
                      ? <img src={form.icon} alt="" className="w-4 h-4 object-contain" />
                      : form.icon && <span aria-hidden>{form.icon}</span>}
                    {folderCode || form.code || '___'}
                  </span>
                </div>
              )}

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
