/**
 * POST /api/protocols/[id]/process
 *
 * Streaming endpoint (NDJSON): извлекает задачи и темы «Обсудили» из
 * транскрипции через LLM (Polza.AI / claude-sonnet-4.6) и сохраняет их
 * в БД как preliminary.
 *
 * Поэтапный лог:
 *   ⏳ Чтение собрания и контекста...
 *   ✓ N орг., M участн., K объектов
 *   ⏳ Извлечение текста транскрипции...
 *   ✓ Извлечено N символов
 *   ⏳ Запрос к LLM...
 *   ✓ Получено: N задач, M тем
 *   ⏳ Сохранение в БД...
 *   ✓ Сохранено: N задач + M тем (preliminary)
 *   done
 */

import { NextRequest } from 'next/server'
import path from 'path'
import { writeFile } from 'fs/promises'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { parseTranscriptFile, type SpeakerMap } from '@/lib/protocol/parseTranscript'
import {
  extractTasksAndTopics,
  type MeetingContext,
} from '@/lib/protocol/extractTasksAndTopics'
import { ensureMeetingCode } from '@/lib/protocol/meetingCode'

const STORAGE_DIR = (process.env.STORAGE_DIR ?? 'D:\\ЗПР_Хранилище').replace(/\//g, path.sep)

export const maxDuration = 90

type LogEvent = {
  type: 'log' | 'done' | 'error'
  status?: 'start' | 'ok' | 'fail'
  message: string
  data?: unknown
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: LogEvent) => {
        controller.enqueue(enc.encode(JSON.stringify(event) + '\n'))
      }

      try {
        send({ type: 'log', status: 'start', message: 'Чтение собрания и контекста…' })

        const { data: meeting, error: mErr } = await supabaseAdmin
          .from('meetings')
          .select('*')
          .eq('id', id)
          .single()
        if (mErr || !meeting) {
          throw new Error(`Собрание не найдено: ${mErr?.message ?? 'unknown'}`)
        }
        if (!meeting.transcription_path) {
          throw new Error('Транскрипция ещё не загружена')
        }

        const [orgsRes, partsRes, objectsRes] = await Promise.all([
          supabaseAdmin
            .from('meeting_legal_entities')
            .select('legal_entity_id, role, legal_entities(id,name,aliases)')
            .eq('meeting_id', id),
          supabaseAdmin
            .from('meeting_participants')
            .select(
              'contact_id, contacts(last_name,first_name,middle_name,job_title,legal_entities(name))',
            )
            .eq('meeting_id', id),
          supabaseAdmin.from('objects').select('code,current_name').eq('active', true),
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
              aliases: Array.isArray(le.aliases) ? (le.aliases as string[]) : [],
            }
            if (r.role) item.role = r.role
            return item
          })
          .filter((x): x is LEItem => Boolean(x))

        type ContactRef = {
          last_name?: string | null
          first_name?: string | null
          middle_name?: string | null
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

        const objects = (objectsRes.data ?? []) as { code: string; current_name: string }[]

        send({
          type: 'log',
          status: 'ok',
          message: `Контекст: ${legalEntities.length} орг., ${participants.length} участн., ${objects.length} объектов`,
        })

        // ── Извлечение текста ─────────────────────────────────────────
        send({ type: 'log', status: 'start', message: 'Извлечение текста транскрипции…' })
        const filePath = path.join(
          STORAGE_DIR,
          (meeting.transcription_path as string).replace(/\//g, path.sep),
        )
        const speakerMap = (meeting.speaker_map ?? {}) as SpeakerMap
        const mappedCount = Object.keys(speakerMap).length
        const transcript = await parseTranscriptFile(filePath, { speakerMap })
        const mapInfo = mappedCount > 0 ? ` (применён маппинг ${mappedCount} спикеров)` : ''
        send({
          type: 'log',
          status: 'ok',
          message: `Извлечено ${transcript.length.toLocaleString('ru-RU')} символов${mapInfo}`,
        })

        // Сохраняем «снимок текста, ушедшего в LLM» рядом с оригиналом
        const transcriptionRel = (meeting.transcription_path as string).replace(/\\/g, '/')
        const baseDir = path.dirname(transcriptionRel)
        const baseName = path.basename(transcriptionRel).replace(/\.[^.]+$/, '')
        const resolvedRelPosix = `${baseDir}/${baseName}.resolved.txt`
        const resolvedAbs = path.join(STORAGE_DIR, resolvedRelPosix.replace(/\//g, path.sep))
        try {
          await writeFile(resolvedAbs, transcript, 'utf-8')
          await supabaseAdmin
            .from('meetings')
            .update({ transcription_resolved_path: resolvedRelPosix })
            .eq('id', id)
          send({
            type: 'log',
            status: 'ok',
            message: `Сохранена распознанная версия: ${baseName}.resolved.txt`,
          })
        } catch (err) {
          // не критично — основной flow LLM не блокируем
          console.error('save resolved transcript:', err)
        }

        // ── LLM ───────────────────────────────────────────────────────
        send({
          type: 'log',
          status: 'start',
          message: 'Запрос к LLM (Polza.AI / claude-sonnet-4.6)… до 60 сек',
        })

        const ctx: MeetingContext = {
          meeting_date: meeting.meeting_date as string,
          title: meeting.title as string,
          object_codes: Array.isArray(meeting.object_codes) ? (meeting.object_codes as string[]) : [],
          objects,
          legal_entities: legalEntities,
          participants,
        }
        const result = await extractTasksAndTopics(transcript, ctx)
        send({
          type: 'log',
          status: 'ok',
          message: `LLM вернула: ${result.tasks.length} задач, ${result.topics.length} тем`,
        })

        // Детектор invalid-UTF-8 в LLM-выводе. Claude через Polza.AI изредка
        // выдаёт U+FFFD (replacement char) — обычно один-два байта Cyrillic-символа
        // ломаются на токенной границе. Не критично, но видно глазом в UI («��»).
        // Подсчитываем количество поражённых записей и логируем — пользователь
        // увидит предупреждение и сможет поправить через «✎ Изменить» в Секции 6.
        const FFFD = '�'
        const tasksWithBadChars = result.tasks.filter(
          (t) => (t.title?.includes(FFFD)) || (t.explanation?.includes(FFFD)),
        )
        const topicsWithBadChars = result.topics.filter(
          (t) => (t.title?.includes(FFFD)) || (t.content?.includes(FFFD)),
        )
        if (tasksWithBadChars.length + topicsWithBadChars.length > 0) {
          send({
            type: 'log',
            status: 'fail',
            message:
              `⚠ В ${tasksWithBadChars.length} задачах и ${topicsWithBadChars.length} темах ` +
              `обнаружены invalid-UTF-8 символы (�) — Claude изредка ломает Cyrillic на токенной границе. ` +
              `Поправьте вручную в Секции 6 («✎ Изменить»).`,
          })
        }

        // ── Сохранение в БД ───────────────────────────────────────────
        send({ type: 'log', status: 'start', message: 'Сохранение в БД…' })

        // Удаляем предыдущие preliminary этого собрания (если переобработка)
        await supabaseAdmin.from('tasks').delete().eq('meeting_id', id).eq('status', 'preliminary')
        await supabaseAdmin
          .from('meeting_topics')
          .delete()
          .eq('meeting_id', id)
          .eq('status', 'preliminary')

        // Генерируем (или читаем) уникальный meeting.code. Сохраняется в БД
        // при первом вызове и фиксируется — повторные обработки не меняют его.
        // При коллизии (несколько собраний в один день у одного подрядчика)
        // второй и далее получают суффикс -2, -3, ... См. lib/protocol/meetingCode.ts.
        const sourceProto = await ensureMeetingCode(id)
        send({ type: 'log', status: 'ok', message: `Код протокола: ${sourceProto}` })

        async function resolveOrgId(name: string | null | undefined): Promise<string | null> {
          if (!name) return null
          const { data, error } = await supabaseAdmin.rpc('find_legal_entity_by_alias', {
            p_query: name,
          })
          if (error) return null
          return (data as string) ?? null
        }

        // Map: object code/alias → uuid. LLM возвращает коды (`02_FAM_800`),
        // но в БД мы храним связь по uuid (см. WIKI 09_Правило_связей).
        const codeToObjectId = new Map<string, string>()
        for (const o of objects as Array<{ id?: string; code: string; current_name: string }>) {
          if (o.code && (o as { id?: string }).id) {
            codeToObjectId.set(o.code, (o as { id: string }).id)
          }
        }
        // Дополнительно: подгрузим aliases для разрешения старых/альтернативных кодов
        const { data: objectsWithAliases } = await supabaseAdmin
          .from('objects')
          .select('id, code, aliases')
          .eq('active', true)
        for (const o of (objectsWithAliases ?? []) as Array<{
          id: string
          code: string
          aliases: unknown
        }>) {
          codeToObjectId.set(o.code, o.id)
          const aliasArr = Array.isArray(o.aliases) ? (o.aliases as string[]) : []
          for (const a of aliasArr) codeToObjectId.set(a, o.id)
        }
        // Объекты, реально входящие в это собрание — для жёсткой валидации.
        // LLM иногда «галлюцинирует» и возвращает объект, не присутствующий
        // в meeting.object_ids (например похожее название другого отеля). Без
        // фильтра резолвер находит такой объект в общем списке active=true и
        // тихо привязывает задачу не к тому отелю. Защищаемся:
        //   • Оставляем только объекты ⊆ meeting.object_ids
        //   • Если ничего не осталось — задача относится ко ВСЕМУ собранию
        //     (object_ids = meeting.object_ids), это безопасный fallback.
        const meetingObjectIds = Array.isArray(meeting.object_ids)
          ? (meeting.object_ids as string[])
          : []
        const meetingObjectIdSet = new Set(meetingObjectIds)

        function resolveObjectIds(codes: string[] | undefined | null): string[] {
          const ids = new Set<string>()
          for (const c of codes ?? []) {
            const id = codeToObjectId.get(c)
            if (id && meetingObjectIdSet.has(id)) ids.add(id)
          }
          if (ids.size === 0 && meetingObjectIds.length > 0) {
            // LLM не указала объект (или указала не из собрания) — относим ко всем
            return [...meetingObjectIds]
          }
          return [...ids]
        }

        // Подсчёт уже занятых seq для этого префикса. Защита на случай если
        // несколько собраний на одну дату попадают под один sourceProto
        // (например, fallback на meeting_id slice совпал, либо разные собрания
        // с одним подрядчиком на одну дату). Без этого INSERT падает в
        // UNIQUE-конфликт по `code` и тихо пропускает часть задач/тем.
        const taskPrefix = `${sourceProto}-ЗАД-`
        const topicPrefix = `${sourceProto}-ОБС-`
        const [{ data: existingTaskCodes }, { data: existingTopicCodes }] = await Promise.all([
          supabaseAdmin.from('tasks').select('code').like('code', `${taskPrefix}%`),
          supabaseAdmin.from('meeting_topics').select('code').like('code', `${topicPrefix}%`),
        ])
        const usedTaskSeqs = new Set<number>(
          ((existingTaskCodes ?? []) as Array<{ code: string }>)
            .map((r) => Number(r.code.slice(taskPrefix.length)))
            .filter((n) => Number.isFinite(n)),
        )
        const usedTopicSeqs = new Set<number>(
          ((existingTopicCodes ?? []) as Array<{ code: string }>)
            .map((r) => Number(r.code.slice(topicPrefix.length)))
            .filter((n) => Number.isFinite(n)),
        )
        let nextTaskSeq = 1
        function takeNextTaskSeq(): number {
          while (usedTaskSeqs.has(nextTaskSeq)) nextTaskSeq++
          const v = nextTaskSeq
          usedTaskSeqs.add(v)
          nextTaskSeq++
          return v
        }
        let nextTopicSeq = 1
        function takeNextTopicSeq(): number {
          while (usedTopicSeqs.has(nextTopicSeq)) nextTopicSeq++
          const v = nextTopicSeq
          usedTopicSeqs.add(v)
          nextTopicSeq++
          return v
        }

        let tasksInserted = 0
        for (let i = 0; i < result.tasks.length; i++) {
          const t = result.tasks[i]
          const seq = takeNextTaskSeq()
          const code = `${taskPrefix}${String(seq).padStart(2, '0')}`
          const assignee_entity_id = await resolveOrgId(t.assignee_org)
          const object_ids = resolveObjectIds(t.object_codes)
          const { error } = await supabaseAdmin.from('tasks').insert({
            code,
            title: t.title,
            explanation: t.explanation || '',
            status: 'preliminary',
            priority: t.priority || 'medium',
            assignee_org: t.assignee_org,
            assignee_entity_id,
            object_ids,                            // UUID — единственный источник истины
            due_date: t.due_date,
            quotes: t.quotes ?? [],
            // Источник: meeting_id, entity_links(raised_from) создастся триггером.
            // См. WIKI 19_Сущность_Задача «v2.4».
            meeting_id: id,
            tags: ['protocol'],
          })
          if (!error) tasksInserted++
          else console.error('insert task failed:', error.message, code)
        }

        let topicsInserted = 0
        for (let i = 0; i < result.topics.length; i++) {
          const t = result.topics[i]
          const seq = takeNextTopicSeq()
          const code = `${topicPrefix}${String(seq).padStart(2, '0')}`
          const raised_by_entity_id = await resolveOrgId(t.raised_by_org)
          const object_ids = resolveObjectIds(t.object_codes)
          const { error } = await supabaseAdmin.from('meeting_topics').insert({
            meeting_id: id,
            code,
            seq,
            title: t.title,
            content: t.content || '',
            raised_by_org: t.raised_by_org,
            raised_by_entity_id,
            object_ids,                            // UUID — единственный источник истины
            quotes: t.quotes ?? [],
            status: 'preliminary',
            discussion_date: meeting.meeting_date, // по умолчанию = дата собрания, может быть сдвинута при ревью
          })
          if (!error) topicsInserted++
          else console.error('insert topic failed:', error.message, code)
        }

        await supabaseAdmin.from('meetings').update({ status: 'processed' }).eq('id', id)

        send({
          type: 'log',
          status: 'ok',
          message: `Сохранено: ${tasksInserted} задач + ${topicsInserted} тем (preliminary)`,
        })
        send({
          type: 'done',
          message: 'Готово. Перейдите к разделу «Ревью» для правки.',
          data: { tasks: tasksInserted, topics: topicsInserted },
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        send({ type: 'error', message: `Ошибка: ${msg}` })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-cache',
    },
  })
}
