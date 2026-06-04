/**
 * Реестр стейджинг-таблиц ПМТ.
 *
 * Whitelist для просмотра через `/api/pmt/[table]`. Любой запрос к таблице,
 * которой нет в этом списке, отклоняется (HTTP 400) — защита от
 * непреднамеренного SELECT по таблицам вне стейджинга.
 *
 * Источник: 31_Данные_ПМТ_по_участкам.md + фактические таблицы в БД.
 */

export type PmtTableMeta = {
  /** Имя таблицы в БД */
  name: string
  /** Краткое описание (1 строка) */
  label: string
  /** Категория для группировки в UI */
  category: 'meta' | 'cadastral' | 'zu' | 'function' | 'engineering' | 'restriction' | 'territory'
  /** Том-источник для подсказки */
  source: string
  /** Ожидаемое число строк (для маркера «не залито») */
  expectedRows?: number
}

export const PMT_TABLES: PmtTableMeta[] = [
  { name: 'pmt_sources',           label: 'Справочник источников (4 тома)',                           category: 'meta',        source: '—',                  expectedRows: 4 },
  { name: 'pmt_cadastrals',        label: 'Исходные кадастровые участки (ДО межевания)',              category: 'cadastral',   source: 'Том 4.2 ПМТ',        expectedRows: 185 },
  { name: 'pmt_cadastrals_pmt_t1', label: 'ЗУ в ЕГРН на дату ПМТ (срез для верификации)',             category: 'cadastral',   source: 'Том 3.2 ПМТ',        expectedRows: 184 },
  { name: 'pmt_stage1_izyatie',    label: 'Этап 1 — изъятие у частных собственников',                 category: 'cadastral',   source: 'Том 3.2 ПМТ',        expectedRows: 76 },
  { name: 'pmt_vri_changes',       label: 'Этапы 2/4/6/8 — установление ВРИ для исходных кадастров',  category: 'cadastral',   source: 'Том 3.2 ПМТ',        expectedRows: 22 },
  { name: 'pmt_zu',                label: 'Образуемые ЗУ — главная таблица (участок/контур/сервитут)', category: 'zu',         source: 'Том 3.2 ПМТ',        expectedRows: 212 },
  { name: 'pmt_zu_points',         label: 'Координаты поворотных точек ЗУ',                            category: 'zu',         source: 'Том 3.2 ПМТ',        expectedRows: 3106 },
  { name: 'pmt_zu_stage_attrs',    label: 'Атрибуты ЗУ по этапам 3/5/7',                               category: 'zu',         source: 'Том 3.2 ПМТ',        expectedRows: 184 },
  { name: 'pmt_servituts',         label: 'Сервитуты (Таблица 13)',                                    category: 'zu',         source: 'Том 3.2 ПМТ',        expectedRows: 16 },
  { name: 'pmt_zu_public',         label: 'ЗУ общего пользования',                                     category: 'zu',         source: 'Том 3.2 ПМТ',        expectedRows: 19 },
  { name: 'pmt_zu_objects',        label: 'Связь ЗУ ↔ функциональный объект ППТ',                      category: 'function',   source: 'Том 1.2 ППТ',        expectedRows: 40 },
  { name: 'pmt_zone_params',       label: 'Параметры застройки функциональных зон',                    category: 'function',   source: 'Том 1.2 ППТ',        expectedRows: 31 },
  { name: 'pmt_oks',               label: 'Объекты капитального строительства с этажностью',           category: 'function',   source: 'Том 1.2 ППТ',        expectedRows: 34 },
  { name: 'pmt_eng_objects',       label: 'Инженерные объекты (резервуары, ТП, котельные)',            category: 'engineering', source: 'Том 1.2 ППТ',        expectedRows: 22 },
  { name: 'pmt_loads',             label: 'Расчётные нагрузки по 7 инженерным сетям',                  category: 'engineering', source: 'Том 2.2 ППТ',        expectedRows: 175 },
  { name: 'pmt_zouit',             label: 'ЗОУИТ — зоны с особыми условиями',                          category: 'restriction', source: 'Том 4.2 ПМТ',        expectedRows: 15 },
  { name: 'pmt_zouit_reg',         label: 'ЗОУИТ — реестровые № в ЕГРН',                               category: 'restriction', source: 'Том 2.2 ППТ',        expectedRows: undefined },
  { name: 'pmt_okn',               label: 'Объекты культурного наследия',                              category: 'restriction', source: 'Том 2.2 ППТ',        expectedRows: undefined },
  { name: 'pmt_boundary',          label: 'Граница территории проектирования',                         category: 'territory',   source: 'Том 3.2 ПМТ',        expectedRows: 307 },
  { name: 'pmt_redlines',          label: 'Красные линии по кварталам',                                category: 'territory',   source: 'Том 3.2 ПМТ',        expectedRows: 200 },
]

export const CATEGORY_LABELS: Record<PmtTableMeta['category'], string> = {
  meta:        'Метаданные',
  cadastral:   'Кадастры и изменения ВРИ',
  zu:          'Земельные участки (ЗУ)',
  function:    'Функциональные объекты ППТ',
  engineering: 'Инженерия',
  restriction: 'Ограничения (ЗОУИТ, ОКН)',
  territory:   'Территория проекта',
}

export const PMT_TABLE_NAMES = new Set(PMT_TABLES.map((t) => t.name))

export function isAllowedPmtTable(name: string): boolean {
  return PMT_TABLE_NAMES.has(name)
}

export function getPmtTableMeta(name: string): PmtTableMeta | null {
  return PMT_TABLES.find((t) => t.name === name) ?? null
}
