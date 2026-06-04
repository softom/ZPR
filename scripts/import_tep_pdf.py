#!/usr/bin/env python
"""
scripts/import_tep_pdf.py

Импорт «Сводных ТЭП ЗПР» из PDF в masterplan_objects + masterplan_object_metrics.

Один проход: PDF ТЭП → masterplan_objects (директорийный источник).
Для каждой строки:
  - UPSERT masterplan_objects по code (Г_101, К_103, ...)
  - Резолв functional_object по zone_code → masterplan_object_functional_objects
  - Резолв plot по zu_code → masterplan_object_plots
  - INSERT метрик колонок 3-47 → masterplan_object_metrics
      • ППТ-колонки → source='ppt'
      • РАСЧЁТНАЯ-колонки → source='calc'
  - source_document_id = запись в documents для PDF

Источник кодов объектов (Г_101, К_103) — этот PDF. Соответствие к pmt_oks
делается отдельным шагом / вручную через UI.

Использование:
  python scripts/import_tep_pdf.py            # боевой режим
  python scripts/import_tep_pdf.py --dry-run  # без записи в БД
  python scripts/import_tep_pdf.py --verbose  # печать каждой строки

См. WIKI 33_Сущность_Объект_Мастерплана.md.
"""
from __future__ import annotations

import argparse
import re
import sys
import datetime
from pathlib import Path

# Добавляем корень репо в путь, чтобы import config работал из scripts/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config  # type: ignore  # noqa: E402

import pdfplumber  # noqa: E402
from supabase import create_client  # noqa: E402


# ── Константы ─────────────────────────────────────────────────────────────────

PDF_PATH_DEFAULT = r'D:\Dropbox\ЗПР\ИРД\СВОДНЫЕ_ТЭП_ЗПР_20.05.26.pdf'
DOC_TITLE = 'Сводные ТЭП ЗПР'
DOC_VERSION = '2026-05-20'
DOC_TYPE = 'ИРД'

# Маппинг pdf_column_no → (metric_code, source) согласно справочнику
# masterplan_metric_codes. Колонки без записи здесь — игнорируются.
COL_METRIC = {
    3:  ('rooms_count_ppt', 'ppt'),
    5:  ('area_plot',       'ppt'),
    6:  ('area_built',      'ppt'),
    7:  ('area_green',      'ppt'),
    8:  ('area_object',     'ppt'),
    12: ('volume_building', 'calc'),
    13: ('rooms_actual',    'ppt'),
    14: ('rooms_area',      'ppt'),
    15: ('residents_count', 'ppt'),
    17: ('staff_count',     'calc'),
    31: ('water_demand',    'ppt'),
    32: ('water_demand',    'calc'),
    33: ('water_drainage',  'ppt'),
    34: ('water_drainage',  'calc'),
    35: ('heat_fuel',       'ppt'),
    36: ('heat_power',      'calc'),
    37: ('gas',             'ppt'),
    38: ('gas',             'calc'),
    43: ('storm',           'ppt'),
    44: ('power_pp',        'ppt'),
    45: ('power_s',         'ppt'),
    46: ('power_kc',        'ppt'),
    47: ('power_category',  'ppt'),
}

# Метрики, которые хранятся как текст (категория надёжности 'II' и т.д.)
TEXT_METRICS = {'power_category', 'status_code', 'value_code'}

QUEUE_VALUES = {'1', '2', '1-2'}

# Префикс зоны для масштаба объекта: первая буква code (Г_101 → 'Г').
# pdfplumber возвращает кириллицу как '?' в этом PDF — поэтому код объекта
# приходится восстанавливать по контексту секции (заголовок «Зона ... Г-1»).
# Регекс ищет «?-1», «?-1.4» и т.п. в заголовках секций.
SECTION_HEAD_RE = re.compile(r'([А-ЯA-Z?]{1,3})-(\d+)(?!\s*\()')


# ── Утилиты парсинга ──────────────────────────────────────────────────────────

def parse_num(s):
    """'22 300,0' → 22300.0; 'не предусм.' / 'нет данных' / '' → None."""
    if s is None:
        return None
    t = str(s).strip().lower()
    if not t:
        return None
    if 'предусм' in t or 'нет данн' in t or t == '—' or t == '-':
        return None
    t = (t.replace('\u00a0', '')
          .replace(' ', '')
          .replace(',', '.'))
    try:
        return float(t)
    except ValueError:
        return None


def parse_zone_and_zu(cell):
    """
    'Г-1.4 (:ЗУ 149)' → ('Г-1.4', '149')
    'К-1.5 (:ЗУ 156)' → ('К-1.5', '156')
    ' О-1.2  :ЗУ 148' → ('О-1.2', '148')
    Кириллица из pdfplumber может быть как '?'. Возвращаем zone и zu как есть.
    """
    if not cell:
        return None, None
    s = str(cell).replace('\n', ' ').strip()
    # Зона: «X-N» или «X-N.N»
    m_zone = re.search(r'([А-ЯA-Z?]{1,3})-(\d+(?:\.\d+)?)', s)
    zone = (m_zone.group(1) + '-' + m_zone.group(2)) if m_zone else None
    # ЗУ: «:ЗУ 149», «:ЗУ149», «:ЗУ40/чзу1». Кириллица → '?'.
    m_zu = re.search(r':[А-Яа-я?A-Za-z]{1,3}\s*(\d+(?:[/_][А-Яа-я?A-Za-z]+\d*)?)', s)
    zu = m_zu.group(1) if m_zu else None
    return zone, zu


def detect_column_map(header_rows):
    """
    Принимает первые 2-3 строки таблицы pdfplumber.
    Ищет строку с номерами колонок (3, 4, 5, ..., 47).
    Возвращает dict { pdf_column_no: cell_index }.
    """
    for row in header_rows:
        if not row:
            continue
        # Строка номеров — много коротких числовых ячеек
        nums = []
        for idx, cell in enumerate(row):
            if cell is None:
                nums.append((idx, None))
                continue
            t = str(cell).strip()
            if t.isdigit() and 1 <= int(t) <= 99:
                nums.append((idx, int(t)))
            else:
                nums.append((idx, None))
        valid = [(i, n) for i, n in nums if n is not None]
        if len(valid) >= 10:  # эвристика: достаточно колонок-чисел
            return {n: i for i, n in valid}
    return None


# ── Парсинг PDF ──────────────────────────────────────────────────────────────

def parse_pdf(pdf_path: Path, verbose: bool = False):
    """
    Возвращает список dict:
      { 'code': 'Г_101', 'queue': '1', 'zone_code': 'Г-1.4',
        'zu_code': '149', 'metrics': {<metric_code>: value, ...} }
    """
    rows_out = []
    section_prefix = None  # последний префикс заголовка секции (Г/К/Х/...)

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                if not table or len(table) < 3:
                    continue
                col_map = detect_column_map(table[:4])
                if not col_map:
                    if verbose:
                        print(f'[skip] page {page.page_number} table — no column header')
                    continue
                if verbose:
                    print(f'[OK] column map (first 5): '
                          f'{dict(list(col_map.items())[:5])}, total {len(col_map)} cols')

                for row in table:
                    if not row:
                        continue
                    row_text = ' '.join(str(c) for c in row if c)

                    # Заголовок секции «Зона ... Г-1» — обновляем section_prefix
                    if 'Зона' in row_text or 'зона' in row_text or 'ОЧЕРЕДЬ' in row_text:
                        m = SECTION_HEAD_RE.search(row_text)
                        if m:
                            section_prefix = m.group(1)
                            if verbose:
                                print(f'[section] prefix={section_prefix} '
                                      f'from "{row_text[:80]}"')
                        continue

                    # Строка ИТОГО — пропускаем (агрегаты считаем в view)
                    if 'ИТОГО' in row_text or 'итого' in row_text:
                        continue

                    # Первая ячейка — code объекта (Г_101, К_103) или '?_101' в pdfplumber
                    code_cell = row[0]
                    if not code_cell:
                        continue
                    code_str = str(code_cell).strip()
                    m_code = re.match(r'^([А-ЯA-Z?]{1,3})_(\d+)$', code_str)
                    if not m_code:
                        continue  # не строка объекта
                    num_part = m_code.group(2)
                    prefix = section_prefix or m_code.group(1)
                    # Если префикс был распознан в section и буква не '?'
                    if prefix == '?' or not prefix:
                        # fallback: пропускаем строки где не смогли определить зону
                        if verbose:
                            print(f'[skip] cannot resolve prefix for code {code_str}')
                        continue
                    obj_code = f'{prefix}_{num_part}'

                    # Очередь — колонка 'Очередность реализации' (~ индекс 6 в таблице)
                    queue = None
                    for cell in row:
                        if cell and str(cell).strip() in QUEUE_VALUES:
                            queue = str(cell).strip()
                            break

                    # Зона и ЗУ — колонка 4
                    zone_cell = row[col_map.get(4, -1)] if col_map.get(4) is not None and col_map.get(4) < len(row) else None
                    zone_code, zu_code = parse_zone_and_zu(zone_cell)

                    # Метрики
                    metrics = {}
                    for pdf_col, (metric_code, source) in COL_METRIC.items():
                        idx = col_map.get(pdf_col)
                        if idx is None or idx >= len(row):
                            continue
                        cell = row[idx]
                        if metric_code in TEXT_METRICS:
                            if cell:
                                t = str(cell).strip()
                                if t and 'предусм' not in t.lower() and 'нет данн' not in t.lower():
                                    metrics[(metric_code, source)] = ('text', t)
                        else:
                            v = parse_num(cell)
                            if v is not None:
                                metrics[(metric_code, source)] = ('num', v)

                    rows_out.append({
                        'code': obj_code,
                        'queue': queue,
                        'zone_code': zone_code,
                        'zu_code': zu_code,
                        'metrics': metrics,
                    })

                    if verbose:
                        print(f'[row] {obj_code} q={queue} zone={zone_code} '
                              f'zu={zu_code} metrics={len(metrics)}')

    return rows_out


# ── Запись в БД ──────────────────────────────────────────────────────────────

def ensure_document(sb, pdf_path: Path, dry_run: bool):
    """SELECT-or-INSERT в documents для нашего PDF."""
    existing = (sb.table('documents')
                  .select('id, title, version')
                  .eq('title', DOC_TITLE)
                  .eq('version', DOC_VERSION)
                  .execute().data)
    if existing:
        return existing[0]
    if dry_run:
        return {'id': '00000000-0000-0000-0000-000000000000', 'title': DOC_TITLE, 'version': DOC_VERSION}
    inserted = (sb.table('documents').insert({
        'type': DOC_TYPE,
        'title': DOC_TITLE,
        'version': DOC_VERSION,
        'folder_path': f'ИРД/{pdf_path.name}',
    }).execute().data)
    return inserted[0]


def upsert_row(sb, row, doc_id, fo_by_zone, plots_by_code, stats, dry_run, verbose):
    """Создаёт / обновляет masterplan_objects и метрики для одной строки PDF."""
    code = row['code']
    metrics = row['metrics']
    if dry_run:
        stats['objects'] += 1
        stats['metrics'] += len(metrics)
        if row['zone_code']:
            stats['zones'] += 1
            if row['zone_code'] not in fo_by_zone:
                stats['unresolved_zones'].add(row['zone_code'])
        if row['zu_code']:
            zu_key = f':ЗУ{row["zu_code"]}'
            stats['plots'] += 1
            if zu_key not in plots_by_code:
                stats['unresolved_plots'].add(row['zu_code'])
        return

    # UPSERT masterplan_objects (по code)
    existing = (sb.table('masterplan_objects')
                  .select('id, queue')
                  .eq('code', code)
                  .execute().data)
    if existing:
        obj_id = existing[0]['id']
        sb.table('masterplan_objects').update({
            'queue': row['queue'],
            'source_document_id': doc_id,
            'updated_at': datetime.datetime.utcnow().isoformat() + 'Z',
        }).eq('id', obj_id).execute()
    else:
        ins = sb.table('masterplan_objects').insert({
            'code': code,
            'name_ppt': code,  # placeholder — кириллица из PDF не парсится
            'queue': row['queue'],
            'source_document_id': doc_id,
        }).execute().data
        obj_id = ins[0]['id']

    stats['objects'] += 1

    # Junction с functional_objects
    if row['zone_code']:
        fo_id = fo_by_zone.get(row['zone_code'])
        if fo_id:
            sb.table('masterplan_object_functional_objects').upsert({
                'masterplan_object_id': obj_id,
                'functional_object_id': fo_id,
            }, on_conflict='masterplan_object_id,functional_object_id').execute()
            stats['zones'] += 1
        else:
            stats['unresolved_zones'].add(row['zone_code'])

    # Junction с plots
    if row['zu_code']:
        zu_key = f':ЗУ{row["zu_code"]}'
        plot_id = plots_by_code.get(zu_key)
        if plot_id:
            sb.table('masterplan_object_plots').upsert({
                'masterplan_object_id': obj_id,
                'plot_id': plot_id,
            }, on_conflict='masterplan_object_id,plot_id').execute()
            stats['plots'] += 1
        else:
            stats['unresolved_plots'].add(row['zu_code'])

    # Метрики
    today = datetime.date.today().isoformat()
    metric_rows = []
    for (metric_code, source), (vtype, value) in metrics.items():
        rec = {
            'masterplan_object_id': obj_id,
            'metric_code': metric_code,
            'source': source,
            'source_document_id': doc_id,
            'valid_from': today,
        }
        if vtype == 'text':
            rec['value_text'] = value
        else:
            rec['value_num'] = value
        metric_rows.append(rec)

    if metric_rows:
        sb.table('masterplan_object_metrics').insert(metric_rows).execute()
        stats['metrics'] += len(metric_rows)

    if verbose:
        print(f'  [+] {code}: {len(metric_rows)} metrics, zone={row["zone_code"]}, zu={row["zu_code"]}')


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='Import TEP PDF → masterplan_objects')
    ap.add_argument('--pdf', default=PDF_PATH_DEFAULT, help='Path to TEP PDF')
    ap.add_argument('--dry-run', action='store_true', help='Не писать в БД')
    ap.add_argument('--verbose', action='store_true', help='Печать каждой строки')
    args = ap.parse_args()

    sb = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(f'ERROR: PDF не найден: {pdf_path}', file=sys.stderr)
        sys.exit(1)

    # 1) Документ-источник
    doc_row = ensure_document(sb, pdf_path, args.dry_run)
    doc_id = doc_row['id']
    print(f'[OK] Document: {doc_id} "{DOC_TITLE}" {DOC_VERSION}'
          f'{" (DRY-RUN)" if args.dry_run else ""}')

    # 2) Парсинг PDF
    rows = parse_pdf(pdf_path, args.verbose)
    print(f'[OK] Parsed rows: {len(rows)}')

    # 3) Кэш справочников
    fo_by_zone = {r['zone_code']: r['id']
                  for r in sb.table('functional_objects').select('id, zone_code').execute().data}
    plots_by_code = {r['code']: r['id']
                     for r in sb.table('plots').select('id, code').execute().data}
    print(f'[OK] Cache: {len(fo_by_zone)} functional_objects, {len(plots_by_code)} plots')

    # 4) Импорт
    stats = {
        'objects': 0, 'metrics': 0, 'zones': 0, 'plots': 0,
        'unresolved_zones': set(), 'unresolved_plots': set(),
    }
    for row in rows:
        try:
            upsert_row(sb, row, doc_id, fo_by_zone, plots_by_code,
                       stats, args.dry_run, args.verbose)
        except Exception as e:
            print(f'[ERROR] row {row.get("code")}: {e}', file=sys.stderr)

    print()
    print(f'[DONE] objects={stats["objects"]} metrics={stats["metrics"]} '
          f'zone_links={stats["zones"]} plot_links={stats["plots"]}')
    if stats['unresolved_zones']:
        print(f'[WARN] zone_code не найден в functional_objects: '
              f'{sorted(stats["unresolved_zones"])}')
    if stats['unresolved_plots']:
        print(f'[WARN] :ЗУ не найден в plots: '
              f'{sorted(stats["unresolved_plots"])}')
    if args.dry_run:
        print('[DRY-RUN] ничего не записано в БД')


if __name__ == '__main__':
    main()