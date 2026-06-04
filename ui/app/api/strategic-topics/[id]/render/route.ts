/**
 * /api/strategic-topics/[id]/render?format=docx
 *
 * GET — рендерит «финальный документ» темы. Источник полей —
 *       зафиксированная админом ревизия (strategic_topics.published_revision_id),
 *       а НЕ текущее рабочее состояние strategic_topics.
 *
 * Если published_revision_id = NULL — 409 «Финальный документ не зафиксирован».
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateTopicDocx, type TopicDocSnapshot } from '@/lib/strategic-topics/generateTopicDocx'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const url = new URL(req.url)
  const format = url.searchParams.get('format') ?? 'docx'
  if (format !== 'docx') {
    return NextResponse.json({ error: 'Поддерживается только format=docx' }, { status: 400 })
  }

  // 1. Загрузить тему + ссылку на published-ревизию
  const { data: topic, error: topicErr } = await supabaseAdmin
    .from('strategic_topics')
    .select('id, seq, title, category, status, source_quote, owner_entity_id, published_revision_id, published_at, published_by_user_id')
    .eq('id', id)
    .maybeSingle()
  if (topicErr) return NextResponse.json({ error: topicErr.message }, { status: 500 })
  if (!topic)   return NextResponse.json({ error: 'Тема не найдена' }, { status: 404 })

  if (!topic.published_revision_id) {
    return NextResponse.json(
      { error: 'Финальный документ не зафиксирован. Админ должен «Зафиксировать ревизию» перед скачиванием.' },
      { status: 409 },
    )
  }

  // 2. Загрузить опубликованную ревизию
  const { data: rev, error: revErr } = await supabaseAdmin
    .from('topic_revisions')
    .select('*')
    .eq('id', topic.published_revision_id)
    .maybeSingle()
  if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 })
  if (!rev)   return NextResponse.json({ error: 'Зафиксированная ревизия не найдена' }, { status: 500 })

  // 3. Author / publisher emails
  const [authorEmail, publisherEmail] = await Promise.all([
    rev.author_user_id ? lookupEmail(rev.author_user_id) : Promise.resolve(null),
    topic.published_by_user_id ? lookupEmail(topic.published_by_user_id) : Promise.resolve(null),
  ])

  // 4. Owner name
  let ownerName: string | null = null
  if (topic.owner_entity_id) {
    const { data: le } = await supabaseAdmin
      .from('legal_entities')
      .select('name, short_name')
      .eq('id', topic.owner_entity_id)
      .maybeSingle<{ name: string | null; short_name: string | null }>()
    if (le) ownerName = le.short_name || le.name
  }

  // 5. Собрать snapshot: для каждого поля — proposed_* если NOT NULL, иначе из base_snapshot.
  // base_snapshot — это состояние темы на момент создания ревизии. Опубликованная
  // ревизия = «целостный документ»: то, что было утверждено как финал.
  const base = (rev.base_snapshot ?? {}) as Record<string, unknown>
  const pick = <T,>(proposed: T | null, baseKey: string): T | null => {
    if (proposed !== null && proposed !== undefined) return proposed
    const v = base[baseKey]
    return (v === undefined ? null : v) as T | null
  }

  const snap: TopicDocSnapshot = {
    seq:       (pick<number>(rev.proposed_seq, 'seq')         as number) ?? topic.seq,
    title:     (pick<string>(rev.proposed_title, 'title')     as string) ?? topic.title,
    category:  (pick<string>(rev.proposed_category, 'category') as string) ?? topic.category,
    status:    topic.status,
    synopsis:  (pick<string>(rev.proposed_synopsis, 'synopsis') as string) ?? '',
    threats:   (pick<string>(rev.proposed_threats, 'threats')  as string) ?? '',
    solutions: pick<string>(rev.proposed_solutions, 'solutions') as string | null,
    deadlines: pick<string>(rev.proposed_deadlines, 'deadlines') as string | null,
    owner_name: ownerName,
    source_quote: topic.source_quote ?? null,

    published_at:        topic.published_at as string | null,
    published_by_email:  publisherEmail,
    author_email:        authorEmail,
    revision_created_at: rev.created_at as string,
  }

  // 6. Сгенерировать .docx
  const buffer = await generateTopicDocx(snap)
  const safeTitle = snap.title.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '_').slice(0, 80)
  const filename = `Стратегическая_тема_${String(snap.seq).padStart(3, '0')}_${safeTitle}.docx`

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control':       'no-store',
    },
  })
}

async function lookupEmail(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId)
    return data.user?.email ?? null
  } catch {
    return null
  }
}
