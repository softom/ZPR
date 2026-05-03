/**
 * POST /api/contracts/v2/analyze
 * Принимает текст PDF (с маркерами [PAGE N]) и список объектов проекта.
 * Возвращает ContractAnalysis (стороны, метаданные, пункты договора).
 *
 * Соответствует ТЗ модуля A — см. 18_Архитектура_модулей.md.
 */

import { NextRequest, NextResponse } from 'next/server'
import { extractContractClauses, type ObjectInfo, type ProjectStage } from '@/lib/parser/extractClauses'

export async function POST(request: NextRequest) {
  try {
    const { text, objects, project_stages } = await request.json() as {
      text: string
      objects: ObjectInfo[]
      project_stages?: ProjectStage[]
    }

    if (!text?.trim()) {
      return NextResponse.json(
        { error: 'Нет текста для анализа' },
        { status: 400 },
      )
    }

    const analysis = await extractContractClauses(text, objects ?? [], project_stages ?? [])
    return NextResponse.json(analysis)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[v2/analyze]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
