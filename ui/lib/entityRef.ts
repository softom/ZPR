// ─── entityRef ────────────────────────────────────────────────────────────
// Единый универсальный подход к отображению ссылок на сущности системы:
// в блоке «Связи» задачи, секции «Источник», селекторах модалок, таймлайнах
// объекта и т.д.
//
// Контракт: каждая сущность раскладывается в `EntityRef` с одинаковой схемой:
//   icon        — emoji-индикатор типа (для chip/badge)
//   kindLabel   — человеко-читаемое имя типа («Собрание», «Событие», …)
//   label       — основное название (никогда не UUID-обрезок)
//   sublabel    — вторичная инфа (дата, номер документа, направление письма)
//   href        — ссылка на страницу сущности (если есть)
//   tooltip     — что показывать в title-атрибуте при наведении
//
// Используется в `app/tasks/page.tsx` и далее везде, где отображается ссылка
// на сущность.
// См. WIKI 19_Сущность_Задача «UI блок Связи».

export type EntityKind = 'meeting' | 'event' | 'document' | 'letter' | 'object' | 'legal_entity' | 'task' | 'contact'

export type EntityRef = {
  kind: EntityKind
  id: string
  icon: string
  kindLabel: string
  label: string
  sublabel: string | null
  href: string | null
  tooltip: string
}

// ─── Минимальные типы данных, ожидаемые от реестров ────────────────────────

export type MeetingMin = { id: string; code: string | null; title: string | null; meeting_date: string | null }
export type EventMin   = { id: string; title: string | null; event_type: string | null; date_end: string | null; date_computed: string | null }
export type DocumentMin = { id: string; title: string | null; doc_number: string | null; signed_date?: string | null }
export type LetterMin  = { id: string; subject: string | null; date: string | null; direction: string | null }
export type ObjectMin  = { id: string; code: string; current_name: string }
export type LegalEntityMin = { id: string; name: string }
export type TaskMin    = { id: string; code: string; title: string }
export type ContactMin = {
  id: string
  last_name:   string | null
  first_name:  string | null
  middle_name: string | null
  job_title:   string | null
  legal_entity_id: string | null
  /** Опц. FK на auth.users — если контакт = системный пользователь UI.
   *  Подтягивается из contacts.user_id (см. WIKI 19 v2.5+). */
  user_id?: string | null
}

// ─── Утилиты форматирования ────────────────────────────────────────────────

function formatDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// ─── Per-kind форматтеры ───────────────────────────────────────────────────

export const KIND_META: Record<EntityKind, { icon: string; kindLabel: string }> = {
  meeting:      { icon: '🏛',  kindLabel: 'Собрание' },
  event:        { icon: '📅', kindLabel: 'Событие' },
  document:     { icon: '📄', kindLabel: 'Документ' },
  letter:       { icon: '✉',  kindLabel: 'Письмо' },
  object:       { icon: '🏗',  kindLabel: 'Объект' },
  legal_entity: { icon: '🏢', kindLabel: 'Юр.лицо' },
  task:         { icon: '✓',  kindLabel: 'Задача' },
  contact:      { icon: '👤', kindLabel: 'Контакт' },
}

export function formatMeetingRef(m: MeetingMin): EntityRef {
  const meta = KIND_META.meeting
  const dateStr = formatDate(m.meeting_date)
  // Label-приоритет: code (`ПРОТ-…`) → title (1-я строка, обрезанная) → «Собрание DD.MM.YYYY»
  const label = m.code
    || (m.title ? truncate(m.title, 60) : null)
    || (dateStr ? `Собрание ${dateStr}` : `Собрание ${m.id.slice(0, 8)}`)
  // Sublabel: дата если её ещё нет в label
  const sublabel = (label.includes(dateStr) || !dateStr) ? null : dateStr
  return {
    kind: 'meeting', id: m.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label, sublabel,
    href: `/protocols/${m.id}`,
    tooltip: [m.code, m.title, dateStr].filter(Boolean).join(' · '),
  }
}

export function formatEventRef(e: EventMin): EntityRef {
  const meta = KIND_META.event
  const date = e.date_end ?? e.date_computed ?? null
  const dateStr = formatDate(date)
  const label = e.title || (dateStr ? `Событие ${dateStr}` : `Событие ${e.id.slice(0, 8)}`)
  // Sublabel: тип события + дата
  const parts = [e.event_type, dateStr].filter(Boolean) as string[]
  return {
    kind: 'event', id: e.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: truncate(label, 60),
    sublabel: parts.length > 0 ? parts.join(' · ') : null,
    href: `/events/${e.id}`,
    tooltip: [e.event_type, e.title, dateStr].filter(Boolean).join(' · '),
  }
}

export function formatDocumentRef(d: DocumentMin): EntityRef {
  const meta = KIND_META.document
  const label = d.title || `Документ ${d.id.slice(0, 8)}`
  const dateStr = formatDate(d.signed_date)
  const numParts = [d.doc_number ? `№ ${d.doc_number}` : null, dateStr ? `от ${dateStr}` : null].filter(Boolean) as string[]
  return {
    kind: 'document', id: d.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: truncate(label, 60),
    sublabel: numParts.length > 0 ? numParts.join(' ') : null,
    href: `/contracts/${d.id}`,
    tooltip: [d.title, d.doc_number, dateStr].filter(Boolean).join(' · '),
  }
}

export function formatLetterRef(l: LetterMin): EntityRef {
  const meta = KIND_META.letter
  const label = l.subject || `Письмо ${l.id.slice(0, 8)}`
  const dateStr = formatDate(l.date)
  const parts = [l.direction, dateStr].filter(Boolean) as string[]
  return {
    kind: 'letter', id: l.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: truncate(label, 60),
    sublabel: parts.length > 0 ? parts.join(' · ') : null,
    href: null,  // отдельной страницы /letters/[id] пока нет
    tooltip: [l.direction, l.subject, dateStr].filter(Boolean).join(' · '),
  }
}

export function formatObjectRef(o: ObjectMin): EntityRef {
  const meta = KIND_META.object
  return {
    kind: 'object', id: o.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: o.code,
    sublabel: o.current_name,
    href: `/objects/${o.id}`,
    tooltip: `${o.code} — ${o.current_name}`,
  }
}

export function formatLegalEntityRef(le: LegalEntityMin): EntityRef {
  const meta = KIND_META.legal_entity
  return {
    kind: 'legal_entity', id: le.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: le.name,
    sublabel: null,
    href: null,
    tooltip: le.name,
  }
}

export function formatContactRef(c: ContactMin, orgName?: string | null): EntityRef {
  const meta = KIND_META.contact
  // Имя: Фамилия И.О. (сокращённая форма), либо first_name, либо UUID-fallback.
  const ln = (c.last_name ?? '').trim()
  const fn = (c.first_name ?? '').trim()
  const mn = (c.middle_name ?? '').trim()
  let nameShort = ''
  if (ln && fn) {
    nameShort = `${ln} ${fn[0]}.${mn ? `${mn[0]}.` : ''}`
  } else if (ln) {
    nameShort = ln
  } else if (fn) {
    nameShort = fn
  } else {
    nameShort = `Контакт ${c.id.slice(0, 8)}`
  }
  const nameFull = [ln, fn, mn].filter(Boolean).join(' ')
  // Системный пользователь — добавляем 🔐 к имени и пометку в tooltip
  const isSystemUser = Boolean(c.user_id)
  const icon = isSystemUser ? '🔐' : meta.icon
  const kindLabel = isSystemUser ? `${meta.kindLabel} (системный)` : meta.kindLabel
  const subparts = [c.job_title, orgName].filter(Boolean) as string[]
  const tooltipParts = [nameFull, c.job_title, orgName].filter(Boolean) as string[]
  if (isSystemUser) tooltipParts.push('системный пользователь UI')
  return {
    kind: 'contact', id: c.id,
    icon, kindLabel,
    label: nameShort,
    sublabel: subparts.length > 0 ? subparts.join(' · ') : null,
    href: null,  // отдельной страницы /contacts/[id] нет
    tooltip: tooltipParts.join(' · '),
  }
}

export function formatTaskRef(t: TaskMin): EntityRef {
  const meta = KIND_META.task
  return {
    kind: 'task', id: t.id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: t.title,
    sublabel: t.code,
    href: `/tasks?task=${t.id}`,
    tooltip: `${t.code} — ${t.title}`,
  }
}

// ─── Универсальный резолвер ─────────────────────────────────────────────────
// На вход: kind + id + реестры. На выход: EntityRef.
// Если запись не найдена в реестре — fallback на «{KindLabel} <uuid-обрезок>».

export type EntityRegistry = {
  meetings?: MeetingMin[]
  events?: EventMin[]
  documents?: DocumentMin[]
  letters?: LetterMin[]
  objects?: ObjectMin[]
  entities?: LegalEntityMin[]
  tasks?: TaskMin[]
  contacts?: ContactMin[]
}

export function resolveEntityRef(
  kind: EntityKind,
  id: string,
  registry: EntityRegistry,
): EntityRef {
  if (kind === 'meeting') {
    const m = registry.meetings?.find((x) => x.id === id)
    if (m) return formatMeetingRef(m)
  } else if (kind === 'event') {
    const e = registry.events?.find((x) => x.id === id)
    if (e) return formatEventRef(e)
  } else if (kind === 'document') {
    const d = registry.documents?.find((x) => x.id === id)
    if (d) return formatDocumentRef(d)
  } else if (kind === 'letter') {
    const l = registry.letters?.find((x) => x.id === id)
    if (l) return formatLetterRef(l)
  } else if (kind === 'object') {
    const o = registry.objects?.find((x) => x.id === id)
    if (o) return formatObjectRef(o)
  } else if (kind === 'legal_entity') {
    const le = registry.entities?.find((x) => x.id === id)
    if (le) return formatLegalEntityRef(le)
  } else if (kind === 'task') {
    const t = registry.tasks?.find((x) => x.id === id)
    if (t) return formatTaskRef(t)
  } else if (kind === 'contact') {
    const c = registry.contacts?.find((x) => x.id === id)
    if (c) {
      // Подтягиваем имя организации контакта из реестра entities (если есть)
      const orgName = c.legal_entity_id
        ? registry.entities?.find((e) => e.id === c.legal_entity_id)?.name
        : null
      return formatContactRef(c, orgName)
    }
  }
  // Fallback: запись не найдена в реестре
  const meta = KIND_META[kind]
  return {
    kind, id,
    icon: meta.icon, kindLabel: meta.kindLabel,
    label: `${meta.kindLabel} (не найден)`,
    sublabel: id.slice(0, 8),
    href: null,
    tooltip: `${meta.kindLabel} ${id}`,
  }
}
