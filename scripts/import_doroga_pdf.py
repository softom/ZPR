#!/usr/bin/env python
"""
scripts/import_doroga_pdf.py

Импорт данных ПМТ/ППТ ДОРОГА из PDF.

Обрабатывает:
  Том 3.2 — ПМТ-ОЧ-ПЗ (проект межевания, пояснительная записка)
    Приложение 1: Перечень образуемых/изменяемых ЗУ (13 колонок)
    Приложение 2: Характеристики существующих ЗУ (9 колонок)
    Приложение 3: ЗУ с характеристиками застройки (15 колонок)
    Приложение 4: Территории общего пользования (10 колонок)
    Приложение 5: Охраняемые ЗУ (10 колонок)
    Приложение 6+: Координаты характерных точек (3 колонки: №, X, Y)

  Том 1.2 — ППТ-ОЧ-ПЗ (проект планировки, пояснительная записка)
    Приложение 1-2: Координаты границ территории проекта

Использование:
  python scripts/import_doroga_pdf.py                   # парсинг всех томов
  python scripts/import_doroga_pdf.py --dry-run          # без записи в БД
  python scripts/import_doroga_pdf.py --verbose          # печать каждой строки
  python scripts/import_doroga_pdf.py --tom 3.2          # только Том 3.2
  python scripts/import_doroga_pdf.py --export-csv       # экспорт в CSV

Источник: D:\\Dropbox\\ЗПР\\ИРД\\03_ППТ_ПМТ_ДОРОГА_ЗПР
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import datetime
from pathlib import Path
from typing import Optional

# Добавляем корень репо в путь, чтобы import config работал из scripts/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pdfplumber  # noqa: E402

# ── Константы ────────────────────────────────────────────────────────────────

BASE_DIR = Path(r'D:\Dropbox\ЗПР\ИРД\03_ППТ_ПМТ_ДОРОГА_ЗПР')

PDF_PATHS = {
    '1.2': BASE_DIR / '2_ППТ-ОЧ-ПЗ_ДОРОГА_ЗПР' / 'Том 1.2 раздел 2.pdf',
    '3.2': BASE_DIR / '6_ПМТ_ОЧ_ПЗ_ДОРОГА_ЗПР' / 'Том 3.2 раздел 2.pdf',
}


# ── Утилиты ──────────────────────────────────────────────────────────────────

def parse_num(s: str | None) -> float | None:
    """'22 300,0' → 22300.0; пустые/текстовые → None."""
    if s is None:
        return None
    t = str(s).strip().lower()
    if not t or t == '-' or t == '—' or t == '~':
        return None
    t = (t.replace(' ', '')
          .replace(' ', '')
          .replace(',', '.'))
    try:
        return float(t)
    except ValueError:
        return None


def clean_text(s: str | None) -> str | None:
    """Очистка текста ячейки: убираем переносы строк, лишние пробелы."""
    if s is None or str(s).strip() in ('', '~', '-', '—'):
        return None
    return ' '.join(str(s).split())


def detect_num_header(rows, min_cols=3):
    """
    Ищет строку-нумерацию (1, 2, 3, ...) среди первых строк таблицы.
    Возвращает (row_index, {col_number: cell_index}).
    """
    for ri, row in enumerate(rows[:5]):
        if not row:
            continue
        nums = []
        for ci, cell in enumerate(row):
            if cell is None:
                nums.append((ci, None))
                continue
            t = str(cell).strip()
            if t.isdigit() and 1 <= int(t) <= 99:
                nums.append((ci, int(t)))
            else:
                nums.append((ci, None))
        valid = [(ci, n) for ci, n in nums if n is not None]
        if len(valid) >= min_cols:
            return ri, {n: ci for ci, n in valid}
    return None, None


def is_data_row(row, col_map: dict, header_ri: int | None = None, row_index: int | None = None) -> bool:
    """Проверка, что строка содержит данные (первая колонка — число).
    Пропускает строку-нумерацию (header_ri) и строки до неё."""
    if not row or not col_map:
        return False
    # Пропускаем заголовочные строки (включая строку-нумерацию и строки до неё)
    if header_ri is not None and row_index is not None and row_index <= header_ri:
        return False
    idx = col_map.get(1)
    if idx is None or idx >= len(row):
        return False
    cell = row[idx]
    if cell is None:
        return False
    t = str(cell).strip()
    if not t or not t[0].isdigit():
        return False
    # Защита от ложных срабатываний: строка с номерами колонок
    # Если col_map содержит, скажем, колонки 1..13, а row_num==1 и col2 содержит '2'
    # и col3 содержит '3' — это строка нумерации, не данные
    row_num = int(t) if t.isdigit() else None
    if row_num is not None and row_num <= 3:
        col2 = get_cell(row, col_map, 2)
        col3 = get_cell(row, col_map, 3)
        if col2 and col3:
            t2 = str(col2).strip()
            t3 = str(col3).strip()
            if t2.isdigit() and t3.isdigit() and int(t2) == 2 and int(t3) == 3:
                return False  # это строка нумерации
    return True


def get_cell(row, col_map: dict, col_num: int) -> str | None:
    """Безопасное получение ячейки по номеру колонки."""
    idx = col_map.get(col_num)
    if idx is None or not row or idx >= len(row):
        return None
    return row[idx]


# ── Парсинг Приложения 1 (13 колонок) ───────────────────────────────────────

APPENDIX1_MARKER = 'Приложение 1'

def parse_appendix1(tables_by_page: list, verbose: bool) -> list[dict]:
    """
    Приложение 1: Перечень образуемых/изменяемых ЗУ.

    Колонки:
      1  — № п/п
      2  — Номер образуемого ЗУ на плане
      3  — Номера характерных точек
      4  — Условное обозначение (кадастровый номер)
      5  — Адрес (местоположение)
      6  — Площадь исходного ЗУ по ЕГРН, кв.м
      7  — Категория земель
      8  — Вид разрешенного использования (ВРИ)
      9  — Устанавливаемая категория земель
      10 — Устанавливаемый ВРИ
      11 — Площадь образуемых ЗУ, кв.м
      12 — Сведения об отнесении к территории общего пользования
      13 — Способ образования, примечания
    """
    rows_out = []

    for page_num, table in tables_by_page:
        if not table or len(table) < 3:
            continue

        # Проверяем, что это 13-колоночная таблица
        ncols = max(len(r) for r in table if r)
        if ncols != 13:
            continue

        header_ri, col_map = detect_num_header(table)
        if not col_map or len(col_map) < 10:
            continue

        # Проверяем что это нумерация 1..13
        if 13 not in col_map:
            continue

        for ri, row in enumerate(table):
            if not is_data_row(row, col_map, header_ri, ri):
                continue

            rec = {
                'appendix': 1,
                'page': page_num,
                'row_num': clean_text(get_cell(row, col_map, 1)),
                'plot_num_plan': clean_text(get_cell(row, col_map, 2)),
                'point_nums': clean_text(get_cell(row, col_map, 3)),
                'cadastral_designation': clean_text(get_cell(row, col_map, 4)),
                'address': clean_text(get_cell(row, col_map, 5)),
                'area_egrn_m2': parse_num(get_cell(row, col_map, 6)),
                'land_category': clean_text(get_cell(row, col_map, 7)),
                'vri_current': clean_text(get_cell(row, col_map, 8)),
                'land_category_new': clean_text(get_cell(row, col_map, 9)),
                'vri_new': clean_text(get_cell(row, col_map, 10)),
                'area_formed_m2': parse_num(get_cell(row, col_map, 11)),
                'public_territory': clean_text(get_cell(row, col_map, 12)),
                'formation_method': clean_text(get_cell(row, col_map, 13)),
            }
            rows_out.append(rec)

            if verbose:
                print(f'  [A1] row {rec["row_num"]}: '
                      f'plot={rec["plot_num_plan"]} '
                      f'cad={rec["cadastral_designation"]} '
                      f'area_egrn={rec["area_egrn_m2"]} '
                      f'area_new={rec["area_formed_m2"]}')

    return rows_out


# ── Парсинг Приложения 2 (9 колонок) ────────────────────────────────────────

def parse_appendix2(tables_by_page: list, verbose: bool) -> list[dict]:
    """
    Приложение 2: Характеристики существующих ЗУ.

    Колонки:
      1  — № п/п
      2  — Номер ЗУ на плане
      3  — Кадастровый номер
      4  — Адрес
      5  — Площадь по кадастру, кв.м
      6  — Этажность/тип
      7  — Категория земель
      8  — Вид использования
      9  — Примечания
    """
    rows_out = []

    for page_num, table in tables_by_page:
        if not table or len(table) < 3:
            continue

        ncols = max(len(r) for r in table if r)
        if ncols != 9:
            continue

        header_ri, col_map = detect_num_header(table)
        if not col_map or len(col_map) < 7:
            continue
        if 9 not in col_map:
            continue

        for ri, row in enumerate(table):
            if not is_data_row(row, col_map, header_ri, ri):
                continue

            rec = {
                'appendix': 2,
                'page': page_num,
                'row_num': clean_text(get_cell(row, col_map, 1)),
                'plot_num_plan': clean_text(get_cell(row, col_map, 2)),
                'cadastral_number': clean_text(get_cell(row, col_map, 3)),
                'address': clean_text(get_cell(row, col_map, 4)),
                'area_cadastral_m2': parse_num(get_cell(row, col_map, 5)),
                'storeys': clean_text(get_cell(row, col_map, 6)),
                'land_category': clean_text(get_cell(row, col_map, 7)),
                'land_use_type': clean_text(get_cell(row, col_map, 8)),
                'notes': clean_text(get_cell(row, col_map, 9)),
            }
            rows_out.append(rec)

            if verbose:
                print(f'  [A2] row {rec["row_num"]}: '
                      f'plot={rec["plot_num_plan"]} '
                      f'cad={rec["cadastral_number"]} '
                      f'area={rec["area_cadastral_m2"]}')

    return rows_out


# ── Парсинг Приложения 3 (15 колонок) ───────────────────────────────────────

def parse_appendix3(tables_by_page: list, verbose: bool) -> list[dict]:
    """
    Приложение 3: ЗУ с характеристиками для целей образования/изменения.

    Колонки:
      1  — № п/п
      2  — Номер ЗУ на плане
      3  — Кадастровый номер
      4  — Этажность
      5  — Адрес
      6  — Площадь по кадастру, кв.м
      7  — Предварительная площадь ЗУ
      8  — Предварительная площадь ЗУ на праве пользования
      9  — Площадь ОТ (территория отторжения)
      10 — Категория земель
      11 — Вид использования
      12 — Примечания
      13 — Ограничения / линии
      14 — Площадь сервитута
      15 — Сумма за изъятие
    """
    rows_out = []

    for page_num, table in tables_by_page:
        if not table or len(table) < 3:
            continue

        ncols = max(len(r) for r in table if r)
        if ncols != 15:
            continue

        header_ri, col_map = detect_num_header(table)
        if not col_map or len(col_map) < 10:
            continue
        if 15 not in col_map:
            continue

        for ri, row in enumerate(table):
            if not is_data_row(row, col_map, header_ri, ri):
                continue

            rec = {
                'appendix': 3,
                'page': page_num,
                'row_num': clean_text(get_cell(row, col_map, 1)),
                'plot_num_plan': clean_text(get_cell(row, col_map, 2)),
                'cadastral_number': clean_text(get_cell(row, col_map, 3)),
                'storeys': clean_text(get_cell(row, col_map, 4)),
                'address': clean_text(get_cell(row, col_map, 5)),
                'area_cadastral_m2': parse_num(get_cell(row, col_map, 6)),
                'area_preliminary_m2': parse_num(get_cell(row, col_map, 7)),
                'area_use_right_m2': parse_num(get_cell(row, col_map, 8)),
                'area_withdrawal_m2': parse_num(get_cell(row, col_map, 9)),
                'land_category': clean_text(get_cell(row, col_map, 10)),
                'land_use_type': clean_text(get_cell(row, col_map, 11)),
                'notes': clean_text(get_cell(row, col_map, 12)),
                'restrictions': clean_text(get_cell(row, col_map, 13)),
                'easement_area_m2': parse_num(get_cell(row, col_map, 14)),
                'compensation_sum': clean_text(get_cell(row, col_map, 15)),
            }
            rows_out.append(rec)

            if verbose:
                print(f'  [A3] row {rec["row_num"]}: '
                      f'plot={rec["plot_num_plan"]} '
                      f'cad={rec["cadastral_number"]} '
                      f'area_cad={rec["area_cadastral_m2"]} '
                      f'area_prelim={rec["area_preliminary_m2"]}')

    return rows_out


# ── Парсинг Приложения 4-5 (10 колонок) ─────────────────────────────────────

def parse_appendix4_5(tables_by_page: list, verbose: bool) -> list[dict]:
    """
    Приложения 4 и 5: Территории общего пользования и охраняемые ЗУ.

    Колонки:
      1  — № п/п
      2  — Номер ЗУ на плане
      3  — Кадастровый номер
      4  — Площадь, кв.м
      5  — Протяженность, пог.м
      6  — Адрес
      7  — Категория земель
      8  — Тип объекта
      9  — Этажность
      10 — Примечания
    """
    rows_out = []

    for page_num, table in tables_by_page:
        if not table or len(table) < 3:
            continue

        ncols = max(len(r) for r in table if r)
        if ncols != 10:
            continue

        header_ri, col_map = detect_num_header(table)
        if not col_map or len(col_map) < 7:
            continue
        if 10 not in col_map:
            continue

        for ri, row in enumerate(table):
            if not is_data_row(row, col_map, header_ri, ri):
                continue

            rec = {
                'appendix': 4,  # или 5, определяем по контексту
                'page': page_num,
                'row_num': clean_text(get_cell(row, col_map, 1)),
                'plot_num_plan': clean_text(get_cell(row, col_map, 2)),
                'cadastral_number': clean_text(get_cell(row, col_map, 3)),
                'area_m2': parse_num(get_cell(row, col_map, 4)),
                'length_m': parse_num(get_cell(row, col_map, 5)),
                'address': clean_text(get_cell(row, col_map, 6)),
                'land_category': clean_text(get_cell(row, col_map, 7)),
                'object_type': clean_text(get_cell(row, col_map, 8)),
                'storeys': clean_text(get_cell(row, col_map, 9)),
                'notes': clean_text(get_cell(row, col_map, 10)),
            }
            rows_out.append(rec)

            if verbose:
                print(f'  [A4/5] row {rec["row_num"]}: '
                      f'plot={rec["plot_num_plan"]} '
                      f'cad={rec["cadastral_number"]} '
                      f'area={rec["area_m2"]}')

    return rows_out


# ── Парсинг координатных таблиц ─────────────────────────────────────────────

COORD_HEADER_RE = re.compile(r'(?:описание|координат|характерн|границ)', re.I)
PLOT_NUM_RE = re.compile(r'(?:участ\w*|ЗУ)\s*[№#]?\s*(\d+)', re.I)

def parse_coordinates(tables_by_page: list, verbose: bool) -> list[dict]:
    """
    Координатные таблицы (3 колонки): № точки, X (м), Y (м).
    СК-63 зона 4. Встречаются в Том 1.2 и в Приложении 6+ Том 3.2.

    Возвращает список записей с plot_label (определяется из заголовка)
    и массивом точек.
    """
    all_points = []
    current_label = None

    for page_num, table in tables_by_page:
        if not table:
            continue

        ncols = max(len(r) for r in table if r)
        if ncols != 3:
            continue

        for row in table:
            if not row or len(row) < 3:
                continue

            # Заголовок ЗУ
            cell0 = str(row[0] or '').strip()
            cell1 = str(row[1] or '').strip()

            # Пропускаем заголовочные строки
            if COORD_HEADER_RE.search(cell0) or COORD_HEADER_RE.search(cell1):
                # Пытаемся извлечь номер ЗУ
                m = PLOT_NUM_RE.search(cell0)
                if m:
                    current_label = f'ЗУ{m.group(1)}'
                elif 'границ' in cell0.lower() and 'территори' in cell0.lower():
                    current_label = f'boundary_p{page_num}'
                continue

            if cell0 in ('№ точки', '№ точки ', '~') or cell1 in ('СК-63', 'СК-63 (зона 4)'):
                continue
            if cell0 in ('X, м', 'X, м ', 'Х, м') or cell1 in ('X, м', 'Y, м'):
                continue

            # Строка данных: № точки, X, Y
            pt_num = parse_num(cell0)
            x = parse_num(row[1])
            y = parse_num(row[2])

            if pt_num is not None and x is not None and y is not None:
                all_points.append({
                    'page': page_num,
                    'label': current_label or f'unknown_p{page_num}',
                    'point_num': int(pt_num),
                    'x': x,
                    'y': y,
                })

    if verbose and all_points:
        labels = set(p['label'] for p in all_points)
        print(f'  [COORD] {len(all_points)} points, {len(labels)} labels')

    return all_points


# ── Главный парсинг PDF ─────────────────────────────────────────────────────

def extract_all_tables(pdf_path: Path, max_pages: int = 999) -> list:
    """Извлекает все таблицы из PDF, возвращает [(page_num, table), ...]."""
    tables_by_page = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages[:max_pages]):
            page_num = i + 1
            tables = page.extract_tables()
            for t in tables:
                if t and len(t) >= 2:
                    tables_by_page.append((page_num, t))
    return tables_by_page


def parse_tom_32(verbose: bool = False) -> dict:
    """Парсинг Том 3.2 (ПМТ-ОЧ-ПЗ): все приложения."""
    pdf_path = PDF_PATHS['3.2']
    if not pdf_path.exists():
        print(f'ERROR: Том 3.2 не найден: {pdf_path}', file=sys.stderr)
        return {}

    print(f'[OK] Том 3.2: {pdf_path}')
    tables_by_page = extract_all_tables(pdf_path)
    print(f'[OK] Извлечено таблиц: {len(tables_by_page)}')

    result = {}

    # Приложение 1 (13 колонок)
    a1 = parse_appendix1(tables_by_page, verbose)
    print(f'[OK] Приложение 1 (образуемые ЗУ): {len(a1)} строк')
    result['appendix1'] = a1

    # Приложение 2 (9 колонок)
    a2 = parse_appendix2(tables_by_page, verbose)
    print(f'[OK] Приложение 2 (существующие ЗУ): {len(a2)} строк')
    result['appendix2'] = a2

    # Приложение 3 (15 колонок)
    a3 = parse_appendix3(tables_by_page, verbose)
    print(f'[OK] Приложение 3 (ЗУ с характеристиками): {len(a3)} строк')
    result['appendix3'] = a3

    # Приложения 4-5 (10 колонок)
    a4_5 = parse_appendix4_5(tables_by_page, verbose)
    print(f'[OK] Приложения 4-5 (общего пользования/охраняемые): {len(a4_5)} строк')
    result['appendix4_5'] = a4_5

    # Координаты (3 колонки)
    coords = parse_coordinates(tables_by_page, verbose)
    print(f'[OK] Координаты ЗУ: {len(coords)} точек')
    result['coordinates'] = coords

    return result


def parse_tom_12(verbose: bool = False) -> dict:
    """Парсинг Том 1.2 (ППТ-ОЧ-ПЗ): координаты границ."""
    pdf_path = PDF_PATHS['1.2']
    if not pdf_path.exists():
        print(f'ERROR: Том 1.2 не найден: {pdf_path}', file=sys.stderr)
        return {}

    print(f'[OK] Том 1.2: {pdf_path}')
    tables_by_page = extract_all_tables(pdf_path)
    print(f'[OK] Извлечено таблиц: {len(tables_by_page)}')

    coords = parse_coordinates(tables_by_page, verbose)
    print(f'[OK] Координаты границ: {len(coords)} точек')

    return {'coordinates': coords}


# ── Экспорт в CSV ────────────────────────────────────────────────────────────

def export_csv(data: dict, out_dir: Path):
    """Экспорт в CSV файлы по приложениям."""
    out_dir.mkdir(parents=True, exist_ok=True)

    for key, rows in data.items():
        if not rows:
            continue

        csv_path = out_dir / f'doroga_{key}.csv'
        fieldnames = list(rows[0].keys())

        with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=';')
            writer.writeheader()
            writer.writerows(rows)

        print(f'[CSV] {csv_path.name}: {len(rows)} строк')


# ── Запись в БД ──────────────────────────────────────────────────────────────

def _safe_int(v) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def upsert_to_db(data: dict, dry_run: bool = False):
    """Запись в Supabase: pmt_doroga_plots + pmt_doroga_coords."""
    import config  # type: ignore
    from supabase import create_client

    sb = create_client(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)

    def _insert_batch(table: str, records: list, batch_size: int = 100):
        for i in range(0, len(records), batch_size):
            sb.table(table).insert(records[i:i+batch_size]).execute()

    # Приложение 1 → pmt_doroga_plots
    a1_rows = data.get('appendix1', [])
    if a1_rows:
        records = [{
            'appendix': 1,
            'row_num': _safe_int(r.get('row_num')),
            'plot_num_plan': r.get('plot_num_plan'),
            'cadastral_designation': r.get('cadastral_designation'),
            'address': r.get('address'),
            'area_egrn_m2': r.get('area_egrn_m2'),
            'land_category': r.get('land_category'),
            'vri_current': r.get('vri_current'),
            'land_category_new': r.get('land_category_new'),
            'vri_new': r.get('vri_new'),
            'area_formed_m2': r.get('area_formed_m2'),
            'public_territory': r.get('public_territory'),
            'formation_method': r.get('formation_method'),
        } for r in a1_rows]

        if not dry_run:
            sb.table('pmt_doroga_plots').delete().eq('appendix', 1).execute()
            _insert_batch('pmt_doroga_plots', records)
        print(f'[DB] pmt_doroga_plots appendix=1: {len(records)} строк'
              f'{" (DRY-RUN)" if dry_run else ""}')

    # Приложение 2 → pmt_doroga_plots
    a2_rows = data.get('appendix2', [])
    if a2_rows:
        records = [{
            'appendix': 2,
            'row_num': _safe_int(r.get('row_num')),
            'plot_num_plan': r.get('plot_num_plan'),
            'cadastral_designation': r.get('cadastral_number'),
            'address': r.get('address'),
            'area_egrn_m2': r.get('area_cadastral_m2'),
            'land_category': r.get('land_category'),
            'vri_current': r.get('land_use_type'),
            'storeys': r.get('storeys'),
            'formation_method': r.get('notes'),
        } for r in a2_rows]

        if not dry_run:
            sb.table('pmt_doroga_plots').delete().eq('appendix', 2).execute()
            _insert_batch('pmt_doroga_plots', records)
        print(f'[DB] pmt_doroga_plots appendix=2: {len(records)} строк'
              f'{" (DRY-RUN)" if dry_run else ""}')

    # Приложение 3 → pmt_doroga_plots
    a3_rows = data.get('appendix3', [])
    if a3_rows:
        records = [{
            'appendix': 3,
            'row_num': _safe_int(r.get('row_num')),
            'plot_num_plan': r.get('plot_num_plan'),
            'cadastral_designation': r.get('cadastral_number'),
            'address': r.get('address'),
            'area_egrn_m2': r.get('area_cadastral_m2'),
            'area_formed_m2': r.get('area_preliminary_m2'),
            'area_preliminary_m2': r.get('area_preliminary_m2'),
            'area_use_right_m2': r.get('area_use_right_m2'),
            'area_withdrawal_m2': r.get('area_withdrawal_m2'),
            'land_category': r.get('land_category'),
            'vri_current': r.get('land_use_type'),
            'storeys': r.get('storeys'),
            'restrictions': r.get('restrictions'),
            'formation_method': r.get('notes'),
        } for r in a3_rows]

        if not dry_run:
            sb.table('pmt_doroga_plots').delete().eq('appendix', 3).execute()
            _insert_batch('pmt_doroga_plots', records)
        print(f'[DB] pmt_doroga_plots appendix=3: {len(records)} строк'
              f'{" (DRY-RUN)" if dry_run else ""}')

    # Приложения 4-5 → pmt_doroga_plots
    a4_5_rows = data.get('appendix4_5', [])
    if a4_5_rows:
        records = [{
            'appendix': r.get('appendix', 4),
            'row_num': _safe_int(r.get('row_num')),
            'plot_num_plan': r.get('plot_num_plan'),
            'cadastral_designation': r.get('cadastral_number'),
            'address': r.get('address'),
            'area_egrn_m2': r.get('area_m2'),
            'length_m': r.get('length_m'),
            'land_category': r.get('land_category'),
            'object_type': r.get('object_type'),
            'storeys': r.get('storeys'),
            'formation_method': r.get('notes'),
        } for r in a4_5_rows]

        if not dry_run:
            sb.table('pmt_doroga_plots').delete().in_('appendix', [4, 5]).execute()
            _insert_batch('pmt_doroga_plots', records)
        print(f'[DB] pmt_doroga_plots appendix=4/5: {len(records)} строк'
              f'{" (DRY-RUN)" if dry_run else ""}')

    # Координаты → pmt_doroga_coords
    all_coords = data.get('coordinates', [])
    if all_coords:
        records = [{
            'label': c['label'],
            'point_num': c['point_num'],
            'x': c['x'],
            'y': c['y'],
            'page': c.get('page'),
        } for c in all_coords]

        if not dry_run:
            # Truncate через delete all
            sb.table('pmt_doroga_coords').delete().neq('id', 0).execute()
            _insert_batch('pmt_doroga_coords', records, batch_size=200)
        print(f'[DB] pmt_doroga_coords: {len(records)} точек'
              f'{" (DRY-RUN)" if dry_run else ""}')


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='Import ДОРОГА PDF tables')
    ap.add_argument('--tom', choices=['1.2', '3.2', 'all'], default='all',
                    help='Какой том парсить (default: all)')
    ap.add_argument('--dry-run', action='store_true',
                    help='Не писать в БД')
    ap.add_argument('--verbose', action='store_true',
                    help='Печать каждой строки')
    ap.add_argument('--export-csv', action='store_true',
                    help='Экспорт в CSV (папка scripts/doroga_csv/)')
    ap.add_argument('--no-db', action='store_true',
                    help='Не пытаться писать в БД (только парсинг + CSV)')
    args = ap.parse_args()

    all_data = {}

    # Парсим нужные тома
    if args.tom in ('3.2', 'all'):
        d = parse_tom_32(args.verbose)
        all_data.update(d)

    if args.tom in ('1.2', 'all'):
        d = parse_tom_12(args.verbose)
        # Координаты из Том 1.2 добавляем отдельно
        if 'coordinates' in d:
            existing = all_data.get('coordinates', [])
            # Помечаем как boundary
            for pt in d['coordinates']:
                pt['label'] = f'road_boundary_{pt["label"]}'
            all_data['coordinates'] = existing + d['coordinates']

    # Сводка
    print()
    print('=' * 60)
    total = sum(len(v) for v in all_data.values())
    print(f'ИТОГО: {total} записей')
    for key, rows in all_data.items():
        print(f'  {key}: {len(rows)}')
    print('=' * 60)

    # Экспорт CSV
    if args.export_csv:
        csv_dir = Path(__file__).parent / 'doroga_csv'
        export_csv(all_data, csv_dir)

    # Запись в БД
    if not args.no_db and not args.export_csv:
        if args.dry_run:
            print('\n[DRY-RUN] Парсинг завершён, в БД ничего не записано.')
        else:
            print('\n[DB] Запись в БД...')
            try:
                upsert_to_db(all_data, args.dry_run)
            except Exception as e:
                print(f'[WARN] Ошибка записи в БД: {e}')
                print('[HINT] Используйте --export-csv для экспорта в CSV или --no-db')


if __name__ == '__main__':
    main()
