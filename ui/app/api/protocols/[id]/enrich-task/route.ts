/**
 * POST /api/protocols/[id]/enrich-task
 *
 * Body: { description: string } — краткое описание задачи от пользователя
 *
 * Вызывает LLM (Polza.AI / claude-sonnet-4.6) для поиска по транскрипции
 * деталей задачи: цитаты, исполнителя, срок, приоритет, объекты.
 *
 * Используется в режиме правки утверждённого протокола (Секция 6 → tab
 * «Задачи» → «+ Добавить задачу по замечанию») для предзаполнения формы
 * перед ручной доработкой пользователем.
 *
 * Возвращает:
 *   {
 *     title, explanation, assignee_org, due_date, priority,
 *     object_ids: string[],          // UUID объектов, уже разрезолвленные
 *                                    // по object_codes из ответа LLM
 *     quotes,
 *     found_in_transcript: boolean
 *   }
 *
 * Ошибки:
 *   400 — нет description
 *   404 — собрание не найдено
 *   422 — у собрания нет транскрипции (manual entry mode)
 *   500 — ошибка LLM/чтения файла
 */

import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { parseTranscriptFile, type SpeakerMap } from '@/lib/protocol/parseTranscript'
import { enrichTaskFromTranscript } from '@/lib/protocol/enrichTask'
import type { MeetingContext } from '@/lib/protocol/extractTasksAndTopics'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export const maxDuration = 60

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => ({} as { description?: string }))
  const description = (body?.description ?? '').toString().trim()

  if (!description) {
    return NextResponse.json({ error: 'description пустой' }, { status: 400 })
  }

  // 1. Собрание + контекст
  const { data: meeting, error: mErr } = await supabaseAdmin
    .from('meetings').select('*').eq('id', id).single()
  if (mErr || !meeting) {
    return NextResponse.json({ error: `Собрание не найдено: ${mErr?.message ?? 'unknown'}` }, { status: 404 })
  }
  if (!meeting.transcription_path) {
    return NextResponse.json(
      { error: 'У собрания нет транскрипции — LLM-обогащение недоступно. Заполните задачу вручную.' },
      { status: 422 },
    )
  }

  const [orgsRes, partsRes, objectsRes] = await Promise.all([
    supabaseAdmin
      .from('meeting_legal_entities')
      .select('legal_entity_id, role, legal_entities(id,name,aliases)')
      .eq('meeting_id', id),
    supabaseAdmin
      .from('meeting_participants')
      .select('contact_id, contacts(last_name,first_name,middle_name,job_title,legal_entities(name))')
      .eq('meeting_id', id),
    supabaseAdmin.from('objects').select('id,code,current_name').eq('active', true),
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

  type ContactRef = {
    last_name?: string | null; first_name?: string | null; middle_name?: string | null
    job_title?: string | null
    legal_entities?: { name?: string | null } | { name?: string | null }[] | null
  }
  type PartRow = { contact_id: string; contacts: ContactRef | ContactRef[] | null }
  type Participant = { fio: string; org: string; role?: string }
  const participants: Participant[] = []
  for (const p of (partsRes.data ?? []) as PartRow[]) {
    const c = Array.isArray(p.contacts) ? p.contacts[0] : p.contacts
    if (!c) continue
    const le = Array.isArray(c.legal_entities) ? c.legal_entities[0] : c.legal_entities
    const fio = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ')
    const item: Participant = { fio, org: le?.name ?? '' }
    if (c.job_title) item.role = c.job_title
    participants.push(item)
  }

  const allObjects = (objectsRes.data ?? []) as { id: string; code: string; current_name: string }[]
  const codeToId = new Map(allObjects.map((o) => [o.code, o.id]))

  // 2. Транскрипция
  const filePath = path.join(
    STORAGE_DIR,
    (meeting.transcription_path as string).replace(/\//g, path.sep),
  )
  const speakerMap = (meeting.speaker_map ?? {}) as SpeakerMap
  let transcript: string
  try {
    transcript = await parseTranscriptFile(filePath, { speakerMap })
  } catch (e) {
    return NextResponse.json(
      { error: `Ошибка чтения транскрипции: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  // 3. LLM
  const ctx: MeetingContext = {
    meeting_date: meeting.meeting_date as string,
    title: meeting.title as string,
    object_codes: Array.isArray(meeting.object_codes) ? (meeting.object_codes as string[]) : [],
    objects: allObjects.map((o) => ({ code: o.code, current_name: o.current_name })),
    legal_entities: legalEntities,
    participants,
  }

  try {
    const draft = await enrichTaskFromTranscript(transcript, ctx, description)
    // Преобразуем object_codes → object_ids (UUID) — это формат, с которым
    // работает UI и таблицы.
    const objectIds = draft.object_codes
      .map((c) => codeToId.get(c))
      .filter((x): x is string => Boolean(x))

    return NextResponse.json({
      title: draft.title,
      explanation: draft.explanation,
      assignee_org: draft.assignee_org,
      due_date: draft.due_date,
      priority: draft.priority,
      object_ids: objectIds,
      quotes: draft.quotes,
      found_in_transcript: draft.found_in_transcript,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
