"""
tasks_importer.py — импорт задач из .md-файлов в Supabase

Шаги:
1. Сканирует все ПРОТ-*-ЗАД-*.md и ПРОТ-*-ВЫП-*.md в:
   - ОБЪЕКТЫ/*/Задачи/
   - ПОДРЯДЧИКИ/*/Задачи/
   - ПОДРЯДЧИКИ/*/Собрания/*/Задачи/
2. Парсит frontmatter, нормализует:
   - status:\\n  - done → status: done
   - DD.MM.YYYY → ISO date
   - Восстанавливает код подрядчика в имени, если потерян
3. Дедуплицирует по code (приоритет: status:done > канон > последний по mtime)
4. Вставляет в tasks + entity_links
5. Архивирует .md в _МИГРИРОВАНО/{дата_миграции}/

Запуск:
  python tasks_importer.py             # полный прогон с архивацией
  python tasks_importer.py --dry-run   # без записи и без архивации
  python tasks_importer.py --no-archive # импорт без архивации .md
"""

import sys
import re
import json
import argparse
import shutil
import subprocess
from pathlib import Path
from datetime import datetime, date

import yaml

sys.stdout.reconfigure(encoding='utf-8')

from config import BASE_DIR

# ─── Маппинг кодов подрядчиков — загрузка из business_data.yaml ───────────────
# Sensitive данные (имена, ИНН, привязка объектов) — в .gitignore + Dropbox.
# Шаблон: business_data.example.yaml.

_BUSINESS_DATA_PATH = Path(__file__).parent / 'business_data.yaml'

if not _BUSINESS_DATA_PATH.exists():
    raise FileNotFoundError(
        f'Не найден {_BUSINESS_DATA_PATH}.\n'
        'Скопируй business_data.example.yaml → business_data.yaml '
        'и заполни данными подрядчиков (или возьми из Dropbox/_secrets/zpr_code/).'
    )

_BD = yaml.safe_load(_BUSINESS_DATA_PATH.read_text(encoding='utf-8')) or {}

CONTRACTOR_FOLDER_TO_CODE: dict[str, str] = _BD.get('contractor_folder_to_code') or {}
CONTRACTOR_TO_OBJECTS: dict[str, list[str]] = _BD.get('contractor_to_objects') or {}

# legal_entities[*].name + aliases → short_code
ASSIGNEE_TO_CONTRACTOR: dict[str, str] = {}
for _e in (_BD.get('legal_entities') or []):
    _code = _e.get('short_code')
    if not _code:
        continue
    for _variant in [_e.get('name'), *(_e.get('aliases') or [])]:
        if _variant:
            ASSIGNEE_TO_CONTRACTOR[_variant] = _code

# ─── Парсинг frontmatter ──────────────────────────────────────────────────────

def parse_frontmatter(text: str) -> dict:
    """Парсит YAML frontmatter, поддерживая плоские строки, списки и многострочные значения."""
    m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
    if not m:
        return {}
    fm = {}
    current_key = None
    current_list = None
    for line in m.group(1).splitlines():
        # элемент списка
        if line.startswith('  - ') and current_list is not None:
            current_list.append(line[4:].strip().strip('"'))
            continue
        # начало нового ключа
        if ':' in line and not line.startswith(' '):
            if current_key and current_list is not None:
                # завершаем предыдущий список
                if len(current_list) == 1:
                    fm[current_key] = current_list[0]
                else:
                    fm[current_key] = current_list
                current_list = None
            k, _, v = line.partition(':')
            key = k.strip()
            val = v.strip()
            if val == '':
                # может быть начало списка
                current_key = key
                current_list = []
            else:
                fm[key] = val.strip('"')
                current_key = key
                current_list = None
    # завершаем последний список
    if current_key and current_list is not None:
        if len(current_list) == 1:
            fm[current_key] = current_list[0]
        elif current_list:
            fm[current_key] = current_list
    return fm


def parse_date(s: str) -> str | None:
    """Принимает '24.04.2026' / '2026-04-24' / '' → ISO YYYY-MM-DD или None."""
    if not s or s.strip() in ('', '—'):
        return None
    s = s.strip().strip('"')
    # уже ISO
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        return s
    # DD.MM.YYYY
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})$', s)
    if m:
        d, mo, y = m.groups()
        return f'{y}-{int(mo):02d}-{int(d):02d}'
    return None


# ─── Извлечение цитат из тела файла ───────────────────────────────────────────

def extract_quotes(text: str) -> list[dict]:
    """Цитаты из секции '## Цитаты из обсуждения' (или просто blockquotes)."""
    quotes = []
    for m in re.finditer(r'^>\s*(?:\*\*([^*]+)\*\*:?)?\s*[«"]?([^»"\n]+)[»"]?\s*$', text, re.MULTILINE):
        speaker = (m.group(1) or '').strip()
        quote_text = m.group(2).strip()
        if quote_text:
            quotes.append({'speaker_org': speaker, 'text': quote_text})
    return quotes


# ─── Определение объектов задачи ──────────────────────────────────────────────

def infer_object_codes(fm: dict, file_path: Path) -> list[str]:
    """Определяет коды объектов: явный object[s] из frontmatter > вывод из пути."""
    obj_field = fm.get('object', '').strip()
    objs_field = fm.get('objects')

    # 1. Явный массив objects
    if isinstance(objs_field, list) and objs_field:
        return [o.strip() for o in objs_field if o.strip()]

    # 2. all-XX → массив объектов подрядчика
    if obj_field.startswith('all-'):
        contractor_code = obj_field[4:].strip()
        return CONTRACTOR_TO_OBJECTS.get(contractor_code, [])

    # 3. all → empty (общая задача)
    if obj_field == 'all':
        return []

    # 4. Прямой код объекта
    if obj_field and re.match(r'^\d{2}_[A-Z]+_\d+', obj_field):
        return [obj_field]

    # 5. Вывод из пути файла
    parts = file_path.parts
    if 'ОБЪЕКТЫ' in parts:
        idx = parts.index('ОБЪЕКТЫ')
        if idx + 1 < len(parts):
            folder = parts[idx + 1]
            # 06_CLB_350 Отель 4 Club → 06_CLB_350
            m = re.match(r'^(\d{2}_[A-Z]+_\d+)', folder)
            if m:
                return [m.group(1)]

    if 'ПОДРЯДЧИКИ' in parts:
        idx = parts.index('ПОДРЯДЧИКИ')
        if idx + 1 < len(parts):
            ctr_folder = parts[idx + 1]
            ctr_code = CONTRACTOR_FOLDER_TO_CODE.get(ctr_folder)
            if ctr_code:
                return CONTRACTOR_TO_OBJECTS.get(ctr_code, [])

    return []


# ─── Восстановление кода в имени файла ────────────────────────────────────────

def restore_code(code: str, file_path: Path, fm: dict) -> str:
    """ПРОТ-2026-04-24-ЗАД-NN → ПРОТ-2026-04-24-{КОД}-ЗАД-NN."""
    if not code:
        return code
    # Уже содержит код подрядчика
    if re.match(r'^ПРОТ-\d{4}-\d{2}-\d{2}-(?:[А-ЯA-Z]+\d*)-(?:ЗАД|ВЫП)-\d+$', code):
        return code
    # Пробуем определить подрядчика
    parts = file_path.parts
    contractor_code = None
    if 'ПОДРЯДЧИКИ' in parts:
        idx = parts.index('ПОДРЯДЧИКИ')
        if idx + 1 < len(parts):
            contractor_code = CONTRACTOR_FOLDER_TO_CODE.get(parts[idx + 1])
    if not contractor_code:
        # попробуем по assignee
        assignee = fm.get('assignee', '').strip()
        contractor_code = ASSIGNEE_TO_CONTRACTOR.get(assignee)
    if contractor_code:
        # ПРОТ-{date}-ЗАД-{NN} → ПРОТ-{date}-{ctr}-ЗАД-{NN}
        new = re.sub(r'^(ПРОТ-\d{4}-\d{2}-\d{2})-(ЗАД|ВЫП)-(\d+)$',
                     rf'\1-{contractor_code}-\2-\3', code)
        return new
    return code


# ─── Нормализация status ──────────────────────────────────────────────────────

def normalize_status(s) -> str:
    if isinstance(s, list):
        # YAML-список ['done'] → 'done'
        return s[0].lower() if s else 'open'
    if not s:
        return 'open'
    s = str(s).strip().lower()
    if s in ('open', 'done', 'closed', 'cancelled', 'in_progress'):
        return s
    return 'open'


# ─── Извлечение source-протокола из имени ────────────────────────────────────

def extract_source_protocol(code: str) -> tuple[str, str | None]:
    """ПРОТ-2026-04-17-МЛА-ЗАД-01 → ('ПРОТ-2026-04-17-МЛА', '2026-04-17')."""
    m = re.match(r'^(ПРОТ-(\d{4}-\d{2}-\d{2})(?:-[А-ЯA-Z]+\d*)?)-(?:ЗАД|ВЫП)-\d+$', code)
    if m:
        return m.group(1), m.group(2)
    return code, None


# ─── Чтение задачи ────────────────────────────────────────────────────────────

def read_task(file_path: Path) -> dict:
    text = file_path.read_text(encoding='utf-8')
    fm = parse_frontmatter(text)

    code_raw = fm.get('code', '').strip()
    code = restore_code(code_raw, file_path, fm)

    source_proto, source_meeting_date = extract_source_protocol(code)

    # путь к собранию (если файл в Собрания/)
    parts = file_path.parts
    source_meeting_path = None
    if 'Собрания' in parts:
        idx = parts.index('Собрания')
        if idx + 1 < len(parts):
            source_meeting_path = '/'.join(parts[:idx + 2])

    obj_codes = infer_object_codes(fm, file_path)

    return {
        'code': code,
        'code_original': code_raw,
        'title': fm.get('title', '').strip(),
        'explanation': fm.get('explanation', '').strip(),
        'status': normalize_status(fm.get('status')),
        'priority': (fm.get('priority') or 'medium').strip().lower(),
        'assignee_org': fm.get('assignee', '').strip() or None,
        'object_codes': obj_codes,
        'due_date': parse_date(fm.get('due', '')),
        'done_date': parse_date(fm.get('done_date', '')),
        'done_note': fm.get('done_note', '').strip() or None,
        'source_protocol': source_proto,
        'source_meeting_date': source_meeting_date,
        'source_meeting_path': source_meeting_path,
        'migrated_from': str(file_path.relative_to(BASE_DIR)),
        'quotes': extract_quotes(text),
        'tags': fm.get('tags') if isinstance(fm.get('tags'), list) else (
            [fm['tags']] if fm.get('tags') else []),
        '_path': file_path,
        '_mtime': file_path.stat().st_mtime,
    }


# ─── Дедупликация ─────────────────────────────────────────────────────────────

def dedupe(tasks: list[dict]) -> tuple[list[dict], list[dict]]:
    """Возвращает (уникальные, дубли). Стратегия:
       1. status: done побеждает open
       2. в каноне (Подрядчики/{}/Задачи или ОБЪЕКТЫ/{}/Задачи) > в Собрании/.../Задачи
       3. позже изменённый > более старый
    """
    by_code: dict[str, list[dict]] = {}
    for t in tasks:
        by_code.setdefault(t['code'], []).append(t)

    keep, dupes = [], []
    for code, lst in by_code.items():
        if len(lst) == 1:
            keep.append(lst[0])
        else:
            def score(t):
                p = t['_path']
                in_canon = ('Собрания' not in p.parts)
                is_done = t['status'] == 'done'
                return (is_done, in_canon, t['_mtime'])
            lst.sort(key=score, reverse=True)
            keep.append(lst[0])
            dupes.extend(lst[1:])
    return keep, dupes


# ─── SQL helpers через docker exec ────────────────────────────────────────────

def run_sql(sql: str, label: str = '') -> tuple[int, str, str]:
    cmd = ['docker', 'exec', '-i', 'supabase_db_zpr_code',
           'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True, encoding='utf-8')
    return p.returncode, p.stdout, p.stderr


def sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"


def sql_array(arr):
    if not arr:
        return "'{}'::text[]"
    items = ",".join("'" + str(x).replace("'", "''") + "'" for x in arr)
    return f"ARRAY[{items}]::text[]"


def sql_jsonb(obj):
    return "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def insert_task(t: dict) -> bool:
    sql = f"""
    insert into tasks (
        code, title, explanation, status, priority, assignee_org,
        object_codes, due_date, done_date, done_note,
        source_protocol, source_meeting_date, source_meeting_path,
        migrated_from, quotes, tags
    ) values (
        {sql_str(t['code'])},
        {sql_str(t['title'])},
        {sql_str(t['explanation'])},
        {sql_str(t['status'])},
        {sql_str(t['priority'])},
        {sql_str(t['assignee_org'])},
        {sql_array(t['object_codes'])},
        {sql_str(t['due_date'])}::date,
        {sql_str(t['done_date'])}::date,
        {sql_str(t['done_note'])},
        {sql_str(t['source_protocol'])},
        {sql_str(t['source_meeting_date'])}::date,
        {sql_str(t['source_meeting_path'])},
        {sql_str(t['migrated_from'])},
        {sql_jsonb(t['quotes'])},
        {sql_array(t['tags'])}
    )
    on conflict (code) do nothing
    returning id;
    """
    rc, out, err = run_sql(sql)
    if rc != 0:
        print(f'  ❌ SQL error: {err.strip()[:200]}')
        return False
    return True


def insert_links(t: dict):
    """Создаёт entity_links для задачи."""
    # task → object
    for obj_code in t['object_codes']:
        sql = f"""
        insert into entity_links (from_type, from_id, to_type, to_id, link_type)
        values ('task', (select id::text from tasks where code = {sql_str(t['code'])}),
                'object', {sql_str(obj_code)}, 'belongs_to')
        on conflict do nothing;
        """
        run_sql(sql)


# ─── Главный поток ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-archive', action='store_true')
    args = parser.parse_args()

    # 1. Сбор файлов
    files = []
    for sub in ['ПОДРЯДЧИКИ', 'ОБЪЕКТЫ', '_ОБЩЕЕ']:
        d = BASE_DIR / sub
        if not d.exists():
            continue
        files.extend(d.rglob('ПРОТ-*-ЗАД-*.md'))
        files.extend(d.rglob('ПРОТ-*-ВЫП-*.md'))

    # фильтруем _МИГРИРОВАНО
    files = [f for f in files if '_МИГРИРОВАНО' not in f.parts]

    print(f'📋 Найдено файлов: {len(files)}')

    # 2. Чтение
    tasks, errors = [], []
    for f in files:
        try:
            tasks.append(read_task(f))
        except Exception as e:
            errors.append((f, str(e)))

    print(f'✅ Прочитано: {len(tasks)}, ошибки: {len(errors)}')
    for f, e in errors[:5]:
        print(f'   ⚠️  {f.relative_to(BASE_DIR)}: {e}')

    # 3. Дедуп
    keep, dupes = dedupe(tasks)
    print(f'🔁 После дедупа: {len(keep)} (дубликатов: {len(dupes)})')

    # 4. Импорт
    if args.dry_run:
        print('🚫 DRY-RUN — без записи в БД')
        # Сводка
        by_status = {}
        by_obj_count = {}
        for t in keep:
            by_status[t['status']] = by_status.get(t['status'], 0) + 1
            n = len(t['object_codes'])
            by_obj_count[n] = by_obj_count.get(n, 0) + 1
        print(f'   По статусам: {by_status}')
        print(f'   По кол-ву объектов: {by_obj_count}')
        # Покажем первые 5 для проверки
        print('\n   Примеры (первые 5):')
        for t in keep[:5]:
            print(f'   - {t["code"]} | {t["status"]:>5} | obj={t["object_codes"]} | {t["title"][:50]}')
        return

    inserted = 0
    failed = 0
    for t in keep:
        if insert_task(t):
            insert_links(t)
            inserted += 1
        else:
            failed += 1

    print(f'💾 Импортировано: {inserted}, ошибок: {failed}')

    # 5. Архивация
    if not args.no_archive and inserted > 0:
        archive_root = BASE_DIR / '_МИГРИРОВАНО' / datetime.now().strftime('%Y-%m-%d_tasks')
        archive_root.mkdir(parents=True, exist_ok=True)

        archived = 0
        # архивируем все файлы (включая дубликаты)
        for t in keep + dupes:
            src = t['_path']
            if not src.exists():
                continue
            rel = src.relative_to(BASE_DIR)
            dest = archive_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            archived += 1

        print(f'📦 Архивировано: {archived} → {archive_root.relative_to(BASE_DIR)}')

    # 6. Отчёт
    report = BASE_DIR / 'ОТЧЁТЫ' / f'Миграция_задач_{datetime.now().strftime("%Y-%m-%d")}.md'
    report.parent.mkdir(parents=True, exist_ok=True)
    with open(report, 'w', encoding='utf-8') as f:
        f.write(f'# Отчёт миграции задач — {datetime.now().strftime("%Y-%m-%d %H:%M")}\n\n')
        f.write(f'- Найдено файлов: **{len(files)}**\n')
        f.write(f'- Прочитано без ошибок: **{len(tasks)}**\n')
        f.write(f'- После дедупа: **{len(keep)}**\n')
        f.write(f'- Импортировано: **{inserted}**\n')
        f.write(f'- Дубликатов слито: **{len(dupes)}**\n\n')

        if dupes:
            f.write('## Удалённые дубликаты\n\n')
            for t in dupes:
                f.write(f'- `{t["code"]}` ← {t["migrated_from"]}\n')
            f.write('\n')

        if errors:
            f.write('## Ошибки чтения\n\n')
            for fn, e in errors:
                f.write(f'- {fn.relative_to(BASE_DIR)}: {e}\n')

    print(f'📄 Отчёт: {report.relative_to(BASE_DIR)}')


if __name__ == '__main__':
    main()
