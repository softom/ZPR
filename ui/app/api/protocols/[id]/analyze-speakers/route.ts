/**
 * POST /api/protocols/[id]/analyze-speakers
 *
 * LLM-распознавание спикеров транскрипции по содержанию реплик.
 *
 * Алгоритм:
 *   1. Грузим meeting + meeting_participants + meeting_legal_entities
 *   2. Парсим транскрипцию + извлекаем список сырых меток спикеров
 *   3. LLM возвращает дословные упоминания имени/орг для каждого спикера
 *      + типизированные цитаты-обоснования (см. lib/protocol/analyzeSpeakers.ts)
 *   4. Сервер ДЕТЕРМИНИРОВАННО сопоставляет упоминания с реальными
 *      meeting_participants — это снимает риск галлюцинаций LLM (модель
 *      могла бы выдумать ФИО, но мы сверяем по точным фамилиям/именам
 *      из БД).
 *
 * Возвращает: { speakers: Record<rawLabel, AnalyzedSpeaker> }
 * где AnalyzedSpeaker содержит:
 *   - contact_id?: string  (UUID из meeting_participants, если уверенный match)
 *   - label?: string       (полное ФИО кандидата)
 *   - org?: string         (имя юр.лица)
 *   - confidence: 'high' | 'medium' | 'low' | 'ambiguous' | 'unknown'
 *   - evidence: [{type, text}]
 *   - candidates?: [{contact_id, label, org}]  (если ambiguous — несколько)
 *
 * Доступен после meeting.transcription_path != null + meeting_participants > 0.
 */

import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  parseTranscriptFile,
  extractSpeakers,
  type SpeakerMap,
} from '@/lib/protocol/parseTranscript'
import { analyzeSpeakers, type SpeakerEvidence } from '@/lib/protocol/analyzeSpeakers'
import type { MeetingContext } from '@/lib/protocol/extractTasksAndTopics'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export const maxDuration = 90

export interface AnalyzedSpeaker {
  contact_id?: string
  label?: string
  org?: string
  confidence: 'high' | 'medium' | 'low' | 'ambiguous' | 'unknown'
  /** Цитаты-обоснования из LLM. */
  evidence: SpeakerEvidence[]
  /** Если LLM нашла упоминания, но сервер не смог однозначно сопоставить — показываем сырое. */
  fio_mention?: string | null
  org_mention?: string | null
  /** При неоднозначном match — список кандидатов из meeting_participants. */
  candidates?: Array<{ contact_id: string; label: string; org: string }>
}

type Participant = {
  contact_id: string
  last_name: string
  first_name: string
  middle_name: string | null
  job_title: string | null
  legal_entity_id: string | null
  org_name: string
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // 1. Собрание + контекст
  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings').select('*').eq('id', id).single()
  if (mErr || !meeting) {
    return NextResponse.json({ error: `Собрание не найдено: ${mErr?.message ?? 'unknown'}` }, { status: 404 })
  }
  if (!meeting.transcription_path) {
    return NextResponse.json(
      { error: 'У собрания нет транскрипции — распознавание невозможно.' },
      { status: 422 },
    )
  }

  const [orgsRes, partsRes] = await Promise.all([
    supabaseAdmin
      .from('meeting_legal_entities')
      .select('legal_entity_id, role, legal_entities(id,name,aliases)')
      .eq('meeting_id', id),
    supabaseAdmin
      .from('meeting_participants')
      .select(
        'contact_id, contacts(id,last_name,first_name,middle_name,job_title,legal_entity_id,legal_entities(id,name))',
      )
      .eq('meeting_id', id),
  ])

  type LERef = { id: string; name: string; aliases: unknown }
  type OrgRow = { legal_entity_id: string; role: string | null; legal_entities: LERef | LERef[] | null }
  type LEItem = { id: string; name: string; aliases: string[]; role?: string }
  const legalEntities = ((orgsRes.data ?? []) as OrgRow[])
    .map((r): LEItem | null => {
      const le = Array.isArray(r.legal_entities) ? r.legal_entities[0] : r.legal_entities
      if (!le) return null
      const item: LEItem = {
        id: le.id,
        name: le.name,
        aliases: Array.isArray(le.aliases) ? le.aliases as string[] : [],
      }
      if (r.role) item.role = r.role
      return item
    })
    .filter((x): x is LEItem => Boolean(x))

  type CRef = {
    id: string
    last_name?: string | null
    first_name?: string | null
    middle_name?: string | null
    job_title?: string | null
    legal_entity_id?: string | null
    legal_entities?: { id: string; name: string } | { id: string; name: string }[] | null
  }
  type PartRow = { contact_id: string; contacts: CRef | CRef[] | null }
  const participants: Participant[] = []
  for (const p of (partsRes.data ?? []) as PartRow[]) {
    const c = Array.isArray(p.contacts) ? p.contacts[0] : p.contacts
    if (!c) continue
    const le = Array.isArray(c.legal_entities) ? c.legal_entities[0] : c.legal_entities
    participants.push({
      contact_id: c.id,
      last_name: (c.last_name ?? '').trim(),
      first_name: (c.first_name ?? '').trim(),
      middle_name: c.middle_name?.trim() || null,
      job_title: c.job_title?.trim() || null,
      legal_entity_id: c.legal_entity_id ?? null,
      org_name: le?.name ?? '',
    })
  }

  if (participants.length === 0) {
    return NextResponse.json(
      { error: 'У собрания нет участников — сначала добавьте контакты в Секции 2.' },
      { status: 422 },
    )
  }

  // 2. Транскрипция + сырые спикеры
  const filePath = path.join(
    STORAGE_DIR,
    (meeting.transcription_path as string).replace(/\//g, path.sep),
  )
  const speakerMap = (meeting.speaker_map ?? {}) as SpeakerMap
  let transcript: string
  let speakers: Array<{ raw: string; count: number; samples: string[] }>
  try {
    transcript = await parseTranscriptFile(filePath, { speakerMap })
    speakers = await extractSpeakers(filePath)
  } catch (e) {
    return NextResponse.json(
      { error: `Ошибка чтения транскрипции: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  if (speakers.length === 0) {
    return NextResponse.json(
      { error: 'В файле не найдены спикеры (нужна tagged-разметка или CSV с колонкой Speaker).' },
      { status: 422 },
    )
  }

  // 3. LLM-анализ
  const ctx: MeetingContext = {
    meeting_date: meeting.meeting_date as string,
    title: meeting.title as string,
    object_codes: Array.isArray(meeting.object_codes) ? (meeting.object_codes as string[]) : [],
    objects: [],
    legal_entities: legalEntities,
    participants: participants.map((p) => ({
      fio: [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' '),
      org: p.org_name,
      ...(p.job_title ? { role: p.job_title } : {}),
    })),
  }

  let llmResult: Awaited<ReturnType<typeof analyzeSpeakers>>
  try {
    llmResult = await analyzeSpeakers(transcript, ctx, speakers)
  } catch (e) {
    return NextResponse.json(
      { error: `LLM analyze-speakers: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  // Server-side debug: видно в терминале `next dev` сколько спикеров с какими
  // confidence вернула LLM. Помогает при тюнинге промпта.
  const confStats: Record<string, number> = { high: 0, medium: 0, low: 0, unknown: 0 }
  for (const v of Object.values(llmResult)) {
    confStats[v.confidence] = (confStats[v.confidence] ?? 0) + 1
  }
  console.log(`[analyze-speakers/${id.slice(0,8)}] LLM вернула: ${
    Object.entries(confStats).map(([k,v]) => `${k}=${v}`).join(' ')
  } (всего ${speakers.length})`)

  // 4. Server-side fuzzy match
  // Сопоставляем LLM-упоминания с реальными meeting_participants по полю
  // first_name / last_name / middle_name. Орг-упоминание — с meeting_legal_entities
  // по name и aliases. Результат — однозначный contact_id или candidates[].
  const result: Record<string, AnalyzedSpeaker> = {}
  for (const sp of speakers) {
    const item = llmResult[sp.raw]
    if (!item) {
      result[sp.raw] = { confidence: 'unknown', evidence: [] }
      continue
    }

    const fioCandidates = item.fio_mention
      ? matchParticipants(item.fio_mention, participants)
      : []
    const orgMatch = item.org_mention
      ? matchLegalEntity(item.org_mention, legalEntities)
      : null

    // Если есть кандидаты по ФИО — фильтруем по орг (если LLM дала org и она однозначно матчится).
    let filtered = fioCandidates
    if (filtered.length > 1 && orgMatch) {
      const narrow = filtered.filter((p) => p.legal_entity_id === orgMatch.id)
      if (narrow.length > 0) filtered = narrow
    }

    if (filtered.length === 1) {
      const p = filtered[0]
      // High только если LLM сама дала high; иначе используем её confidence
      const conf: AnalyzedSpeaker['confidence'] =
        item.confidence === 'high' ? 'high' :
        item.confidence === 'medium' ? 'medium' :
        item.confidence === 'low' ? 'low' : 'low'
      result[sp.raw] = {
        contact_id: p.contact_id,
        label: [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' '),
        org: p.org_name,
        confidence: conf,
        evidence: item.evidence,
        fio_mention: item.fio_mention,
        org_mention: item.org_mention,
      }
    } else if (filtered.length > 1) {
      // Несколько кандидатов — пользователь выбирает
      result[sp.raw] = {
        confidence: 'ambiguous',
        evidence: item.evidence,
        fio_mention: item.fio_mention,
        org_mention: item.org_mention,
        candidates: filtered.map((p) => ({
          contact_id: p.contact_id,
          label: [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(' '),
          org: p.org_name,
        })),
      }
    } else {
      // ФИО не сопоставилось. Может быть, есть только организация —
      // тогда покажем её как подсказку без contact_id.
      result[sp.raw] = {
        confidence: item.confidence === 'unknown' ? 'unknown' : 'low',
        evidence: item.evidence,
        fio_mention: item.fio_mention,
        org_mention: item.org_mention,
        ...(orgMatch ? { org: orgMatch.name } : {}),
      }
    }
  }

  return NextResponse.json({ speakers: result })
}

/**
 * Сопоставляет LLM-упоминание имени с meeting_participants.
 * Возвращает массив кандидатов. Стратегия:
 *   1. По полному совпадению last_name (или first_name + last_name) → точный match
 *   2. По одиночному совпадению first_name (если в собрании только один с таким именем)
 *   3. По middle_name (если LLM дала «Иван Петрович» — ищем по first_name+middle_name)
 *
 * Регистронезависимо, толерантно к разному порядку слов («Светлана Иванова» / «Иванова Светлана»).
 */
function matchParticipants(mention: string, parts: Participant[]): Participant[] {
  const m = mention.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!m) return []
  const tokens = m.split(' ').filter(Boolean)

  // Точное полное совпадение «фамилия имя [отчество]» или «имя фамилия»
  const exact = parts.filter((p) => {
    const ln = p.last_name.toLowerCase()
    const fn = p.first_name.toLowerCase()
    const mn = (p.middle_name ?? '').toLowerCase()
    return tokens.includes(ln) && (tokens.includes(fn) || tokens.includes(mn))
  })
  if (exact.length > 0) return exact

  // Совпадение только по фамилии — обычно один Иванов в собрании
  const byLast = parts.filter((p) => tokens.includes(p.last_name.toLowerCase()))
  if (byLast.length > 0) return byLast

  // Только по имени (если такой один)
  const byFirst = parts.filter((p) => tokens.includes(p.first_name.toLowerCase()))
  if (byFirst.length > 0) return byFirst

  // Имя + отчество (Иван Петрович без фамилии)
  const byFirstMiddle = parts.filter((p) =>
    tokens.includes(p.first_name.toLowerCase()) &&
    p.middle_name && tokens.includes(p.middle_name.toLowerCase()),
  )
  return byFirstMiddle
}

function matchLegalEntity(
  mention: string,
  entities: Array<{ id: string; name: string; aliases: string[] }>,
): { id: string; name: string } | null {
  const m = mention.toLowerCase().replace(/[«»"']/g, '').trim()
  if (!m) return null
  for (const e of entities) {
    const name = e.name.toLowerCase().replace(/[«»"']/g, '').trim()
    if (m.includes(name) || name.includes(m)) {
      return { id: e.id, name: e.name }
    }
    for (const alias of e.aliases) {
      const a = alias.toLowerCase().trim()
      if (a && (m.includes(a) || a.includes(m))) {
        return { id: e.id, name: e.name }
      }
    }
  }
  return null
}
