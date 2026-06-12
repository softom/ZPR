'use client'

/**
 * Страница /schedule — двусторонняя интеграция с MS Project через MSPDI XML.
 *
 * Блоки:
 *   1. Импорт .xml (multipart) с выбором поля привязки к объекту.
 *   2. Экспорт .xml (скачивание).
 *   3. Маппинг raw_text → object_id (или is_project_wide).
 *   4. Список результата последнего импорта (нерешённые привязки).
 *   5. История импортов.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ─── Типы ──────────────────────────────────────────────────────────────────

type ObjectRef = { id: string; code: string; current_name: string | null; active: boolean }

type Mapping = {
  id: string
  raw_text: string
  object_id: string | null
  is_project_wide: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

type ImportRow = {
  id: string
  file_name: string
  file_size: number | null
  project_name: string | null
  object_field: string
  tasks_total: number
  tasks_inserted: number
  tasks_updated: number
  tasks_unmapped: number
  predecessors_total: number
  notes: string | null
  imported_at: string
}

type VersionRow = ImportRow & {
  version_name: string | null
  is_active: boolean
  has_xml: boolean
  entry_count: number
  imported_by_email: string | null
}

type UnmappedRow = { mspdiUid: number; taskName: string; rawText: string }
type OrphanRow = { id: string; mspdiUid: number; title: string | null; dateStart: string | null; dateEnd: string | null }

type ImportResponse = {
  importId: string
  stats: {
    tasksTotal: number
    tasksInserted: number
    tasksUpdated: number
    tasksUnmapped: number
    tasksOrphaned: number
    predecessorsTotal: number
  }
  unmapped: UnmappedRow[]
  unknownRawTexts: string[]
  orphaned: OrphanRow[]
}

type PreviewField = {
  fieldName: string
  alias: string
  fieldId: string
  nonEmpty: number
  totalTasks: number
  uniqueValues: number
  sample: string[]
}

type PreviewResponse = {
  project: { name: string | null; title: string | null; startDate: string | null; finishDate: string | null; tasksCount: number }
  fields: PreviewField[]
  notes: { nonEmpty: number; totalTasks: number; sample: string[] }
}

// ─── Главный компонент ───────────────────────────────────────────────────

export default function SchedulePage() {
  const [objects, setObjects] = useState<ObjectRef[]>([])
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [imports, setImports] = useState<ImportRow[]>([])
  const [versions, setVersions] = useState<VersionRow[]>([])

  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [lastImport, setLastImport] = useState<ImportResponse | null>(null)
  const [objectField, setObjectField] = useState('Notes')
  const [importNotes, setImportNotes] = useState('')
  const [importVersionName, setImportVersionName] = useState('')
  const [importMode, setImportMode] = useState<'replace' | 'metadata-only'>('replace')

  // Версии: inline-редактирование имён
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null)
  const [editingVersionName, setEditingVersionName] = useState('')

  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const [exportField, setExportField] = useState<string>('')        // пусто = «как при импорте»
  const [exportVersionId, setExportVersionId] = useState<string>('')  // пусто = активная

  // Reset
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  // Маппинг — форма добавления
  const [newRawText, setNewRawText] = useState('')
  const [newTarget, setNewTarget] = useState<string>('')   // object_id или 'project'

  // ─── Загрузка справочников ────────────────────────────────────────────
  useEffect(() => {
    void loadObjects()
    void loadMappings()
    void loadImports()
    void loadVersions()
  }, [])

  async function loadObjects() {
    const { data } = await supabase
      .from('objects')
      .select('id, code, current_name, active')
      .order('code')
    setObjects((data ?? []) as ObjectRef[])
  }

  async function loadMappings() {
    const r = await fetch('/api/schedule/mappings').then(r => r.json())
    setMappings(r.mappings ?? [])
  }

  async function loadImports() {
    const r = await fetch('/api/schedule/imports').then(r => r.json())
    setImports(r.imports ?? [])
  }

  async function loadVersions() {
    const r = await fetch('/api/schedule/versions').then(r => r.json())
    setVersions(Array.isArray(r) ? r : [])
  }

  // ─── Превью полей при выборе файла ─────────────────────────────────────
  async function handleFileChange() {
    const file = fileRef.current?.files?.[0]
    setPreview(null)
    setLastImport(null)
    if (!file) return
    setPreviewing(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/schedule/preview-fields', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        setImportError(data.error ?? 'preview')
      } else {
        setPreview(data as PreviewResponse)
        // Авто-выбор: первое поле с alias про "объект", иначе самое заполненное
        const fields = (data as PreviewResponse).fields
        const aliasGuess = fields.find(f => /объект|object|здание|корпус/i.test(f.alias)) ?? fields[0]
        if (aliasGuess) setObjectField(aliasGuess.fieldName)
      }
    } catch (e) {
      setImportError(`preview сеть: ${e}`)
    } finally {
      setPreviewing(false)
    }
  }

  // ─── Импорт ───────────────────────────────────────────────────────────
  async function handleImport() {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setImportError('Выбери .xml файл')
      return
    }
    setImporting(true)
    setImportError(null)
    setLastImport(null)

    const fd = new FormData()
    fd.append('file', file)
    fd.append('objectField', objectField)
    fd.append('mode', importMode)
    if (importNotes.trim()) fd.append('notes', importNotes.trim())
    if (importVersionName.trim()) fd.append('versionName', importVersionName.trim())

    try {
      const res = await fetch('/api/schedule/import', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        setImportError(data.error ?? 'Ошибка импорта')
      } else {
        setLastImport(data as ImportResponse)
        setImportVersionName('')
        await loadImports()
        await loadVersions()
      }
    } catch (e) {
      setImportError(`Сеть: ${e}`)
    } finally {
      setImporting(false)
    }
  }

  // ─── Экспорт ──────────────────────────────────────────────────────────
  function handleExport() {
    const params = new URLSearchParams()
    if (exportField.trim()) params.set('objectField', exportField.trim())
    if (exportVersionId.trim()) params.set('versionId', exportVersionId.trim())
    const url = `/api/schedule/export${params.size > 0 ? '?' + params.toString() : ''}`
    window.open(url, '_blank')
  }

  // ─── Маппинг: добавить ────────────────────────────────────────────────
  async function addMapping(rawText?: string) {
    const text = (rawText ?? newRawText).trim()
    const target = newTarget
    if (!text) return
    if (!target) return alert('Выбери объект или «весь проект ЗПР»')

    const body: Record<string, unknown> = { raw_text: text }
    if (target === 'project') body.is_project_wide = true
    else body.object_id = target

    const res = await fetch('/api/schedule/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      alert(data.error ?? 'Ошибка добавления маппинга')
      return
    }
    setNewRawText('')
    setNewTarget('')
    await loadMappings()
  }

  async function deleteMapping(id: string) {
    if (!confirm('Удалить маппинг?')) return
    const res = await fetch(`/api/schedule/mappings/${id}`, { method: 'DELETE' })
    if (!res.ok) alert('Не удалось удалить')
    else await loadMappings()
  }

  // ─── Удаление осиротевших ──────────────────────────────────────────────
  const [deletingOrphans, setDeletingOrphans] = useState(false)

  async function handleDeleteOrphans() {
    if (!lastImport || lastImport.orphaned.length === 0) return
    const n = lastImport.orphaned.length
    if (!confirm(`Удалить ${n} задач, отсутствующих в новом XML?\nЭто также удалит их предшественников и привязки к объектам.`)) return
    setDeletingOrphans(true)
    try {
      const res = await fetch('/api/schedule/delete-orphans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: lastImport.orphaned.map(o => o.id) }),
      })
      const data = await res.json()
      if (!res.ok) {
        alert(`Ошибка: ${data.error}`)
      } else {
        alert(`Удалено: задач ${data.deleted.calendarEntries}, связей ${data.deleted.predecessors}, привязок ${data.deleted.entityLinks}`)
        // Чистим список из текущего результата
        setLastImport({ ...lastImport, orphaned: [], stats: { ...lastImport.stats, tasksOrphaned: 0 } })
      }
    } catch (e) {
      alert(`Сеть: ${e}`)
    } finally {
      setDeletingOrphans(false)
    }
  }

  // ─── Управление версиями ──────────────────────────────────────────────
  async function activateVersion(id: string) {
    const res = await fetch(`/api/schedule/versions/${id}/activate`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error ?? 'Ошибка активации')
      return
    }
    await loadVersions()
  }

  async function deleteVersion(v: VersionRow) {
    if (!confirm(`Удалить версию «${v.version_name ?? v.file_name}»?\n\nВсе ${v.entry_count} задач этой версии будут удалены. Это необратимо.`)) return
    const res = await fetch(`/api/schedule/versions/${v.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      alert(data.error ?? 'Ошибка удаления')
      return
    }
    await loadVersions()
  }

  async function saveVersionName(id: string) {
    const res = await fetch(`/api/schedule/versions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_name: editingVersionName.trim() || null }),
    })
    if (!res.ok) {
      const data = await res.json()
      alert(data.error ?? 'Ошибка сохранения')
      return
    }
    setEditingVersionId(null)
    await loadVersions()
  }

  function exportVersion(v: VersionRow) {
    const params = new URLSearchParams({ versionId: v.id })
    window.open(`/api/schedule/export?${params.toString()}`, '_blank')
  }

  // ─── Reset (опасная зона) ──────────────────────────────────────────────
  async function handleReset(withMappings: boolean) {
    const msg = withMappings
      ? 'Удалить ВСЕ импортированные данные ВКЛЮЧАЯ маппинги (raw_text → объект)?\nПридётся настраивать маппинги заново.'
      : 'Удалить все импортированные из MS Project задачи, связи и историю импортов?\nМаппинги останутся.'
    if (!confirm(msg)) return
    if (!confirm('Точно? Это необратимо.')) return

    setResetting(true)
    setResetResult(null)
    try {
      const res = await fetch('/api/schedule/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withMappings }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResetResult(`Ошибка: ${data.error ?? 'unknown'}`)
      } else {
        const d = data.deleted
        setResetResult(
          `✓ Удалено: задач ${d.calendarEntries}, связей предшественников ${d.predecessors}, ` +
          `entity_links ${d.entityLinks}, импортов ${d.scheduleImports}` +
          (withMappings ? `, маппингов ${d.mappings}` : ''),
        )
        await loadImports()
        if (withMappings) await loadMappings()
        setLastImport(null)
      }
    } catch (e) {
      setResetResult(`Сеть: ${e}`)
    } finally {
      setResetting(false)
    }
  }

  // ─── Карта объектов для отображения имён ──────────────────────────────
  const objectMap = useMemo(() => {
    const m = new Map<string, ObjectRef>()
    for (const o of objects) m.set(o.id, o)
    return m
  }, [objects])

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">График ↔ MS Project</h1>
        <Link href="/calendar" className="text-sm text-blue-600 hover:underline">
          → Календарь объекта
        </Link>
      </header>

      <p className="text-sm text-slate-600">
        Двусторонний обмен с MS Project через MSPDI XML. Календарные вехи (
        <code className="rounded bg-slate-100 px-1">calendar_entries</code>) — общая БД для проекта и Project.
      </p>

      {/* ─── ИМПОРТ ─────────────────────────────────────────── */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">📥 Импорт XML</h2>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".xml"
              className="text-sm"
              onChange={() => void handleFileChange()}
            />
            {previewing && <span className="text-xs text-slate-500">Анализирую файл…</span>}
          </div>

          {/* Превью файла */}
          {preview && (
            <div className="rounded bg-slate-50 p-3 text-sm">
              <div className="mb-2">
                <span className="font-medium">Проект:</span>{' '}
                {preview.project.name ?? '?'} ·{' '}
                задач: {preview.project.tasksCount} ·{' '}
                {preview.project.startDate}..{preview.project.finishDate}
              </div>
              <div className="mb-1 font-medium text-slate-800">Поле привязки к объекту:</div>
              <div className="space-y-1">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="objectField"
                    value="Notes"
                    checked={objectField === 'Notes'}
                    onChange={() => setObjectField('Notes')}
                    className="mt-1"
                  />
                  <span>
                    <code className="rounded bg-slate-200 px-1 text-xs">Notes</code>{' '}
                    <span className="text-slate-600">
                      — заполнено в {preview.notes.nonEmpty}/{preview.notes.totalTasks}
                    </span>
                    {preview.notes.sample.length > 0 && (
                      <span className="ml-1 text-xs text-slate-500">
                        пример: «{preview.notes.sample[0]}»
                      </span>
                    )}
                  </span>
                </label>
                {preview.fields.map((f) => (
                  <label key={f.fieldName} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="objectField"
                      value={f.fieldName}
                      checked={objectField === f.fieldName}
                      onChange={() => setObjectField(f.fieldName)}
                      className="mt-1"
                    />
                    <span>
                      <code className="rounded bg-slate-200 px-1 text-xs">{f.fieldName}</code>
                      {f.alias && <span className="ml-1 text-slate-700">«{f.alias}»</span>}{' '}
                      <span className="text-slate-600">
                        — заполнено {f.nonEmpty}/{f.totalTasks},{' '}
                        уникальных значений: <strong>{f.uniqueValues}</strong>
                      </span>
                      <div className="ml-1 text-xs text-slate-500">
                        примеры: {f.sample.slice(0, 3).map(s => `«${s}»`).join(', ')}
                      </div>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Режим импорта */}
          <div className="rounded bg-amber-50 p-3 text-sm">
            <div className="mb-2 font-medium text-amber-900">Режим импорта:</div>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="importMode"
                  value="replace"
                  checked={importMode === 'replace'}
                  onChange={() => setImportMode('replace')}
                  className="mt-1"
                />
                <span>
                  <strong>Полная замена</strong> — все поля задач, привязки к объектам, заголовки перезаписываются.
                  <span className="block text-xs text-slate-600">
                    Для первой загрузки или когда правок в БД нет.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="importMode"
                  value="metadata-only"
                  checked={importMode === 'metadata-only'}
                  onChange={() => setImportMode('metadata-only')}
                  className="mt-1"
                />
                <span>
                  <strong>Только метаданные</strong> — обновляются <em>mspdi_duration, иерархия,
                  predecessors, флаги Summary/Manual, mspdi_id, Notes</em>.
                  <span className="block text-xs text-slate-600">
                    <strong>НЕ трогаются:</strong> правки заголовков, дат, привязок к объектам,
                    % выполнения, ручные entity_links. Используй когда график в БД уже правили.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={importVersionName}
              onChange={(e) => setImportVersionName(e.target.value)}
              placeholder="Название версии (например: «v014 — апрель»)"
              className="w-72 rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <input
              type="text"
              value={importNotes}
              onChange={(e) => setImportNotes(e.target.value)}
              placeholder="Заметка (необязательно)"
              className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
          <div>
            <button
              onClick={handleImport}
              disabled={importing || !preview}
              className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {importing ? 'Импортирую…' : importMode === 'metadata-only' ? 'Дозагрузить метаданные' : 'Загрузить как новую версию'}
            </button>
          </div>
        </div>

        {importError && (
          <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{importError}</div>
        )}

        {lastImport && (
          <div className="mt-4 rounded bg-emerald-50 p-3 text-sm">
            <div className="font-medium text-emerald-900">
              Импорт завершён · ID: <code className="text-xs">{lastImport.importId.slice(0, 8)}</code>
            </div>
            <div className="mt-1 text-emerald-800">
              Всего: {lastImport.stats.tasksTotal} ·{' '}
              новые: {lastImport.stats.tasksInserted} ·{' '}
              обновлено: {lastImport.stats.tasksUpdated} ·{' '}
              предшественники: {lastImport.stats.predecessorsTotal} ·{' '}
              {lastImport.stats.tasksUnmapped > 0 ? (
                <span className="font-medium text-amber-800">нерешено: {lastImport.stats.tasksUnmapped}</span>
              ) : (
                <span className="text-emerald-700">все привязки разрешены</span>
              )}
              {lastImport.stats.tasksOrphaned > 0 && (
                <span className="font-medium text-red-700"> · удалены в Project: {lastImport.stats.tasksOrphaned}</span>
              )}
            </div>

            {/* Блок осиротевших задач */}
            {lastImport.orphaned.length > 0 && (
              <div className="mt-4 rounded border border-red-200 bg-red-50 p-3">
                <div className="mb-2 font-medium text-red-900">
                  ⚠ В БД остались задачи, которых нет в новом XML ({lastImport.orphaned.length}):
                </div>
                <p className="mb-2 text-xs text-red-800">
                  Видимо их удалили в MS Project. Если правки в БД не нужны — нажми «Удалить»; иначе можно оставить как историю (но в `/calendar` они будут продолжать показываться).
                </p>
                <div className="mb-3 max-h-48 overflow-y-auto rounded bg-white p-2 text-xs">
                  {lastImport.orphaned.slice(0, 50).map(o => (
                    <div key={o.id} className="border-b border-slate-100 py-0.5 last:border-0">
                      <span className="font-mono text-slate-500">UID {o.mspdiUid}</span>{' '}
                      <span className="text-slate-700">{o.title || '(без названия)'}</span>{' '}
                      <span className="text-slate-400">
                        {o.dateStart && `${o.dateStart}..${o.dateEnd}`}
                      </span>
                    </div>
                  ))}
                  {lastImport.orphaned.length > 50 && (
                    <div className="pt-1 text-slate-500">… и ещё {lastImport.orphaned.length - 50}</div>
                  )}
                </div>
                <button
                  onClick={handleDeleteOrphans}
                  disabled={deletingOrphans}
                  className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingOrphans ? 'Удаляю…' : `🗑 Удалить ${lastImport.orphaned.length} задач из БД`}
                </button>
              </div>
            )}

            {lastImport.unknownRawTexts.length > 0 && (
              <div className="mt-3">
                <div className="mb-2 font-medium text-slate-800">Уникальные нерешённые тексты:</div>
                <ul className="space-y-1">
                  {lastImport.unknownRawTexts.map((rt) => (
                    <li key={rt} className="flex items-center gap-2 text-sm">
                      <span className="rounded bg-amber-100 px-2 py-0.5">{rt}</span>
                      <span className="text-xs text-slate-500">
                        ({lastImport.unmapped.filter((u) => u.rawText === rt).length} задач)
                      </span>
                      <button
                        onClick={() => {
                          setNewRawText(rt)
                          window.scrollTo({ top: document.getElementById('mapping-form')?.offsetTop ?? 0 })
                        }}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Привязать →
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ─── ЭКСПОРТ ────────────────────────────────────────── */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">📤 Экспорт XML</h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm">
            Версия:{' '}
            <select
              value={exportVersionId}
              onChange={(e) => setExportVersionId(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">— активная —</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version_name ?? v.file_name}
                  {v.is_active ? ' ✓' : ''} · {new Date(v.imported_at).toLocaleDateString('ru-RU')}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Поле объекта:{' '}
            <input
              type="text"
              value={exportField}
              onChange={(e) => setExportField(e.target.value)}
              placeholder="(как при импорте)"
              className="w-44 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <button
            onClick={handleExport}
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Скачать .xml
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Экспортирует выбранную (или активную) версию плана. Открой результат в MS Project: File → Open → выбери .xml.
        </p>
      </section>

      {/* ─── ВЕРСИИ ─────────────────────────────────────────── */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">🗂 Версии плана</h2>
        <p className="mb-3 text-xs text-slate-500">
          Каждый импорт создаёт изолированную версию. <strong>Активная версия</strong> используется в /calendar и при экспорте по умолчанию.
        </p>
        {versions.length === 0 ? (
          <p className="text-sm text-slate-500">Пока нет ни одного импорта.</p>
        ) : (
          <div className="space-y-2">
            {versions.map((v) => (
              <div
                key={v.id}
                className={`flex flex-wrap items-start gap-2 rounded border p-3 ${v.is_active ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white'}`}
              >
                {/* Активная метка */}
                {v.is_active && (
                  <span className="shrink-0 rounded bg-emerald-500 px-2 py-0.5 text-xs font-semibold text-white">
                    ✓ Активная
                  </span>
                )}

                {/* Название (inline edit) */}
                <div className="flex min-w-0 flex-1 flex-col">
                  {editingVersionId === v.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        type="text"
                        value={editingVersionName}
                        onChange={(e) => setEditingVersionName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveVersionName(v.id)
                          if (e.key === 'Escape') setEditingVersionId(null)
                        }}
                        className="rounded border border-blue-300 px-2 py-0.5 text-sm font-medium"
                      />
                      <button
                        onClick={() => void saveVersionName(v.id)}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        ✓ сохранить
                      </button>
                      <button
                        onClick={() => setEditingVersionId(null)}
                        className="text-xs text-slate-500 hover:underline"
                      >
                        отмена
                      </button>
                    </div>
                  ) : (
                    <button
                      className="text-left font-medium hover:text-blue-600"
                      onClick={() => {
                        setEditingVersionId(v.id)
                        setEditingVersionName(v.version_name ?? '')
                      }}
                      title="Нажми, чтобы задать имя"
                    >
                      {v.version_name
                        ? <span>{v.version_name}</span>
                        : <span className="text-slate-400 italic">без названия — нажми чтобы задать</span>
                      }
                    </button>
                  )}
                  <div className="mt-0.5 text-xs text-slate-500">
                    {new Date(v.imported_at).toLocaleString('ru-RU')} ·{' '}
                    {v.file_name} ·{' '}
                    {v.entry_count} задач ·{' '}
                    {v.tasks_unmapped > 0 && (
                      <span className="text-amber-600">нерешено: {v.tasks_unmapped} · </span>
                    )}
                    {v.has_xml ? '💾 XML сохранён' : '— XML не сохранён'}
                    {v.notes && <span className="ml-1 text-slate-400">· {v.notes}</span>}
                  </div>
                </div>

                {/* Кнопки */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {!v.is_active && (
                    <button
                      onClick={() => void activateVersion(v.id)}
                      className="rounded border border-emerald-400 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50"
                    >
                      Активировать
                    </button>
                  )}
                  <button
                    onClick={() => exportVersion(v)}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                    title="Скачать XML этой версии"
                  >
                    📤 XML
                  </button>
                  {!v.is_active && (
                    <button
                      onClick={() => void deleteVersion(v)}
                      className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ─── МАППИНГ ────────────────────────────────────────── */}
      <section className="rounded border border-slate-200 bg-white p-4" id="mapping-form">
        <h2 className="mb-3 text-lg font-semibold">🔗 Маппинг текста MS Project → объект ЗПР</h2>

        {/* Форма добавления */}
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded bg-slate-50 p-3">
          <label className="flex flex-col text-xs">
            <span className="mb-1 text-slate-600">Текст в MS Project</span>
            <input
              type="text"
              value={newRawText}
              onChange={(e) => setNewRawText(e.target.value)}
              placeholder="например: «Отель 4* Family Солнышко 800»"
              className="w-72 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="mb-1 text-slate-600">Привязать к</span>
            <select
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              className="w-72 rounded border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">— выбери —</option>
              <option value="project">📊 Весь проект ЗПР (общая задача)</option>
              <optgroup label="Объекты">
                {objects.filter(o => o.active).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} — {o.current_name ?? ''}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <button
            onClick={() => addMapping()}
            disabled={!newRawText.trim() || !newTarget}
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Добавить
          </button>
        </div>

        {/* Список */}
        {mappings.length === 0 ? (
          <p className="text-sm text-slate-500">Маппингов пока нет.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200">
              <tr className="text-left text-xs uppercase text-slate-500">
                <th className="py-2 pr-2">Текст в Project</th>
                <th className="py-2 pr-2">Привязка</th>
                <th className="py-2 pr-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2 font-mono text-xs">{m.raw_text}</td>
                  <td className="py-1.5 pr-2">
                    {m.is_project_wide ? (
                      <span className="rounded bg-slate-200 px-2 py-0.5 text-xs">📊 Весь проект ЗПР</span>
                    ) : m.object_id ? (
                      <span className="text-xs">
                        {objectMap.get(m.object_id)?.code ?? '?'} —{' '}
                        {objectMap.get(m.object_id)?.current_name ?? ''}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <button
                      onClick={() => deleteMapping(m.id)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ─── ИСТОРИЯ ИМПОРТОВ ──────────────────────────────── */}
      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-lg font-semibold">📜 История импортов</h2>
        {imports.length === 0 ? (
          <p className="text-sm text-slate-500">Пока нет.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200">
              <tr className="text-left text-xs uppercase text-slate-500">
                <th className="py-2 pr-2">Когда</th>
                <th className="py-2 pr-2">Файл</th>
                <th className="py-2 pr-2">Поле</th>
                <th className="py-2 pr-2 text-right">Всего</th>
                <th className="py-2 pr-2 text-right">Новые</th>
                <th className="py-2 pr-2 text-right">Обновлено</th>
                <th className="py-2 pr-2 text-right">Нерешено</th>
                <th className="py-2 pr-2 text-right">Связи</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2 text-xs text-slate-600">
                    {new Date(imp.imported_at).toLocaleString('ru-RU')}
                  </td>
                  <td className="py-1.5 pr-2 text-xs">{imp.file_name}</td>
                  <td className="py-1.5 pr-2 text-xs font-mono">{imp.object_field}</td>
                  <td className="py-1.5 pr-2 text-right text-xs">{imp.tasks_total}</td>
                  <td className="py-1.5 pr-2 text-right text-xs text-emerald-600">{imp.tasks_inserted}</td>
                  <td className="py-1.5 pr-2 text-right text-xs text-blue-600">{imp.tasks_updated}</td>
                  <td className="py-1.5 pr-2 text-right text-xs">
                    {imp.tasks_unmapped > 0 ? (
                      <span className="text-amber-600">{imp.tasks_unmapped}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-xs text-slate-600">{imp.predecessors_total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ─── ОПАСНАЯ ЗОНА ──────────────────────────────────── */}
      <section className="rounded border-2 border-red-200 bg-red-50 p-4">
        <h2 className="mb-2 text-lg font-semibold text-red-900">⚠ Опасная зона</h2>
        <p className="mb-3 text-sm text-red-800">
          Полная очистка импортированных из MS Project данных. Используется при крупных правках
          схемы/логики или для чистого переимпорта. <strong>Объекты, договоры и не-MSPDI вехи не
          трогаются.</strong>
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleReset(false)}
            disabled={resetting}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {resetting ? 'Удаляю…' : '🗑 Очистить импорт (сохранить маппинги)'}
          </button>
          <button
            onClick={() => handleReset(true)}
            disabled={resetting}
            className="rounded bg-red-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-900 disabled:opacity-50"
          >
            🗑 Очистить ВСЁ (включая маппинги)
          </button>
        </div>
        {resetResult && (
          <div className="mt-3 rounded bg-white p-2 text-sm font-mono text-slate-700">
            {resetResult}
          </div>
        )}
      </section>
    </div>
  )
}
