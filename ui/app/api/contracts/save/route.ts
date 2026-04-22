import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Milestone = {
  milestone_name: string
  date_start: string
  due_date: string
  responsible: string
  source: string
}

export async function POST(request: NextRequest) {
  const { metadata, milestones } = await request.json() as {
    metadata: {
      date: string
      direction: string
      from_to: string
      method: string
      contract_type: string
      version: string
      title: string
      object_codes: string[]
    }
    milestones: Milestone[]
  }

  // 1 — Create letter
  const dateSlug  = metadata.date.replaceAll('-', '_')
  const titleSlug = metadata.title.replaceAll(' ', '_')
  const letterFolder = `ВХОДЯЩИЕ\\${dateSlug}_${metadata.from_to}_Договор__${metadata.method}`
  const docFolder    = `ДОГОВОРА\\${dateSlug}_${titleSlug}_${metadata.version}__${metadata.method}`

  const { data: letter, error: lErr } = await supabaseAdmin
    .from('letters')
    .insert({
      date: metadata.date,
      direction: metadata.direction,
      from_to: metadata.from_to,
      method: metadata.method,
      folder_path: letterFolder,
    })
    .select('id')
    .single()

  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })

  // 2 — Create document
  const { data: doc, error: dErr } = await supabaseAdmin
    .from('documents')
    .insert({
      letter_id: letter.id,
      object_codes: metadata.object_codes,
      type: 'ДОГОВОРА',
      title: metadata.title,
      version: metadata.version,
      folder_path: docFolder,
    })
    .select('id')
    .single()

  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

  // 3 — Create milestones
  if (milestones.length > 0) {
    const rows = milestones.flatMap(m =>
      metadata.object_codes.length > 0
        ? metadata.object_codes.map(code => ({
            document_id: doc.id,
            object_code: code,
            milestone_name: m.milestone_name,
            date_start: m.date_start || null,
            due_date: m.due_date || null,
            responsible: m.responsible || null,
            source: m.source || null,
          }))
        : [{
            document_id: doc.id,
            object_code: '',
            milestone_name: m.milestone_name,
            date_start: m.date_start || null,
            due_date: m.due_date || null,
            responsible: m.responsible || null,
            source: m.source || null,
          }]
    )

    const { error: mErr } = await supabaseAdmin.from('contract_milestones').insert(rows)
    if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 })
  }

  return NextResponse.json({ document_id: doc.id })
}
