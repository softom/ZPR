import { supabaseAdmin } from '@/lib/supabase-admin'
import { isoDate } from './periodHelpers'

// Контекст «Короткой справки» — какие варианты заказчик утвердил в работу.
// Источник: утверждённые темы собраний (meeting_topics status='approved') +
// важные события с признаком утверждения/согласования. Накопительно — все,
// что утверждено ДО даты справки (snapshot), так как решения «в работу»
// переносятся вперёд.

// Признак утверждения варианта «в работу». Тема собрания status='approved'
// означает лишь финализацию темы в протоколе, поэтому дополнительно фильтруем
// по ключевым словам именно об утверждении/согласовании/выборе варианта.
const APPROVAL_RE =
  /(вариант|утвержд|согласов|одобр|принят\w*\s+решени|принят\w*\s+в\s+работ|выбра[нл]|финальн\w*\s+вариант)/i

export type ApprovedVariant = {
  id: string
  source: 'topic' | 'event'
  title: string
  content: string | null
  approved_by_org: string | null   // кто поднял/утвердил (raised_by_org темы)
  date: string | null              // дата собрания / события (ISO)
}

export type ShortContext = {
  object: { id: string; code: string; current_name: string }
  snapshotDate: Date
  approved_variants: ApprovedVariant[]
}

export async function buildShortContext(
  objectId: string,
  snapshotDate: Date,
): Promise<ShortContext> {
  const objRes = await supabaseAdmin
    .from('objects')
    .select('id, code, current_name')
    .eq('id', objectId)
    .single()
  if (objRes.error || !objRes.data) {
    throw new Error(`Объект не найден: ${objectId} (${objRes.error?.message ?? 'неизвестно'})`)
  }
  const snapISO = isoDate(snapshotDate)
  const variants: ApprovedVariant[] = []

  // 1) Утверждённые темы собраний (накопительно до даты), с датой собрания.
  const topicsRes = await supabaseAdmin
    .from('meeting_topics')
    .select('id, title, content, raised_by_org, meeting_id, status')
    .contains('object_ids', [objectId])
    .eq('status', 'approved')
    .order('seq')
  const topicsRaw = (topicsRes.data ?? []) as Array<{
    id: string; title: string; content: string | null
    raised_by_org: string | null; meeting_id: string | null
  }>
  if (topicsRaw.length > 0) {
    const meetingIds = [...new Set(topicsRaw.map((t) => t.meeting_id).filter((x): x is string => Boolean(x)))]
    const meetingDateById = new Map<string, string>()
    if (meetingIds.length > 0) {
      const mRes = await supabaseAdmin.from('meetings').select('id, meeting_date').in('id', meetingIds)
      for (const m of (mRes.data ?? []) as Array<{ id: string; meeting_date: string }>) {
        meetingDateById.set(m.id, m.meeting_date)
      }
    }
    for (const t of topicsRaw) {
      const md = t.meeting_id ? (meetingDateById.get(t.meeting_id) ?? null) : null
      if (md && md > snapISO) continue   // позже даты справки — ещё не накопилось
      const text = `${t.title} ${t.content ?? ''}`
      if (!APPROVAL_RE.test(text)) continue
      variants.push({
        id: t.id, source: 'topic', title: t.title, content: t.content,
        approved_by_org: t.raised_by_org, date: md,
      })
    }
  }

  // 2) Важные события с признаком утверждения (накопительно до даты).
  //    is_preliminary (черновики «На ревью») исключаем.
  const evRes = await supabaseAdmin
    .from('events')
    .select('id, title, note, date_computed, object_ids')
    .contains('object_ids', [objectId])
    .or('is_preliminary.is.null,is_preliminary.eq.false')
    .order('date_computed', { ascending: false, nullsFirst: false })
  for (const e of (evRes.data ?? []) as Array<{
    id: string; title: string; note: string | null; date_computed: string | null
  }>) {
    if (e.date_computed && e.date_computed > snapISO) continue
    const text = `${e.title} ${e.note ?? ''}`
    if (!APPROVAL_RE.test(text)) continue
    variants.push({
      id: e.id, source: 'event', title: e.title, content: e.note,
      approved_by_org: null, date: e.date_computed,
    })
  }

  // Свежие — сверху.
  variants.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  return { object: objRes.data, snapshotDate, approved_variants: variants }
}
