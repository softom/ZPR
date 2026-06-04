// Формирует строку «По объекту …» или «По комплексу объектов …» для титула отчёта.
//
// Логика:
//   • 1 объект (не мастерплан) → «По объекту: <code> — <name>»
//   • 1 объект (мастерплан, code оканчивается на '_МАСТЕРПЛАН')
//                              → «По проекту: <name>»
//   • ≥ 2 объектов
//     − если есть мастерплан    → «По комплексу объектов: <имя мастерплана>»
//     − иначе                   → «По комплексу объектов: <name1>, <name2>, …»
//
// История: до 2026-05-15 проверка шла по префиксу '000_'. После ренаминга
// мастерплана в '001_МАСТЕРПЛАН' префикс 001_ начал коллидировать
// с гипотетическими гостиницами очереди 0, поэтому переключились на
// семантический суффикс '_МАСТЕРПЛАН'.

type ObjectInfo = { id: string; code: string; current_name: string }

const MASTERPLAN_CODE_SUFFIX = '_МАСТЕРПЛАН'

function isMasterplan(o: ObjectInfo): boolean {
  return o.code.endsWith(MASTERPLAN_CODE_SUFFIX)
}

export function formatScopeLabel(objects: ObjectInfo[]): string {
  if (objects.length === 0) return 'По объекту: —'

  if (objects.length === 1) {
    const o = objects[0]
    if (isMasterplan(o)) return `По проекту: ${o.current_name}`
    return `По объекту: ${o.code} — ${o.current_name}`
  }

  const masterplan = objects.find(isMasterplan)
  if (masterplan) {
    return `По комплексу объектов: ${masterplan.current_name}`
  }

  // Несколько объектов без мастерплана — перечислим имена через запятую
  const names = objects.map((o) => o.current_name).join(', ')
  return `По комплексу объектов: ${names}`
}
