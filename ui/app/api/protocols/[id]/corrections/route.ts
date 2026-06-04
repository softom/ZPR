import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

type CorrectionKind = 'topic' | 'task' | 'add_topic' | 'add_task' | 'remove_topic' | 'remove_task'

interface CorrectionItem {
  kind: CorrectionKind
  /** Обязателен только для kind='topic'/'task' (UPDATE существующих); для add_* — игнорируется. */
  target_id?: string
  /** Для UPDATE — карта изменённых полей; для add_* — полный набор полей новой записи (title, explanation, object_ids[], quotes[], …) */
  fields: Record<string, unknown>
}

interface CorrectionsBody {
  corrected_by_entity_id?: string | null
  correction_source?: string | null
  correction_note?: string | null
  items: CorrectionItem[]
}

const ALLOWED_KINDS: CorrectionKind[] = [
  'topic', 'task',
  'add_topic', 'add_task',
  'remove_topic', 'remove_task',
]

// POST /api/protocols/[id]/corrections
// Body: см. CorrectionsBody — пакет правок к утверждённому протоколу.
// Действие: вызов SQL-функции apply_correction_batch (atomic UPDATE topics/tasks +
// INSERT новых тем/задач для kind=add_* + append revisions + INSERT event + entity_links).
// Returns: { event_id: string }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: meetingId } = await ctx.params
  const body = await request.json().catch(() => ({} as CorrectionsBody))

  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'items пустой' }, { status: 400 })
  }

  // Лёгкая валидация items
  for (const it of body.items) {
    if (!ALLOWED_KINDS.includes(it?.kind)) {
      return NextResponse.json({ error: `Неизвестный kind: ${it?.kind}` }, { status: 400 })
    }
    const isAdd = it.kind === 'add_topic' || it.kind === 'add_task'
    const isRemove = it.kind === 'remove_topic' || it.kind === 'remove_task'
    // target_id обязателен для UPDATE и REMOVE; для add_* — нет.
    if (!isAdd && (!it.target_id || typeof it.target_id !== 'string')) {
      return NextResponse.json({ error: 'target_id обязателен' }, { status: 400 })
    }
    // fields для remove_* может быть пустым {}, но должен быть объектом.
    if (!it.fields || typeof it.fields !== 'object') {
      // remove_* — даём пустой объект автоматически
      if (isRemove) {
        it.fields = {}
      } else {
        return NextResponse.json({ error: 'fields обязателен' }, { status: 400 })
      }
    }
    if (isAdd && typeof (it.fields as { title?: unknown }).title !== 'string') {
      return NextResponse.json({ error: `${it.kind}: fields.title обязателен` }, { status: 400 })
    }
  }

  const payload = {
    meeting_id: meetingId,
    corrected_by_entity_id: body.corrected_by_entity_id ?? null,
    correction_source: body.correction_source ?? null,
    correction_note: body.correction_note ?? null,
    items: body.items,
  }

  const { data, error } = await supabaseAdmin.rpc('apply_correction_batch', {
    p_payload: payload,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ event_id: data })
}
