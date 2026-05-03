/**
 * Найти или создать запись в legal_entities по ИНН.
 * Серверная функция — использует supabaseAdmin (service_role).
 *
 * См. 19_Сущность_Юридическое_лицо.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface LegalEntityInput {
  inn: string
  name: string
  short_name?: string
  kpp?: string
  ogrn?: string
  address_legal?: string
  address_postal?: string
  signatory_name?: string
  signatory_position?: string
  signatory_basis?: string
  email?: string
  phone?: string
}

export interface LegalEntityResult {
  id: string
  inn: string
  name: string
  created: boolean
}

const nullIfEmpty = (s: string | undefined | null): string | null =>
  s && s.trim() ? s.trim() : null

export async function findOrCreateLegalEntity(
  supabase: SupabaseClient,
  input: LegalEntityInput,
): Promise<LegalEntityResult> {
  const inn = input.inn?.trim()
  if (!inn) throw new Error('findOrCreateLegalEntity: inn is required')
  if (!input.name?.trim()) throw new Error('findOrCreateLegalEntity: name is required')

  // 1. Ищем по ИНН
  const { data: existing, error: selErr } = await supabase
    .from('legal_entities')
    .select('id, inn, name')
    .eq('inn', inn)
    .maybeSingle()

  if (selErr) throw new Error(`findOrCreateLegalEntity SELECT: ${selErr.message}`)
  if (existing) {
    return { id: existing.id, inn: existing.inn, name: existing.name, created: false }
  }

  // 2. Создаём
  const entity_type = inn.length === 12 ? 'individual' : 'legal'
  const { data, error } = await supabase
    .from('legal_entities')
    .insert({
      inn,
      name: input.name.trim(),
      short_name:         nullIfEmpty(input.short_name),
      kpp:                nullIfEmpty(input.kpp),
      ogrn:               nullIfEmpty(input.ogrn),
      address_legal:      nullIfEmpty(input.address_legal),
      address_postal:     nullIfEmpty(input.address_postal),
      signatory_name:     nullIfEmpty(input.signatory_name),
      signatory_position: nullIfEmpty(input.signatory_position),
      signatory_basis:    nullIfEmpty(input.signatory_basis),
      email:              nullIfEmpty(input.email),
      phone:              nullIfEmpty(input.phone),
      entity_type,
    })
    .select('id, inn, name')
    .single()

  if (error) throw new Error(`findOrCreateLegalEntity INSERT: ${error.message}`)

  return { id: data.id, inn: data.inn, name: data.name, created: true }
}

/**
 * Извлечь подписанта из строки вида «Иванов И.И., Директор» → {name, position}.
 * Используется в legacy-данных и LLM-ответах с одним полем `signatory`.
 */
export function splitSignatory(s: string | null | undefined): { name: string | null; position: string | null } {
  if (!s) return { name: null, position: null }
  const [name, ...rest] = s.split(',')
  return {
    name: nullIfEmpty(name) ?? null,
    position: nullIfEmpty(rest.join(',')) ?? null,
  }
}
