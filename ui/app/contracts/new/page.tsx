'use client'

/**
 * /contracts/new — мастер загрузки договора (модуль A).
 *
 * Шаги:
 *   1. Upload   — drag&drop файла, чтение текста pdfjs, autostart analyze.
 *   2. Analyze  — spinner, POST /api/contracts/v2/analyze.
 *   3. Verify   — три табы (Стороны, Объекты, Пункты), inline-правка.
 *   4. Confirm  — сводка, POST /save → POST /[id]/upload → редирект /[id].
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { extractTextFromPdf, type PdfText } from '@/lib/pdf/extract'
import type { ContractAnalysis, PartyInfo, ClauseInfo, ProjectStage, TermBase } from '@/lib/parser/extractClauses'
import { computeAllClauseDates, type ClauseDateResult } from '@/lib/contracts/computeClauseDates'
import {
  DndContext, type DragEndEvent, closestCenter,
  PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove,
  verticalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function newClauseId(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

type ClauseCategory = 'fin' | 'work' | 'appr' | 'legal'

const CATEGORY_OPTIONS: { value: ClauseCategory; label: string; short: string; badge: string }[] = [
  { value: 'fin',   short: 'ФИН',  label: 'Финансовый',       badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { value: 'work',  short: 'РАБ',  label: 'Производственный', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'appr',  short: 'СОГЛ', label: 'Согласование',     badge: 'bg-violet-100 text-violet-700 border-violet-200' },
  { value: 'legal', short: 'ЮР',   label: 'Юридический',      badge: 'bg-amber-100 text-amber-700 border-amber-200' },
]
const CATEGORY_BADGE_CLASS: Record<ClauseCategory, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map(o => [o.value, o.badge])
) as Record<ClauseCategory, string>

type Step = 'upload' | 'analyze' | 'verify' | 'confirm'
type VerifyTab = 'parties' | 'objects' | 'clauses'

interface ObjectOption {
  code: string
  current_name: string
  contractor: string | null
  aliases: string[]
}

const emptyParty = (): PartyInfo => ({
  name: '', inn: '', kpp: '', address: '',
  signatory_name: '', signatory_position: '', role: '',
})

export default function NewContractPage() {
  const router = useRouter()

  const [step, setStep] = useState<Step>('upload')
  const [verifyTab, setVerifyTab] = useState<VerifyTab>('parties')

  const [file, setFile] = useState<File | null>(null)
  const [pdfText, setPdfText] = useState<PdfText | null>(null)

  const [allObjects, setAllObjects] = useState<ObjectOption[]>([])
  const [allStages,  setAllStages]  = useState<ProjectStage[]>([])
  const [analysis, setAnalysis] = useState<ContractAnalysis | null>(null)
  const [selectedObjectCodes, setSelectedObjectCodes] = useState<string[]>([])

  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{ id: string; title: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // Подгружаем справочники один раз
  useEffect(() => {
    supabase
      .from('objects')
      .select('code,current_name,contractor,aliases')
      .eq('active', true)
      .order('code', { ascending: true })
      .then(({ data }) => setAllObjects((data as unknown as ObjectOption[]) ?? []))
    supabase
      .from('project_stages')
      .select('code,label,sort_order')
      .order('sort_order', { ascending: true })
      .then(({ data }) => setAllStages((data as unknown as ProjectStage[]) ?? []))
  }, [])

  // ─── Шаг 1 → 2: чтение PDF + анализ ──────────────────────────────────────
  async function handleFile(f: File) {
    setError(null)
    setDuplicate(null)
    setFile(f)
    setBusy(true)
    setStep('analyze')

    try {
      const pdf = await extractTextFromPdf(f)
      setPdfText(pdf)

      const res = await fetch('/api/contracts/v2/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: pdf.fullText,
          objects: allObjects,
          project_stages: allStages,
        }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        throw new Error(error)
      }
      const a = (await res.json()) as ContractAnalysis
      // нормализуем недостающие поля
      a.customer ??= emptyParty()
      a.contractor ??= emptyParty()
      a.clauses ??= []
      a.object_codes ??= []
      a.project_stage ??= null
      // _id для каждого пункта — нужен dnd-kit для стабильной идентификации строк
      a.clauses = a.clauses.map(c => ({ ...c, _id: c._id ?? newClauseId() }))
      setAnalysis(a)
      setSelectedObjectCodes(a.object_codes)
      setStep('verify')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setStep('upload')
    } finally {
      setBusy(false)
    }
  }

  // ─── Шаг 4: сохранение ────────────────────────────────────────────────────
  async function handleSave() {
    if (!analysis || !file || !pdfText) return
    setBusy(true)
    setError(null)
    setDuplicate(null)

    try {
      const saveRes = await fetch('/api/contracts/v2/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis,
          object_codes: selectedObjectCodes,
          extractedText: pdfText.fullText,
        }),
      })
      if (saveRes.status === 409) {
        const body = await saveRes.json() as { error: string; existing_id: string; existing_title: string }
        setDuplicate({ id: body.existing_id, title: body.existing_title })
        return
      }
      if (!saveRes.ok) {
        const { error } = await saveRes.json()
        throw new Error(error)
      }
      const saveResp = await saveRes.json() as {
        document_id: string
        aliases_added?: Record<string, string[]>
      }
      const { document_id } = saveResp

      // Если LLM нашёл новые публичные имена объектов — показать оператору
      const added = saveResp.aliases_added ?? {}
      if (Object.keys(added).length > 0) {
        const lines = Object.entries(added)
          .map(([code, names]) => `  • ${code} ← ${names.join(', ')}`)
          .join('\n')
        alert(`Найдены новые публичные имена объектов и добавлены в справочник:\n\n${lines}`)
      }

      // Загружаем файл
      const formData = new FormData()
      formData.append('files', file)
      const uploadRes = await fetch(`/api/contracts/v2/${document_id}/upload`, {
        method: 'POST',
        body: formData,
      })
      if (!uploadRes.ok) {
        const { error } = await uploadRes.json()
        // Договор сохранён, но файл не загрузился — переходим всё равно, оператор перезагрузит
        console.error('[upload]', error)
      }

      router.push(`/contracts/${document_id}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  // ─── Рендер ───────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => router.push('/contracts')} className="text-blue-600">← Назад</button>
        <h1 className="text-2xl font-bold">Новый договор</h1>
      </div>

      <Stepper step={step} />

      {error && (
        <div className="my-4 p-3 bg-red-50 border border-red-300 text-red-800 rounded">
          {error}
        </div>
      )}

      {duplicate && (
        <div className="my-4 p-4 bg-yellow-50 border border-yellow-400 text-yellow-900 rounded">
          <div className="font-semibold mb-1">Договор с таким номером уже существует</div>
          <div className="text-sm mb-3">
            В базе данных найден активный договор: <span className="font-medium">{duplicate.title}</span>.
            Повторная загрузка заблокирована — дубли по номеру договора не допускаются.
          </div>
          <div className="flex gap-2">
            <a
              href={`/contracts/${duplicate.id}`}
              className="px-3 py-1.5 bg-yellow-600 text-white rounded text-sm hover:bg-yellow-700"
            >
              Открыть существующий договор
            </a>
            <button
              onClick={() => setDuplicate(null)}
              className="px-3 py-1.5 border border-yellow-600 text-yellow-800 rounded text-sm hover:bg-yellow-100"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {step === 'upload' && (
        <UploadStep onFile={handleFile} busy={busy} />
      )}

      {step === 'analyze' && (
        <div className="my-12 text-center text-gray-600">
          <div className="inline-block w-8 h-8 border-4 border-blue-300 border-t-blue-600 rounded-full animate-spin mb-3" />
          <div>Распознаём договор...</div>
          <div className="text-sm text-gray-400 mt-1">{file?.name} — {pdfText?.numPages ?? '...'} стр.</div>
        </div>
      )}

      {step === 'verify' && analysis && (
        <>
          <div className="flex gap-2 mb-4 border-b">
            {(['parties', 'objects', 'clauses'] as VerifyTab[]).map(t => (
              <button
                key={t}
                onClick={() => setVerifyTab(t)}
                className={`px-4 py-2 border-b-2 ${verifyTab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-600'}`}
              >
                {t === 'parties' ? 'Стороны' : t === 'objects' ? 'Объекты' : `Пункты (${analysis.clauses.length})`}
              </button>
            ))}
          </div>

          {verifyTab === 'parties' && (
            <PartiesPanel
              analysis={analysis}
              stages={allStages}
              onChange={setAnalysis}
            />
          )}

          {verifyTab === 'objects' && (
            <ObjectsPanel
              all={allObjects}
              selected={selectedObjectCodes}
              onChange={setSelectedObjectCodes}
            />
          )}

          {verifyTab === 'clauses' && (
            <ClausesPanel
              clauses={analysis.clauses}
              signedDate={analysis.signed_date}
              onChange={cl => setAnalysis({ ...analysis, clauses: cl })}
            />
          )}

          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => setStep('upload')}
              className="px-4 py-2 border rounded text-gray-600"
            >
              ← Загрузить другой
            </button>
            <button
              onClick={() => setStep('confirm')}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Далее: подтверждение →
            </button>
          </div>
        </>
      )}

      {step === 'confirm' && analysis && (
        <ConfirmStep
          analysis={analysis}
          objects={selectedObjectCodes}
          onBack={() => setStep('verify')}
          onSave={handleSave}
          busy={busy}
        />
      )}
    </div>
  )
}

// ─── Stepper ────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'upload',  label: '1. Файл' },
    { id: 'analyze', label: '2. Распознавание' },
    { id: 'verify',  label: '3. Проверка' },
    { id: 'confirm', label: '4. Сохранение' },
  ]
  const idx = steps.findIndex(s => s.id === step)
  return (
    <div className="flex items-center mb-8">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center flex-1">
          <div className={`flex items-center justify-center w-8 h-8 rounded-full border-2 ${
            i <= idx ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 text-gray-400'
          }`}>
            {i + 1}
          </div>
          <div className={`ml-2 text-sm ${i === idx ? 'font-semibold' : 'text-gray-500'}`}>{s.label.replace(/^\d+\.\s/, '')}</div>
          {i < steps.length - 1 && <div className={`flex-1 h-0.5 mx-3 ${i < idx ? 'bg-blue-600' : 'bg-gray-300'}`} />}
        </div>
      ))}
    </div>
  )
}

// ─── Step 1: Upload ─────────────────────────────────────────────────────────

function UploadStep({ onFile, busy }: { onFile: (f: File) => void; busy: boolean }) {
  const [drag, setDrag] = useState(false)
  return (
    <div
      onDragEnter={e => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault()
        setDrag(false)
        const f = e.dataTransfer.files[0]
        if (f) onFile(f)
      }}
      className={`p-12 text-center border-2 border-dashed rounded ${drag ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}`}
    >
      <div className="text-gray-500 mb-3">Перетащите PDF или DOCX сюда</div>
      <label className="inline-block px-4 py-2 bg-blue-600 text-white rounded cursor-pointer hover:bg-blue-700">
        {busy ? 'Чтение...' : 'Выбрать файл'}
        <input
          type="file"
          accept=".pdf,.docx"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
          className="hidden"
          disabled={busy}
        />
      </label>
    </div>
  )
}

// ─── Step 3a: Parties ───────────────────────────────────────────────────────

function PartiesPanel({
  analysis,
  stages,
  onChange,
}: {
  analysis: ContractAnalysis
  stages: ProjectStage[]
  onChange: (a: ContractAnalysis) => void
}) {
  function patch(side: 'customer' | 'contractor', field: keyof PartyInfo, value: string) {
    onChange({ ...analysis, [side]: { ...analysis[side], [field]: value } })
  }
  function patchMeta(field: keyof ContractAnalysis, value: string) {
    onChange({ ...analysis, [field]: value })
  }
  function patchStage(value: string) {
    onChange({ ...analysis, project_stage: value || null })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Название" value={analysis.title} onChange={v => patchMeta('title', v)} className="col-span-2" />
        <Field label="Номер" value={analysis.number} onChange={v => patchMeta('number', v)} />
        <Field label="Дата подписания" value={analysis.signed_date ?? ''} onChange={v => patchMeta('signed_date', v)} type="date" />
        <Field label="Версия" value={analysis.version} onChange={v => patchMeta('version', v)} />
        <label className="block">
          <span className="text-xs text-gray-600">Стадия проекта</span>
          <select
            value={analysis.project_stage ?? ''}
            onChange={e => patchStage(e.target.value)}
            className="w-full px-2 py-1 border rounded"
          >
            <option value="">— не определена —</option>
            {stages.map(s => (
              <option key={s.code} value={s.code}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      {(['customer', 'contractor'] as const).map(side => (
        <div key={side} className="border rounded p-4">
          <div className="font-semibold mb-2">{side === 'customer' ? 'Заказчик' : 'Подрядчик'}</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Наименование" value={analysis[side].name} onChange={v => patch(side, 'name', v)} className="col-span-2" />
            <Field label="ИНН" value={analysis[side].inn} onChange={v => patch(side, 'inn', v)} />
            <Field label="КПП" value={analysis[side].kpp} onChange={v => patch(side, 'kpp', v)} />
            <Field label="Адрес" value={analysis[side].address} onChange={v => patch(side, 'address', v)} className="col-span-2" />
            <Field label="Подписант (ФИО)" value={analysis[side].signatory_name} onChange={v => patch(side, 'signatory_name', v)} />
            <Field label="Должность" value={analysis[side].signatory_position} onChange={v => patch(side, 'signatory_position', v)} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', className = '' }: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-gray-600">{label}</span>
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1 border rounded"
      />
    </label>
  )
}

// ─── Step 3b: Objects ───────────────────────────────────────────────────────

function ObjectsPanel({
  all,
  selected,
  onChange,
}: {
  all: ObjectOption[]
  selected: string[]
  onChange: (codes: string[]) => void
}) {
  function toggle(code: string) {
    onChange(selected.includes(code) ? selected.filter(c => c !== code) : [...selected, code])
  }
  return (
    <div className="space-y-1">
      <div className="text-sm text-gray-600 mb-2">Отметьте объекты, к которым относится договор:</div>
      {all.map(o => (
        <label key={o.code} className="flex items-center gap-2 p-2 border rounded hover:bg-gray-50 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.includes(o.code)}
            onChange={() => toggle(o.code)}
          />
          <span className="font-mono text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded">{o.code}</span>
          <span>{o.current_name}</span>
          {o.contractor && <span className="text-xs text-gray-500">({o.contractor})</span>}
        </label>
      ))}
    </div>
  )
}

// ─── Step 3c: Clauses (drag&drop через dnd-kit) ─────────────────────────────

function ClausesPanel({
  clauses,
  signedDate,
  onChange,
}: {
  clauses: ClauseInfo[]
  signedDate: string | null
  onChange: (cl: ClauseInfo[]) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Расчётные даты для всех пунктов
  const computedMap = useMemo(() => {
    const inputs = clauses.map((c, i) => ({
      id: c._id ?? `idx_${i}`,
      order_index: c.order_index ?? i + 1,
      clause_date: c.clause_date,
      term_days: c.term_days,
      term_type: c.term_type,
      term_base: c.term_base,
      term_ref_clause_id: c.term_ref_clause_id ?? null,
      date_mode: c.date_mode ?? null,
    }))
    return computeAllClauseDates(inputs, { signedDate })
  }, [clauses, signedDate])

  function patch(idx: number, field: keyof ClauseInfo, value: string | number | null) {
    const next = [...clauses]
    next[idx] = { ...next[idx], [field]: value }
    onChange(next)
  }
  function patchMulti(idx: number, partial: Partial<ClauseInfo>) {
    const next = [...clauses]
    next[idx] = { ...next[idx], ...partial }
    onChange(next)
  }
  function add() {
    onChange([...clauses, {
      order_index:  clauses.length + 1,
      clause_date:  null,
      term_days:    null,
      term_type:    null,
      term_base:    null,
      term_text:    null,
      description:  '',
      note:         null,
      source_page:  null,
      source_quote: '',
      _id:          newClauseId(),
    }])
  }
  function remove(idx: number) {
    onChange(clauses.filter((_, i) => i !== idx).map((c, i) => ({ ...c, order_index: i + 1 })))
  }
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = clauses.findIndex(c => c._id === active.id)
    const newIdx = clauses.findIndex(c => c._id === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    const reordered = arrayMove(clauses, oldIdx, newIdx).map((c, i) => ({ ...c, order_index: i + 1 }))
    onChange(reordered)
  }

  // Гарантируем что у каждого пункта есть _id (на случай если parent не успел проставить)
  const items = clauses.map(c => c._id ?? `idx_${c.order_index}`)

  return (
    <div>
      <div className="text-xs text-gray-500 mb-2 px-1 flex flex-wrap gap-4 items-center">
        <span className="font-semibold text-gray-600">Режим пункта:</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 border-2 border-green-500 bg-white"></span>
          <span>определяющая (введено вручную)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 border border-gray-300 bg-gray-50"></span>
          <span className="italic">расчётная (вычислено из формулы)</span>
        </span>
        <span className="ml-auto text-gray-400 text-[11px]">↻ — переключить режим</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="border rounded">
            {clauses.map((c, i) => {
              const cid = c._id ?? `idx_${i}`
              return (
                <NewClauseRow
                  key={cid}
                  id={cid}
                  clause={c}
                  allClauses={clauses}
                  computed={computedMap.get(cid) ?? null}
                  onPatch={(field, val) => patch(i, field, val)}
                  onPatchMulti={(partial) => patchMulti(i, partial)}
                  onDelete={() => remove(i)}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
      <button onClick={add} className="mt-2 px-3 py-1 border rounded text-sm">+ Пункт</button>
    </div>
  )
}

function NewClauseRow({
  id, clause, allClauses, computed, onPatch, onPatchMulti, onDelete,
}: {
  id: string
  clause: ClauseInfo
  allClauses: ClauseInfo[]
  computed: ClauseDateResult | null
  onPatch: (field: keyof ClauseInfo, value: string | number | null) => void
  onPatchMulti: (partial: Partial<ClauseInfo>) => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    background: isDragging ? '#eff6ff' : undefined,
  }

  // Эффективный режим
  const mode: 'date' | 'term' | null = clause.date_mode
    ?? ((clause.term_days != null && clause.term_base) ? 'term'
       : clause.clause_date ? 'date'
       : null)
  const isDateMode = mode === 'date'
  const isTermMode = mode === 'term'

  const computedDate = computed?.date ?? ''
  const computedReason = computed?.reason ?? null

  const dateBoxClass = isDateMode
    ? 'border-2 border-green-500 bg-white'
    : isTermMode
      ? 'border border-gray-300 bg-gray-50 italic text-gray-500'
      : 'border border-gray-300'
  const termFieldClass = isTermMode
    ? 'border-2 border-green-500 bg-white'
    : isDateMode
      ? 'border border-gray-300 bg-gray-50 italic text-gray-400'
      : 'border border-gray-300'

  const dateDisplayValue = isTermMode ? computedDate : (clause.clause_date ?? '')
  const dateReadOnly = isTermMode
  const termReadOnly = isDateMode

  function toggleMode() {
    if (isDateMode) {
      onPatch('date_mode' as keyof ClauseInfo, 'term' as never)
    } else if (isTermMode) {
      const fixed = computedDate || clause.clause_date || null
      onPatchMulti({ date_mode: 'date', clause_date: fixed })
    }
  }

  function handleDateChange(value: string | null) {
    if (mode === null && value) {
      onPatchMulti({ clause_date: value, date_mode: 'date' })
    } else {
      onPatch('clause_date', value)
    }
  }

  function handleTermChange<F extends 'term_days' | 'term_type' | 'term_base'>(
    field: F,
    value: ClauseInfo[F],
  ) {
    const becomingTerm = mode === null && (
      (field === 'term_days' && value != null) ||
      (field === 'term_base' && !!value)
    )
    if (becomingTerm) {
      onPatchMulti({ [field]: value, date_mode: 'term' } as Partial<ClauseInfo>)
    } else {
      onPatch(field, value as string | number | null)
    }
  }

  function handleBaseChange(rawValue: string) {
    const newRef: string | null = rawValue || null
    const newBase: TermBase | null = newRef ? 'clause' : null

    const becomingTermMode = mode === null && newBase
    const patch: Partial<ClauseInfo> = {
      term_base: newBase,
      term_ref_clause_id: newRef,
    }
    if (becomingTermMode) patch.date_mode = 'term'
    onPatchMulti(patch)
  }

  const baseSelectValue = clause.term_ref_clause_id ?? ''

  const otherClauses = allClauses
    .filter(c => (c._id ?? `idx_${c.order_index}`) !== id)
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))

  return (
    <div ref={setNodeRef} style={style} className="border-b px-3 py-3 hover:bg-gray-50">
      {/* Строка 1: # + БОЛЬШОЕ описание + удалить */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-1 flex-shrink-0 text-gray-500" style={{ width: 48 }}>
          <button
            {...attributes}
            {...listeners}
            type="button"
            title="Перетащить"
            aria-label="Перетащить"
            className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-700 px-1 select-none touch-none"
          >⋮⋮</button>
          <span className="text-xs font-medium">{clause.order_index}</span>
        </div>
        <input
          type="text"
          value={clause.description}
          onChange={e => onPatch('description', e.target.value)}
          className="flex-1 px-2 py-1.5 border rounded font-semibold text-gray-900 text-[15px]"
          placeholder="Описание пункта..."
        />
        <button onClick={onDelete} className="px-1 text-red-500 flex-shrink-0" title="Удалить">✕</button>
      </div>

      {/* Строка 2: режим + дата/срок/категория + цитата + стр. */}
      <div className="flex items-start gap-2" style={{ paddingLeft: 56 }}>
        {/* Тумблер режима — вертикальный */}
        <div className="flex flex-col border rounded overflow-hidden text-[11px] w-20 flex-shrink-0">
          <button
            type="button"
            onClick={() => { if (!isDateMode) toggleMode() }}
            className={`px-1.5 py-1 ${isDateMode
              ? 'bg-green-100 text-green-700 font-semibold'
              : 'bg-white text-gray-400 hover:bg-gray-50'}`}
            title={isDateMode ? 'Активен: фиксированная дата' : 'Переключить на режим «дата»'}
          >📅 Дата</button>
          <button
            type="button"
            onClick={() => { if (!isTermMode) toggleMode() }}
            className={`px-1.5 py-1 border-t ${isTermMode
              ? 'bg-green-100 text-green-700 font-semibold'
              : 'bg-white text-gray-400 hover:bg-gray-50'}`}
            title={isTermMode ? 'Активен: формула срока' : 'Переключить на режим «срок»'}
          >⏱ Срок</button>
        </div>

        {/* Дата + срок + категория */}
        <div className="w-56 flex-shrink-0 space-y-1">
          <input
            type="date"
            value={dateDisplayValue}
            readOnly={dateReadOnly}
            onChange={e => handleDateChange(e.target.value || null)}
            className={`px-1 py-0.5 rounded text-xs w-full ${dateBoxClass}`}
            title={isDateMode
              ? 'Определяющая дата'
              : isTermMode
                ? (computedDate ? `Расчётная: ${computedDate}` : `Дата не вычислена. ${computedReason ?? ''}`)
                : 'Введите дату или заполните формулу'}
          />
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              placeholder="N"
              value={clause.term_days ?? ''}
              readOnly={termReadOnly}
              onChange={e => handleTermChange('term_days', e.target.value ? parseInt(e.target.value) : null)}
              className={`w-12 px-1 py-0.5 rounded text-xs ${termFieldClass}`}
              title="Количество дней"
            />
            <select
              value={clause.term_type ?? ''}
              disabled={termReadOnly}
              onChange={e => handleTermChange('term_type', (e.target.value || null) as 'working' | 'calendar' | null)}
              className={`px-0.5 py-0.5 rounded text-xs ${termFieldClass}`}
              title="Тип дней"
            >
              <option value="">—</option>
              <option value="working">раб.</option>
              <option value="calendar">кал.</option>
            </select>
            <select
              value={baseSelectValue}
              disabled={termReadOnly}
              onChange={e => handleBaseChange(e.target.value)}
              className={`flex-1 px-0.5 py-0.5 rounded text-xs min-w-0 ${termFieldClass}`}
              title="От пункта-источника"
            >
              <option value="">— от пункта… —</option>
              {otherClauses.map(oc => {
                const ocId = oc._id ?? `idx_${oc.order_index}`
                const desc = (oc.description ?? '').slice(0, 40)
                const truncated = (oc.description ?? '').length > 40 ? '…' : ''
                return (
                  <option key={ocId} value={ocId}>
                    п.{oc.order_index} — {desc}{truncated}
                  </option>
                )
              })}
            </select>
          </div>
          {isTermMode && computedReason && !computedDate && (
            <div className="text-[10px] text-amber-600 italic">{computedReason}</div>
          )}
          <select
            value={clause.category ?? ''}
            onChange={e => onPatch('category' as keyof ClauseInfo, (e.target.value || null) as never)}
            className={`w-full text-[11px] px-1.5 py-1 border rounded font-semibold uppercase tracking-wide ${
              clause.category ? CATEGORY_BADGE_CLASS[clause.category as ClauseCategory] : 'bg-gray-50 text-gray-400 border-gray-200'
            }`}
            title="Категория пункта"
          >
            <option value="">— тип —</option>
            {CATEGORY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.short} · {o.label}</option>
            ))}
          </select>
        </div>

        {/* Источник из договора (read-only) + примечание + цитата формулы */}
        <div className="flex-1 min-w-0 space-y-1">
          <div
            className="w-full px-1.5 py-1 border-l-4 border-blue-300 border-y border-r rounded text-xs flex items-center gap-2 bg-blue-50/30"
            title="Источник пункта — точная цитата из текста договора (read-only)"
          >
            <span className="flex-shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-medium tabular-nums">
              стр. {clause.source_page ?? '—'}
            </span>
            <span className={`flex-1 italic truncate ${clause.source_quote ? 'text-blue-900' : 'text-gray-400 not-italic'}`}>
              {clause.source_quote || '— цитата из договора отсутствует —'}
            </span>
          </div>
          {clause.note && (
            <div className="text-xs text-gray-500 px-1.5 py-1 border rounded bg-gray-50">{clause.note}</div>
          )}
          <input
            type="text"
            value={clause.term_text ?? ''}
            onChange={e => onPatch('term_text', e.target.value || null)}
            className="w-full px-1.5 py-1 border rounded text-xs italic text-gray-500"
            placeholder="Цитата формулы срока: «15 рабочих дней с даты подписания»"
          />
        </div>
      </div>
    </div>
  )
}

// ─── Step 4: Confirm ───────────────────────────────────────────────────────

function ConfirmStep({
  analysis, objects, onBack, onSave, busy,
}: {
  analysis: ContractAnalysis
  objects: string[]
  onBack: () => void
  onSave: () => void
  busy: boolean
}) {
  return (
    <div className="space-y-4">
      <div className="border rounded p-4 bg-gray-50">
        <div className="text-lg font-semibold mb-2">{analysis.title}</div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-gray-500">Номер: </span>{analysis.number || '—'}</div>
          <div><span className="text-gray-500">Дата подп.: </span>{analysis.signed_date || '—'}</div>
          <div><span className="text-gray-500">Заказчик: </span>{analysis.customer.name} (ИНН {analysis.customer.inn})</div>
          <div><span className="text-gray-500">Подрядчик: </span>{analysis.contractor.name} (ИНН {analysis.contractor.inn})</div>
          <div className="col-span-2"><span className="text-gray-500">Объекты: </span>{objects.join(', ') || '—'}</div>
          <div className="col-span-2"><span className="text-gray-500">Пунктов договора: </span>{analysis.clauses.length}</div>
        </div>
      </div>

      <div className="text-sm text-gray-600">
        После сохранения: создаются записи в БД, файл копируется в <code>ЗПР_Хранилище\ДОГОВОРА\</code>,
        запускается векторная индексация. Перейдём на страницу договора для дальнейшей правки пунктов.
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onBack} className="px-4 py-2 border rounded text-gray-600" disabled={busy}>
          ← Назад
        </button>
        <button onClick={onSave} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700" disabled={busy}>
          {busy ? 'Сохранение...' : 'Подтвердить и сохранить'}
        </button>
      </div>
    </div>
  )
}
