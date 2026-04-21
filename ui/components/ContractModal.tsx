'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

type ObjectRow = { code: string; current_name: string; contractor: string | null }

type Milestone = {
  milestone_name: string
  due_date: string
  responsible: string
  source: string
}

type Metadata = {
  date: string
  direction: string
  from_to: string
  method: string
  contract_type: string
  version: string
  title: string
  object_codes: string[]
  parties: string
  subject: string
  amount: string
}

type Step = 'upload' | 'analyzing' | 'metadata' | 'verify' | 'saving'

const METHODS = ['ЭДО', 'Электронная_почта', 'Курьер', 'Скан', 'Факс', 'Лично', 'Инициализация']
const CONTRACT_TYPES = ['Договор', 'ДС', 'Акт']

const EMPTY_META: Metadata = {
  date: '', direction: 'incoming', from_to: '', method: 'Скан',
  contract_type: 'Договор', version: 'v1', title: '',
  object_codes: [], parties: '', subject: '', amount: '',
}

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  open: boolean
  onClose: () => void
  onCreated?: () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ContractModal({ open, onClose, onCreated }: Props) {
  const [step, setStep]           = useState<Step>('upload')
  const [files, setFiles]         = useState<File[]>([])
  const [fileUrls, setFileUrls]   = useState<string[]>([])
  const [activeFile, setActiveFile] = useState(0)
  const [meta, setMeta]           = useState<Metadata>(EMPTY_META)
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [objects, setObjects]     = useState<ObjectRow[]>([])
  const [extractedText, setExtractedText] = useState('')
  const [hint, setHint]           = useState('')
  const [rereadLoading, setRereadLoading] = useState(false)
  const [error, setError]         = useState('')
  const dropRef = useRef<HTMLDivElement>(null)

  // Load objects once when opened
  useEffect(() => {
    if (!open) return
    reset()
    supabase.from('objects').select('code,current_name,contractor').eq('active', true).order('code').then(({ data }) => {
      setObjects(data ?? [])
    })
  }, [open])

  // Cleanup object URLs on close
  useEffect(() => {
    if (!open) fileUrls.forEach(u => URL.revokeObjectURL(u))
  }, [open])

  function reset() {
    setStep('upload')
    setFiles([])
    setFileUrls([])
    setActiveFile(0)
    setMeta(EMPTY_META)
    setMilestones([])
    setExtractedText('')
    setHint('')
    setError('')
  }

  if (!open) return null

  // ─── File handling ─────────────────────────────────────────────────────────

  function addFiles(incoming: File[]) {
    const pdfs = incoming.filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'))
    setFiles(prev => {
      const merged = [...prev]
      pdfs.forEach(f => { if (!merged.find(e => e.name === f.name)) merged.push(f) })
      return merged
    })
  }

  function removeFile(i: number) {
    setFiles(prev => prev.filter((_, idx) => idx !== i))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    addFiles(Array.from(e.dataTransfer.files))
  }

  // ─── Analyze ───────────────────────────────────────────────────────────────

  async function handleAnalyze() {
    if (!files.length) { setError('Добавьте хотя бы один файл'); return }
    setError('')
    setStep('analyzing')

    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      fd.append('objects', JSON.stringify(objects))

      const res = await fetch('/api/contracts/analyze', { method: 'POST', body: fd })
      const data = await res.json()

      if (data.error) throw new Error(data.error)

      // Build object URLs for PDF preview
      const urls = files.map(f => URL.createObjectURL(f))
      setFileUrls(urls)
      setActiveFile(0)

      // Keep raw text for re-read
      setExtractedText(data._text ?? '')

      // Fill metadata
      setMeta({
        date:          data.date ?? '',
        direction:     data.direction ?? 'incoming',
        from_to:       data.from_to ?? '',
        method:        data.method ?? 'Скан',
        contract_type: data.contract_type ?? 'Договор',
        version:       data.version ?? 'v1',
        title:         data.title ?? '',
        object_codes:  data.object_codes ?? [],
        parties:       data.parties ?? '',
        subject:       data.subject ?? '',
        amount:        data.amount ?? '',
      })

      setMilestones(data.milestones ?? [])
      setStep('metadata')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка анализа')
      setStep('upload')
    }
  }

  // ─── Re-read milestones ────────────────────────────────────────────────────

  async function handleReread() {
    if (!hint.trim()) return
    setRereadLoading(true)
    try {
      const res = await fetch('/api/contracts/reread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: extractedText, current_milestones: milestones, hint }),
      })
      const data = await res.json()
      if (data.milestones) setMilestones(data.milestones)
      setHint('')
    } catch {
      // keep existing milestones
    } finally {
      setRereadLoading(false)
    }
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    setError('')
    setStep('saving')
    try {
      const res = await fetch('/api/contracts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: meta, milestones }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      onCreated?.()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
      setStep('verify')
    }
  }

  // ─── Milestone helpers ─────────────────────────────────────────────────────

  function updateMilestone(i: number, field: keyof Milestone, value: string) {
    setMilestones(prev => prev.map((m, idx) => idx === i ? { ...m, [field]: value } : m))
  }

  function addMilestone() {
    setMilestones(prev => [...prev, { milestone_name: '', due_date: '', responsible: '', source: '' }])
  }

  function removeMilestone(i: number) {
    setMilestones(prev => prev.filter((_, idx) => idx !== i))
  }

  function toggleObjectCode(code: string) {
    setMeta(m => ({
      ...m,
      object_codes: m.object_codes.includes(code)
        ? m.object_codes.filter(c => c !== code)
        : [...m.object_codes, code],
    }))
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const isVerify = step === 'verify'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className={`bg-white rounded-xl shadow-2xl w-full flex flex-col transition-all duration-200 ${
        isVerify ? 'max-w-7xl h-[92vh]' : 'max-w-lg max-h-[90vh] overflow-y-auto'
      } p-6`}>

        {/* Header */}
        <div className="flex items-center justify-between mb-5 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {step === 'upload'    && 'Новый договор'}
              {step === 'analyzing' && 'Анализ документов…'}
              {step === 'metadata'  && 'Проверьте метаданные'}
              {step === 'verify'    && 'Проверка этапов'}
              {step === 'saving'    && 'Сохранение…'}
            </h2>
            {step !== 'upload' && step !== 'analyzing' && (
              <div className="flex gap-1.5 mt-1">
                {[0, 1, 2].map(i => (
                  <div key={i} className={`h-1.5 rounded-full transition-all ${
                    (step === 'metadata' && i === 1) || ((step === 'verify' || step === 'saving') && i === 2)
                      ? 'w-8 bg-blue-500'
                      : 'w-4 bg-gray-300'
                  }`} />
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl shrink-0">✕</button>
        </div>

        {/* ── Step 1: Upload ─────────────────────────────────────────────── */}
        {step === 'upload' && (
          <div className="space-y-4">
            <div
              ref={dropRef}
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer"
              onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.pdf'; i.multiple = true; i.onchange = e => addFiles(Array.from((e.target as HTMLInputElement).files ?? [])); i.click() }}
            >
              <div className="text-3xl mb-2">📄</div>
              <p className="text-sm font-medium text-gray-700">Перетащите PDF или нажмите для выбора</p>
              <p className="text-xs text-gray-400 mt-1">Несколько файлов — загружайте весь пакет (договор + приложения + ДС)</p>
            </div>

            {files.length > 0 && (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="text-gray-400 text-xs">PDF</span>
                    <span className="flex-1 text-gray-700 truncate">{f.name}</span>
                    <span className="text-gray-400 text-xs">{(f.size / 1024).toFixed(0)} KB</span>
                    <button onClick={() => removeFile(i)} className="text-gray-300 hover:text-red-400">×</button>
                  </div>
                ))}
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex justify-end gap-3 pt-1">
              <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Отмена</button>
              <button
                onClick={handleAnalyze}
                disabled={!files.length}
                className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
              >
                Распознать и заполнить
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Analyzing ──────────────────────────────────────────── */}
        {step === 'analyzing' && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <p className="text-sm text-gray-600">Распознаём документы и извлекаем данные…</p>
            <div className="text-xs text-gray-400 space-y-1 text-center">
              {files.map((f, i) => <p key={i}>{f.name}</p>)}
            </div>
          </div>
        )}

        {/* ── Step 3: Metadata form ──────────────────────────────────────── */}
        {step === 'metadata' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Дата документа *</label>
                <input type="date" value={meta.date}
                  onChange={e => setMeta(m => ({ ...m, date: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Направление</label>
                <select value={meta.direction}
                  onChange={e => setMeta(m => ({ ...m, direction: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
                  <option value="incoming">Входящий</option>
                  <option value="outgoing">Исходящий</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Контрагент *</label>
                <input value={meta.from_to} placeholder="ХГ / МЛА+"
                  onChange={e => setMeta(m => ({ ...m, from_to: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Метод получения</label>
                <select value={meta.method}
                  onChange={e => setMeta(m => ({ ...m, method: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
                  {METHODS.map(x => <option key={x} value={x}>{x.replaceAll('_', ' ')}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Тип</label>
                <select value={meta.contract_type}
                  onChange={e => setMeta(m => ({ ...m, contract_type: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
                  {CONTRACT_TYPES.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Версия</label>
                <input value={meta.version} placeholder="v1 / ДС1"
                  onChange={e => setMeta(m => ({ ...m, version: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div className="col-span-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">Название *</label>
                <input value={meta.title} placeholder="Договор ХГ-2026-003"
                  onChange={e => setMeta(m => ({ ...m, title: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
            </div>

            {/* Summary fields */}
            {(meta.parties || meta.subject || meta.amount) && (
              <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs space-y-1 text-gray-600">
                {meta.parties && <p><span className="font-medium">Стороны:</span> {meta.parties}</p>}
                {meta.subject && <p><span className="font-medium">Предмет:</span> {meta.subject}</p>}
                {meta.amount  && <p><span className="font-medium">Сумма:</span> {meta.amount}</p>}
              </div>
            )}

            {/* Object chips */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Объекты</label>
              <div className="flex flex-wrap gap-2">
                {objects.map(obj => (
                  <button key={obj.code} type="button" onClick={() => toggleObjectCode(obj.code)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                      meta.object_codes.includes(obj.code)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                    }`}>
                    {obj.code}{obj.contractor ? ` (${obj.contractor})` : ''}
                  </button>
                ))}
              </div>
            </div>

            {/* Files list (read-only reminder) */}
            <div className="text-xs text-gray-400">
              Файлы: {files.map(f => f.name).join(', ')}
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex justify-between pt-2">
              <button onClick={() => setStep('upload')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-800">
                ← Назад
              </button>
              <button
                onClick={() => { if (!meta.date || !meta.from_to || !meta.title) { setError('Заполните обязательные поля'); return } setError(''); setStep('verify') }}
                className="px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
              >
                Подтвердить метаданные →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Verify (split screen) ─────────────────────────────── */}
        {(step === 'verify' || step === 'saving') && (
          <div className="flex gap-0 flex-1 min-h-0 -mx-6 -mb-6 mt-0">

            {/* Left: PDF viewer */}
            <div className="w-1/2 flex flex-col border-r border-gray-200">
              {/* File tabs */}
              {files.length > 1 && (
                <div className="flex gap-1 px-4 py-2 border-b border-gray-100 overflow-x-auto shrink-0">
                  {files.map((f, i) => (
                    <button key={i} onClick={() => setActiveFile(i)}
                      className={`px-3 py-1 rounded text-xs whitespace-nowrap transition ${
                        activeFile === i ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                      }`}>
                      {f.name.length > 25 ? f.name.slice(0, 22) + '…' : f.name}
                    </button>
                  ))}
                </div>
              )}
              {/* PDF iframe */}
              <div className="flex-1 min-h-0">
                {fileUrls[activeFile] ? (
                  <iframe
                    src={fileUrls[activeFile]}
                    className="w-full h-full"
                    title={files[activeFile]?.name}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                    Нет предпросмотра
                  </div>
                )}
              </div>
            </div>

            {/* Right: milestones + confirm */}
            <div className="w-1/2 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

                {/* Summary */}
                <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs space-y-1 text-gray-600">
                  <p className="font-semibold text-gray-800 text-sm">{meta.title} {meta.version}</p>
                  {meta.parties && <p><span className="font-medium">Стороны:</span> {meta.parties}</p>}
                  {meta.subject && <p><span className="font-medium">Предмет:</span> {meta.subject}</p>}
                  {meta.amount  && <p><span className="font-medium">Сумма:</span> {meta.amount}</p>}
                  <p><span className="font-medium">Объекты:</span> {meta.object_codes.join(', ') || '—'}</p>
                </div>

                {/* Milestones table */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Этапы и сроки</p>
                    <button onClick={addMilestone}
                      className="text-xs text-blue-600 hover:underline">+ этап</button>
                  </div>

                  {milestones.length === 0 ? (
                    <p className="text-sm text-gray-400 py-2">Этапы не найдены. Добавьте вручную или используйте подсказку LLM.</p>
                  ) : (
                    <div className="space-y-2">
                      {milestones.map((m, i) => (
                        <div key={i} className="border border-gray-200 rounded-lg p-3 text-xs space-y-2">
                          <div className="flex gap-2">
                            <input value={m.milestone_name} placeholder="Название этапа"
                              onChange={e => updateMilestone(i, 'milestone_name', e.target.value)}
                              className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            <button onClick={() => removeMilestone(i)} className="text-gray-300 hover:text-red-400 px-1">×</button>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <span className="block text-gray-400 mb-0.5">Срок</span>
                              <input type="date" value={m.due_date}
                                onChange={e => updateMilestone(i, 'due_date', e.target.value)}
                                className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            </div>
                            <div>
                              <span className="block text-gray-400 mb-0.5">Ответственный</span>
                              <input value={m.responsible} placeholder="ХГ"
                                onChange={e => updateMilestone(i, 'responsible', e.target.value)}
                                className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            </div>
                            <div>
                              <span className="block text-gray-400 mb-0.5">Источник</span>
                              <input value={m.source} placeholder="Приложение №3"
                                onChange={e => updateMilestone(i, 'source', e.target.value)}
                                className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* LLM re-read */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Подсказка LLM</p>
                  <div className="flex gap-2">
                    <input value={hint} placeholder="Пропущен этап, этапы в ДС-1…"
                      onChange={e => setHint(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleReread() } }}
                      className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400" />
                    <button onClick={handleReread} disabled={rereadLoading || !hint.trim()}
                      className="px-3 py-2 text-xs font-medium border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                      {rereadLoading ? '…' : 'Перечитать'}
                    </button>
                  </div>
                </div>

                {error && <p className="text-sm text-red-500">{error}</p>}
              </div>

              {/* Footer */}
              <div className="shrink-0 border-t border-gray-100 px-6 py-4 flex justify-between items-center">
                <button onClick={() => setStep('metadata')} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-800">
                  ← Метаданные
                </button>
                <button
                  onClick={handleSave}
                  disabled={step === 'saving'}
                  className="px-6 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50"
                >
                  {step === 'saving' ? 'Сохранение…' : 'Подтвердить и сохранить'}
                </button>
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  )
}
