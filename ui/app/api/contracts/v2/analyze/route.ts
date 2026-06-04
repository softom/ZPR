/**
 * POST /api/contracts/v2/analyze
 *
 * Принимает текст PDF (с маркерами [PAGE N]) и список объектов проекта.
 * Возвращает ContractAnalysis с метаданными и сторонами, **но без clauses и stages**:
 *   - clauses всегда []
 *   - этапы договора (contract_stages) выделяются отдельно — кнопка «🎯 Выделить этапы»
 *   - пункты (события) договора — кнопка «🎯 Выделить события договора» (после этапов)
 *
 * Это убирает «холостой прогон» LLM по пунктам до этапов (раньше пункты извлекались
 * сразу, потом перевыделялись с правильным stage_number — двойная работа).
 */

import { NextRequest, NextResponse } from 'next/server'
import { extractContractMetadata, type ObjectInfo, type ProjectStage } from '@/lib/parser/extractClauses'

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

    const analysis = await extractContractMetadata(text, objects ?? [], project_stages ?? [])
    return NextResponse.json(analysis)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[v2/analyze]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
