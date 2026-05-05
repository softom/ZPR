"""
contacts_importer.py — импорт контактов из Участники.md в Supabase

Шаги:
1. Сканирует все Участники.md в ПОДРЯДЧИКИ/* (исключая _МИГРИРОВАНО/ и _шаблоны/)
2. Парсит таблицу: №, Организация, Роль, Представитель
3. Резолвит названия организаций через SQL find_legal_entity_by_alias() — единый
   справочник (legal_entities.name + legal_entities.aliases). Если организация
   не найдена ни по одному имени — создаёт новую без ИНН.
4. Расщепляет ФИО на last_name / first_name / middle_name (с поддержкой инициалов
   и порядка «Имя Фамилия»)
5. Дедуплицирует по (legal_entity_id, last_name, first_initial) — выбирает самую
   полную запись
6. INSERT в contacts (on conflict do nothing)
7. Пишет отчёт ОТЧЁТЫ/Миграция_контактов_{дата}.md

Запуск:
  python contacts_importer.py             # полный прогон
  python contacts_importer.py --dry-run   # без записи в БД
"""

import sys
import re
import argparse
import subprocess
from pathlib import Path
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

from config import BASE_DIR


# ─── Парсинг ФИО ──────────────────────────────────────────────────────────────

SURNAME_SUFFIXES = (
    'ов', 'ова', 'ев', 'ева', 'ёв', 'ёва', 'ин', 'ина', 'ын', 'ына',
    'ский', 'ская', 'цкий', 'цкая', 'ской', 'енко', 'юк', 'ук',
    'их', 'ых', 'ко',
)


def is_surname_like(token: str) -> bool:
    if not token:
        return False
    t = token.lower().rstrip('.')
    return any(t.endswith(s) for s in SURNAME_SUFFIXES)


def is_initial(token: str) -> bool:
    """А. / К.А. / И — одна-две буквы (с точками или без)."""
    return bool(re.match(r'^[А-ЯA-ZЁ]\.?[А-ЯA-ZЁ]?\.?$', token.strip()))


def parse_fio(raw: str) -> tuple[str, str, str]:
    """
    Возвращает (last_name, first_name, middle_name).

    Поддерживает:
    - «Антипов Артемий Юрьевич» → ('Антипов', 'Артемий', 'Юрьевич')
    - «Артём Ефимов»            → ('Ефимов', 'Артём', '')         (по суффиксам)
    - «Антипов А.»              → ('Антипов', 'А', '')
    - «Соколов К.А.»            → ('Соколов', 'К', 'А')
    - «Хайбуллин И.»            → ('Хайбуллин', 'И', '')
    """
    if not raw:
        return '', '', ''
    raw = re.sub(r'<br\s*/?>', ' ', raw).strip()
    raw = re.sub(r'\s+', ' ', raw)

    tokens = [t for t in raw.split(' ') if t]
    if not tokens:
        return '', '', ''

    if len(tokens) == 1:
        return tokens[0], '', ''

    if len(tokens) == 2:
        a, b = tokens
        # инициалы в одном из токенов
        if is_initial(b) and not is_initial(a):
            initial = b.replace('.', '')
            first = initial[:1] if initial else ''
            middle = initial[1:] if len(initial) > 1 else ''
            return a, first, middle
        if is_initial(a) and not is_initial(b):
            initial = a.replace('.', '')
            first = initial[:1] if initial else ''
            middle = initial[1:] if len(initial) > 1 else ''
            return b, first, middle
        # порядок по суффиксу
        if is_surname_like(a) and not is_surname_like(b):
            return a, b, ''
        if is_surname_like(b) and not is_surname_like(a):
            return b, a, ''
        # default: Last First
        return a, b, ''

    # 3+ токенов: классика Last First Middle
    return tokens[0], tokens[1], ' '.join(tokens[2:])


# ─── Парсинг Участники.md ─────────────────────────────────────────────────────

def _split_persons(cell: str) -> list[str]:
    """Разбивает ячейку с несколькими ФИО по <br>, ; или \\n."""
    return [s.strip() for s in re.split(r'<br\s*/?>|;|\n', cell) if s.strip()]


def parse_participants_table(path: Path, body: str) -> list[dict]:
    """
    Парсит таблицу участников из тела MD-документа.

    Поддерживает варианты:
    - 4 колонки: № / Организация / Роль / Представитель (Участники.md, ПРОТ-2026-04-03)
    - 3 колонки: № / Организация / Представитель (большинство ПРОТ-*.md)
    - Заголовок '## Участники' опционален.
    - Несколько ФИО в одной ячейке через <br> или ; .
    - Inline-формат 'Соколов К.А. — Начальник отдела…' переопределяет колонку Роль.
    - Заглушки '—' / 'РОЛЬ' / 'ОРГАНИЗАЦИЯ' игнорируются.

    Если в файле несколько таблиц — берём первую с подходящими колонками
    (содержит 'Организация' и 'Представитель' в заголовке).
    """
    rows = []
    in_target_table = False
    seen_header = False
    n_cols = 0
    role_col_idx = -1   # индекс колонки «Роль» (если есть)
    fio_col_idx = -1    # индекс колонки «Представитель»
    org_col_idx = -1

    for line in body.splitlines():
        stripped = line.strip()
        # Конец таблицы — пустая строка или новый ##-заголовок
        if not stripped.startswith('|'):
            if seen_header and rows:
                # пустая строка после данных — таблица закончилась
                # (но дальше может быть ещё одна — продолжаем сканировать,
                # она просто инициирует новый заголовок)
                in_target_table = False
                seen_header = False
            continue
        if '---' in stripped:
            continue

        cells = [c.strip() for c in stripped.strip('|').split('|')]

        # Заголовок таблицы — определяем колонки
        if not seen_header:
            cells_lower = [c.lower() for c in cells]
            has_org = any('организац' in c for c in cells_lower)
            has_fio = any(('представит' in c) or ('фио' in c) for c in cells_lower)
            if not has_org or not has_fio:
                continue  # это какая-то другая таблица — пропускаем
            seen_header = True
            in_target_table = True
            n_cols = len(cells)
            for i, c in enumerate(cells_lower):
                if 'организац' in c:
                    org_col_idx = i
                elif 'представит' in c or 'фио' in c:
                    fio_col_idx = i
                elif c in ('роль', 'role'):
                    role_col_idx = i
            continue

        if not in_target_table:
            continue

        if len(cells) < n_cols or org_col_idx < 0 or fio_col_idx < 0:
            continue

        org = cells[org_col_idx]
        fio_cell = cells[fio_col_idx]
        role_cell = cells[role_col_idx] if role_col_idx >= 0 else ''
        num = cells[0] if cells else ''

        # Шаблонные строки
        if 'ОРГАНИЗАЦИЯ' in org.upper() and len(org) < 25:
            continue
        if not org or org in ('—', '–', '-'):
            continue

        fios  = _split_persons(fio_cell)
        roles = _split_persons(role_cell) if role_cell else []
        if not fios:
            continue

        for i, person in enumerate(fios):
            if person in ('—', '–', '-', ''):
                continue
            # Inline-формат "ФИО — Должность" — em-dash, en-dash или hyphen
            inline = re.match(r'^([^\-–—]+?)\s*[\-–—]\s*(.+)$', person)
            if inline:
                fio_part = inline.group(1).strip()
                role_part = inline.group(2).strip()
            else:
                fio_part = person
                role_part = roles[i] if i < len(roles) else (roles[0] if roles else '')

            if role_part.strip().upper() in ('РОЛЬ', 'ОРГАНИЗАЦИЯ'):
                role_part = ''

            rows.append({
                'num': num,
                'org_raw': org,
                'role': role_part,
                'fio_raw': fio_part,
                'source': str(path.relative_to(BASE_DIR)),
            })
    return rows


def parse_participants_md(path: Path) -> list[dict]:
    """Парсит MD-файл и возвращает строки участников (см. parse_participants_table)."""
    text = path.read_text(encoding='utf-8')
    fm = re.match(r'^---\n.*?\n---\n', text, re.DOTALL)
    body = text[fm.end():] if fm else text
    return parse_participants_table(path, body)


# ─── Дедупликация ─────────────────────────────────────────────────────────────

def dedupe_contacts(records: list[dict]) -> list[dict]:
    """
    Группирует по (org, last_name_lower, first_initial). В каждой группе
    выбирает самую полную запись (max длина first+middle); job_title берётся
    у первой непустой.
    """
    by_key: dict[tuple, dict] = {}
    for r in records:
        first_initial = r['first_name'][:1].lower() if r['first_name'] else ''
        key = (r['org_canonical'], r['last_name'].lower(), first_initial)
        if key not in by_key:
            by_key[key] = dict(r)
        else:
            existing = by_key[key]
            r_score = len(r['first_name']) + len(r['middle_name'])
            e_score = len(existing['first_name']) + len(existing['middle_name'])
            if r_score > e_score:
                # обновляем имя/отчество, но сохраняем непустую должность
                kept_job_title = existing['job_title'] or r['job_title']
                by_key[key] = dict(r)
                by_key[key]['job_title'] = kept_job_title
            elif not existing['job_title'] and r['job_title']:
                existing['job_title'] = r['job_title']
    return list(by_key.values())


# ─── SQL helpers ──────────────────────────────────────────────────────────────

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


def resolve_legal_entity(raw_name: str) -> tuple[str | None, str | None]:
    """
    Резолвит организацию по любому варианту написания через SQL-функцию
    find_legal_entity_by_alias() — она проверяет name + aliases с нормализацией
    (lowercase, без кавычек, схлопнутые пробелы).

    Возвращает (legal_entity_id, resolved_name) или (None, None) если не найдено.
    """
    sql = (
        f'select le.id::text, le.name '
        f'from legal_entities le '
        f'where le.id = find_legal_entity_by_alias({sql_str(raw_name)});'
    )
    rc, out, err = run_sql(sql)
    if rc != 0:
        print(f'  ❌ SQL error (resolve {raw_name!r}): {err.strip()[:200]}')
        return None, None
    out = out.strip()
    if not out:
        return None, None
    parts = out.splitlines()[0].split('|')
    if len(parts) >= 2:
        return parts[0].strip(), parts[1].strip()
    return None, None


def create_legal_entity(name: str) -> str | None:
    """Создаёт новую организацию без ИНН/алиасов. Возвращает id."""
    sql = (
        f'insert into legal_entities (name) values ({sql_str(name)}) '
        f'on conflict do nothing returning id::text;'
    )
    rc, out, err = run_sql(sql)
    if rc != 0:
        print(f'  ❌ SQL error (create {name!r}): {err.strip()[:200]}')
        return None
    out = out.strip()
    return out.splitlines()[0].strip() if out else None


def insert_contact(c: dict, legal_entity_id: str) -> bool:
    """INSERT contact, on conflict do nothing. Возвращает True если вставлено."""
    sql = f"""
    insert into contacts (
        legal_entity_id, last_name, first_name, middle_name, job_title
    ) values (
        {sql_str(legal_entity_id)}::uuid,
        {sql_str(c['last_name'])},
        {sql_str(c['first_name'])},
        {sql_str(c['middle_name'])},
        {sql_str(c['job_title'])}
    )
    on conflict (legal_entity_id, last_name, first_name, coalesce(middle_name, ''))
    do nothing
    returning id;
    """
    rc, out, err = run_sql(sql)
    if rc != 0:
        print(f'  ❌ SQL error (insert): {err.strip()[:200]}')
        return False
    return bool(out.strip())


def update_contact(contact_id: str, first_name: str, middle_name: str | None, job_title: str | None) -> bool:
    """UPDATE existing contact с расширением ФИО/должности до более полной формы."""
    sql = f"""
    update contacts set
        first_name = {sql_str(first_name)},
        middle_name = {sql_str(middle_name)},
        job_title = coalesce(nullif(job_title, ''), {sql_str(job_title)})
    where id = {sql_str(contact_id)}::uuid
    returning id;
    """
    rc, out, err = run_sql(sql)
    if rc != 0:
        print(f'  ❌ SQL error (update): {err.strip()[:200]}')
        return False
    return bool(out.strip())


def load_existing_contacts() -> dict[tuple[str, str, str], dict]:
    """
    Загружает все contacts из БД, ключ = (legal_entity_id, last_name_lower, first_initial).
    Возвращает dict ключ → {id, last_name, first_name, middle_name, job_title}.
    """
    rc, out, err = run_sql(
        "select id::text, legal_entity_id::text, last_name, "
        "coalesce(first_name,''), coalesce(middle_name,''), coalesce(job_title,'') "
        "from contacts order by last_name;"
    )
    if rc != 0:
        print(f'  ❌ SQL error (load contacts): {err.strip()[:200]}')
        return {}
    existing: dict[tuple[str, str, str], dict] = {}
    for line in out.strip().splitlines():
        parts = line.split('|')
        if len(parts) < 6:
            continue
        cid, le_id, last, first, middle, job = [p.strip() for p in parts[:6]]
        first_initial = first[:1].lower()
        existing[(le_id, last.lower(), first_initial)] = {
            'id': cid,
            'last_name': last,
            'first_name': first,
            'middle_name': middle,
            'job_title': job,
        }
    return existing


# ─── Главный поток ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Импорт контактов из Участники.md в БД')
    parser.add_argument('--dry-run', action='store_true', help='Показать без записи в БД')
    args = parser.parse_args()

    # 1. Сбор файлов: Участники.md + ПРОТ-{дата}-{код}.md (без -ЗАД-/-ВЫП-)
    base = BASE_DIR / 'ПОДРЯДЧИКИ'
    participant_files = []
    protocol_files = []
    for f in base.rglob('Участники.md'):
        if '_МИГРИРОВАНО' in f.parts or '_шаблоны' in f.parts:
            continue
        participant_files.append(f)

    proto_re = re.compile(r'^ПРОТ-\d{4}-\d{2}-\d{2}-[^-]+\.md$', re.IGNORECASE)
    for f in base.rglob('ПРОТ-*.md'):
        if '_МИГРИРОВАНО' in f.parts or '_шаблоны' in f.parts:
            continue
        if '-ЗАД-' in f.name or '-ВЫП-' in f.name:
            continue
        if not proto_re.match(f.name):
            # запасная проверка для имён вроде ПРОТ-2026-04-03-HEADS GROUP.md
            if '-ЗАД-' in f.name or '-ВЫП-' in f.name:
                continue
        protocol_files.append(f)

    files = participant_files + protocol_files
    print(f'📋 Файлов Участники.md: {len(participant_files)}')
    for f in participant_files:
        print(f'   - {f.relative_to(BASE_DIR)}')
    print(f'📋 Файлов протоколов:   {len(protocol_files)}')
    for f in protocol_files:
        print(f'   - {f.relative_to(BASE_DIR)}')

    # 2. Парсинг
    raw_records = []
    for f in files:
        rows = parse_participants_md(f)
        for row in rows:
            if not row['org_raw'].strip():
                continue
            last, first, middle = parse_fio(row['fio_raw'])
            if not last and not first:
                # пустая строка ФИО — пропускаем
                continue
            raw_records.append({
                'org_raw': row['org_raw'],
                'last_name': last,
                'first_name': first,
                'middle_name': middle,
                'job_title': re.sub(r'<br\s*/?>', ' ', row['role']).strip(),
                'source': row['source'],
            })

    print(f'\n📝 Прочитано строк участников: {len(raw_records)}')

    # 3. Резолв организаций через SQL find_legal_entity_by_alias() — кэшируем
    print('\n🔍 Резолв организаций через aliases…')
    org_resolved: dict[str, tuple[str | None, str]] = {}  # raw → (id, canonical_name)
    unique_org_names = sorted({r['org_raw'].strip() for r in raw_records})
    for raw in unique_org_names:
        le_id, canonical = resolve_legal_entity(raw)
        if le_id:
            org_resolved[raw] = (le_id, canonical)
            print(f'   ✓ {raw!r:50} → {canonical}')
        else:
            org_resolved[raw] = (None, raw)  # будет создана позже
            print(f'   ✗ {raw!r:50} → (не найдена, создадим)')

    # Прокидываем результат в записи
    for r in raw_records:
        le_id, canonical = org_resolved[r['org_raw'].strip()]
        r['legal_entity_id'] = le_id
        r['org_canonical'] = canonical

    # 4. Дедуп
    contacts = dedupe_contacts(raw_records)
    print(f'\n🔁 После дедупа: {len(contacts)}')

    # Сводка по организациям
    by_org = {}
    for c in contacts:
        by_org[c['org_canonical']] = by_org.get(c['org_canonical'], 0) + 1
    print('\nПо организациям:')
    for org, cnt in sorted(by_org.items(), key=lambda x: -x[1]):
        print(f'  {cnt:3d}  {org}')

    if args.dry_run:
        print('\n🚫 DRY-RUN — без записи в БД')
        print('\nПолный список контактов:')
        for c in sorted(contacts, key=lambda x: (x['org_canonical'], x['last_name'])):
            full = f"{c['last_name']} {c['first_name']} {c['middle_name']}".strip()
            pos = c['job_title'][:40] if c['job_title'] else '—'
            print(f"  - [{c['org_canonical'][:30]:30}] {full:40} | {pos}")
        return

    # 5. Создание новых организаций (если есть нерезолвленные)
    for c in contacts:
        if not c.get('legal_entity_id'):
            le_id = create_legal_entity(c['org_canonical'])
            if le_id:
                for other in contacts:
                    if other.get('org_canonical') == c['org_canonical'] and not other.get('legal_entity_id'):
                        other['legal_entity_id'] = le_id

    # 6. Загрузка существующих контактов из БД для merge
    print('\n📥 Загрузка существующих контактов из БД…')
    existing = load_existing_contacts()
    print(f'   Уже в БД: {len(existing)}')

    # 7. Merge: для каждого нового контакта решаем INSERT/UPDATE/SKIP
    print('\n💾 Слияние и импорт…')
    inserted = 0
    updated = 0
    skipped = 0
    failed = 0

    for c in contacts:
        le_id = c.get('legal_entity_id')
        if not le_id:
            print(f'  ❌ Не удалось определить организацию для {c["last_name"]} {c["first_name"]}')
            failed += 1
            continue

        first_initial = c['first_name'][:1].lower() if c['first_name'] else ''
        key = (le_id, c['last_name'].lower(), first_initial)

        if key in existing:
            # Уже есть в БД — UPDATE если новая запись полнее
            ex = existing[key]
            new_score = len(c['first_name']) + len(c['middle_name'])
            ex_score = len(ex['first_name']) + len(ex['middle_name'])
            needs_update = (
                new_score > ex_score
                or (not ex['job_title'] and c['job_title'])
            )
            if needs_update:
                # Берём более полные ФИО, не понижаем существующие
                new_first  = c['first_name']  if new_score > ex_score else ex['first_name']
                new_middle = c['middle_name'] if new_score > ex_score else ex['middle_name']
                new_job    = ex['job_title'] or c['job_title']
                if update_contact(ex['id'], new_first, new_middle or None, new_job or None):
                    updated += 1
                    # обновляем кэш чтобы не перезаписывать ещё раз
                    existing[key]['first_name']  = new_first
                    existing[key]['middle_name'] = new_middle
                    existing[key]['job_title']   = new_job
                else:
                    failed += 1
            else:
                skipped += 1
        else:
            # Новый контакт — INSERT
            if insert_contact(c, le_id):
                inserted += 1
                # Регистрируем в кэше чтобы повторные дубли (с разной полнотой)
                # в текущем прогоне не вставлялись повторно
                existing[key] = {
                    'id': '',  # неизвестен; для последующих UPDATE надо будет повторно загрузить
                    'last_name': c['last_name'],
                    'first_name': c['first_name'],
                    'middle_name': c['middle_name'],
                    'job_title': c['job_title'],
                }
            else:
                skipped += 1

    print(f'\n✅ Вставлено новых: {inserted}, обновлено: {updated}, без изменений: {skipped}, ошибок: {failed}')

    # 5. Отчёт
    report = BASE_DIR / 'ОТЧЁТЫ' / f'Миграция_контактов_{datetime.now().strftime("%Y-%m-%d")}.md'
    report.parent.mkdir(parents=True, exist_ok=True)
    with open(report, 'w', encoding='utf-8') as f:
        f.write(f'# Отчёт миграции контактов — {datetime.now().strftime("%Y-%m-%d %H:%M")}\n\n')
        f.write(f'- Найдено файлов Участники.md: **{len(files)}**\n')
        f.write(f'- Прочитано строк: **{len(raw_records)}**\n')
        f.write(f'- После дедупа: **{len(contacts)}**\n')
        f.write(f'- Вставлено в БД: **{inserted}**\n')
        f.write(f'- Пропущено (уже было): **{skipped}**\n')
        f.write(f'- Ошибок: **{failed}**\n\n')

        f.write('## По организациям\n\n')
        f.write('| Организация | Контактов |\n')
        f.write('|---|---|\n')
        for org, cnt in sorted(by_org.items(), key=lambda x: -x[1]):
            f.write(f'| {org} | {cnt} |\n')
        f.write('\n')

        f.write('## Список контактов\n\n')
        f.write('| Организация | ФИО | Должность |\n')
        f.write('|---|---|---|\n')
        for c in sorted(contacts, key=lambda x: (x['org_canonical'], x['last_name'])):
            full = f"{c['last_name']} {c['first_name']} {c['middle_name']}".strip()
            f.write(f"| {c['org_canonical']} | {full} | {c['job_title'] or '—'} |\n")

    print(f'\n📄 Отчёт: {report.relative_to(BASE_DIR)}')


if __name__ == '__main__':
    main()
