"""
movement_importer.py — импорт записей «Движение проекта» в events.

Парсит файлы D:/Dropbox/Obsidian/Tigra/ЗПР/ПОДРЯДЧИКИ/[*/]Движение проекта.md,
формирует event_type='project_note' с привязкой к объектам и юр.лицу-подрядчику.

Запуск:
  python movement_importer.py --dry-run    # показать что будет вставлено
  python movement_importer.py              # боевой импорт
"""

import sys
import re
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

ROOT = Path(r'D:\Dropbox\Obsidian\Tigra\ЗПР\ПОДРЯДЧИКИ')

MONTHS = {
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'мая': 5, 'мае': 5,
    'июн': 6, 'июл': 7, 'август': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
}

# Подрядчик-папка → имя legal_entity для поиска
CONTRACTOR_FOLDER_TO_LE = {
    'ХэдсГрупп':  'ООО «Хэдс Групп»',
    'МЛА+':        'ООО «МЛА+»',
    'Бюро82':      'ИП Симоненко (Бюро 82)',
    '8D':          None,  # нет в legal_entities
    None:          None,  # общий файл
}

# Маппинг из «номер объекта» → код в БД (берём из текста записи)
NUMBER_TO_CODE = {
    '02': '02_FAM_800', '03': '03_FAM_500', '04': '04_HLT_260',
    '06': '06_CLB_350', '07': '07_SEL_400', '08': '08_PRS_450',
}
# Маппинг «N номеров» → текущий objects.code (после ренаминга 2026-05-15: префикс 1 = 1-я очередь)
ROOMS_TO_CODE = {
    '800': '102_ГОСТИНИЦА_800', '500': '103_ГОСТИНИЦА_500',
    '260': '104_ГОСТИНИЦА_260', '350': '106_ГОСТИНИЦА_350',
    '400': '107_ГОСТИНИЦА_400', '450': '301_ОБЩЕЖИТИЕ_450',
}


def run_sql(sql: str) -> tuple[int, str, str]:
    cmd = ['docker', 'exec', '-i', 'supabase_db_zpr_code',
           'psql', '-U', 'postgres', '-d', 'postgres',
           '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t']
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True, encoding='utf-8')
    return p.returncode, p.stdout, p.stderr


def sql_str(s):
    if s is None or s == '':
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"


def sql_array_uuid(arr):
    if not arr:
        return "'{}'::uuid[]"
    items = ",".join("'" + str(x).replace("'", "''") + "'::uuid" for x in arr)
    return f"ARRAY[{items}]"


# ─── Резолверы ────────────────────────────────────────────────────────────────

_objects_cache: dict[str, str] = {}  # code → uuid
_legal_cache: dict[str, str] = {}    # name → uuid


def load_caches():
    rc, out, _ = run_sql("select id, code, aliases from objects;")
    if rc == 0:
        for line in out.strip().split('\n'):
            parts = line.split('|')
            if len(parts) < 3:
                continue
            uid, code, aliases_raw = parts[0].strip(), parts[1].strip(), parts[2].strip()
            _objects_cache[code] = uid
            try:
                aliases = json.loads(aliases_raw) if aliases_raw else []
                for a in aliases:
                    _objects_cache[a] = uid
            except Exception:
                pass

    rc, out, _ = run_sql("select id, name from legal_entities;")
    if rc == 0:
        for line in out.strip().split('\n'):
            parts = line.split('|')
            if len(parts) < 2:
                continue
            _legal_cache[parts[1].strip()] = parts[0].strip()


def resolve_object_id(code_or_alias: str) -> str | None:
    return _objects_cache.get(code_or_alias)


def resolve_legal_entity_id(name: str | None) -> str | None:
    return _legal_cache.get(name) if name else None


# ─── Парсер ──────────────────────────────────────────────────────────────────

DATE_RE = re.compile(
    r'^\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*(?:г\.?)?(?:[,\s]+(\d{1,2}):(\d{2}))?\s*$',
    re.IGNORECASE,
)


def parse_date_line(line: str) -> tuple[str, str | None] | None:
    """'28 апреля 2026г.' → ('2026-04-28', None); '27 апреля 2026, 14:41' → ('2026-04-27', '14:41')."""
    m = DATE_RE.match(line)
    if not m:
        return None
    day, month_word, year = int(m.group(1)), m.group(2).lower(), int(m.group(3))
    hh, mm = m.group(4), m.group(5)
    month = None
    for prefix, num in MONTHS.items():
        if month_word.startswith(prefix):
            month = num
            break
    if not month:
        return None
    iso = f'{year:04d}-{month:02d}-{day:02d}'
    time_str = f'{hh}:{mm}' if hh else None
    return iso, time_str


def parse_movements(file_path: Path) -> list[dict]:
    """Парсит .md → список записей {date, time, text}.

    Запись = строка с датой + последующие строки до следующей даты или EOF.
    Пустые строки между датой и текстом — игнорируем; внутри текста сохраняем."""
    lines = file_path.read_text(encoding='utf-8').splitlines()
    entries = []
    cur = None
    for ln in lines:
        parsed = parse_date_line(ln)
        if parsed:
            if cur is not None:
                cur['text'] = cur['text'].strip()
                if cur['text']:
                    entries.append(cur)
            cur = {'date': parsed[0], 'time': parsed[1], 'text': ''}
        else:
            if cur is not None:
                cur['text'] += ln + '\n'
    if cur is not None:
        cur['text'] = cur['text'].strip()
        if cur['text']:
            entries.append(cur)
    return entries


# ─── Извлечение объектов из текста ─────────────────────────────────────────

def extract_object_ids(text: str, default_codes: list[str]) -> list[str]:
    """Ищет упоминания объектов. Если нашли — возвращаем uuid'ы, иначе default."""
    found_codes: set[str] = set()

    # Паттерн "N номеров" — уверенный
    for rooms, code in ROOMS_TO_CODE.items():
        if re.search(rf'\b{rooms}\s*номер', text):
            uid = resolve_object_id(code)
            if uid:
                found_codes.add(uid)

    # Паттерн "объект NN" / "NN (МЛА+)" / "№NN"
    for num, legacy_code in NUMBER_TO_CODE.items():
        patterns = [
            rf'\bобъект[оаы]*\s*№?\s*0?{num}\b',
            rf'\b№\s*0?{num}\b',
            rf'\b0?{num}\s*\(',  # "06 (MLA+)" / "02 и 03 ("
        ]
        for p in patterns:
            if re.search(p, text, re.IGNORECASE):
                uid = resolve_object_id(legacy_code)
                if uid:
                    found_codes.add(uid)
                break

    # Прямые упоминания кодов (новые/legacy)
    for code in list(_objects_cache.keys()):
        if code in text:
            uid = _objects_cache[code]
            found_codes.add(uid)

    if found_codes:
        return list(found_codes)

    # Fallback — объекты по подрядчику
    return [resolve_object_id(c) for c in default_codes if resolve_object_id(c)]


CONTRACTOR_DEFAULT_OBJECTS = {
    'ХэдсГрупп':  ['02_FAM_800', '03_FAM_500', '04_HLT_260', '08_PRS_450'],
    'МЛА+':        ['06_CLB_350'],
    'Бюро82':      ['07_SEL_400'],
    '8D':          [],
    None:          [],  # общий — определяем из текста, fallback пустой
}


# ─── Title ──────────────────────────────────────────────────────────────────

def make_title(text: str, max_len: int = 90) -> str:
    """Первая строка без markdown-link/wikilink-вложений, обрезанная."""
    for line in text.split('\n'):
        cleaned = re.sub(r'!\[\[.*?\]\]', '', line)
        cleaned = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', cleaned)
        cleaned = cleaned.strip()
        if cleaned and not cleaned.startswith('http'):
            return cleaned[:max_len] + ('…' if len(cleaned) > max_len else '')
    return text[:max_len].strip()


# ─── Main ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    load_caches()
    print(f'objects cache: {len(_objects_cache)} ключей; legal_entities: {len(_legal_cache)}', file=sys.stderr)

    # Найти все файлы Движение проекта.md
    files = sorted(ROOT.rglob('Движение проекта.md'))
    print(f'Найдено файлов: {len(files)}', file=sys.stderr)

    all_records = []
    for f in files:
        # Подрядчик из пути ПОДРЯДЧИКИ/{contractor}/Движение проекта.md
        rel = f.relative_to(ROOT)
        parts = rel.parts
        contractor = parts[0] if len(parts) > 1 else None
        le_name = CONTRACTOR_FOLDER_TO_LE.get(contractor)
        le_id = resolve_legal_entity_id(le_name)
        default_codes = CONTRACTOR_DEFAULT_OBJECTS.get(contractor, [])

        entries = parse_movements(f)
        for e in entries:
            obj_ids = extract_object_ids(e['text'], default_codes)
            title = make_title(e['text'])
            all_records.append({
                'date': e['date'],
                'time': e['time'],
                'contractor_folder': contractor,
                'le_id': le_id,
                'le_name': le_name,
                'object_ids': obj_ids,
                'title': title,
                'note': e['text'],
                'source_file': str(rel),
            })

    print(f'\nВсего записей: {len(all_records)}\n', file=sys.stderr)

    # Таблица для dry-run
    if args.dry_run:
        print(f'{"Дата":<12} {"Время":<7} {"Подрядчик":<12} {"Объектов":<9} {"Title":<60}')
        print('-' * 100)
        for r in all_records:
            obj_count = len(r['object_ids'])
            ctr = r['contractor_folder'] or '(общий)'
            time_str = r.get('time') or '—'
            print(f"{r['date']:<12} {time_str:<7} {ctr:<12} {obj_count:<9} {r['title'][:60]:<60}")

        # Сводка
        from collections import Counter
        by_ctr = Counter(r['contractor_folder'] or '(общий)' for r in all_records)
        no_obj = sum(1 for r in all_records if not r['object_ids'])
        no_le = sum(1 for r in all_records if not r['le_id'])
        print(f'\nПо подрядчикам: {dict(by_ctr)}')
        print(f'Без объектов: {no_obj}, Без юр.лица: {no_le}')
        print('\n🚫 DRY-RUN — ничего не вставлено')
        return

    # Боевой импорт
    inserted = 0
    failed = 0
    for r in all_records:
        title_sql = sql_str(r['title'])
        note_sql = sql_str(r['note'])
        date_sql = sql_str(r['date'])
        objs_sql = sql_array_uuid(r['object_ids'])

        # INSERT events (event_time из заголовка записи если был)
        time_sql = sql_str(r.get('time')) if r.get('time') else 'NULL'
        sql = f"""
        insert into events (event_type, title, date_mode, date_start, date_end, event_time, is_planned, fact_date, object_ids, stage_name, note)
        values ('project_note', {title_sql}, 'absolute', {date_sql}::date, {date_sql}::date, {time_sql}::time, false, {date_sql}::date, {objs_sql}, NULL, {note_sql})
        returning id::text;
        """
        rc, out, err = run_sql(sql)
        if rc != 0:
            print(f"❌ {r['date']} «{r['title'][:50]}»: {err.strip()[:150]}", file=sys.stderr)
            failed += 1
            continue
        event_id = out.strip()

        # entity_links: event → legal_entity (assignee)
        if r['le_id']:
            run_sql(f"""
            insert into entity_links (from_type, from_id, to_type, to_id, link_type)
            values ('event', {sql_str(event_id)}, 'legal_entity', {sql_str(r['le_id'])}, 'assigned_to')
            on conflict do nothing;
            """)

        inserted += 1

    print(f'✅ Вставлено: {inserted}, ошибок: {failed}', file=sys.stderr)


if __name__ == '__main__':
    main()
