"""
seed_business_data.py — применяет business_data.yaml к БД.

Шаги:
1. Читает business_data.yaml (sensitive, .gitignore).
2. INSERT в legal_entities (ON CONFLICT (inn) DO NOTHING).
3. Backfill tasks.assignee_entity_id для существующих задач — по соответствию
   tasks.assignee_org одному из aliases юр.лица.

Запуск:
  python seed_business_data.py
  python seed_business_data.py --dry  # показать SQL, без записи

Требует запущенного контейнера supabase_db_zpr_code (локальная Supabase).
"""

import argparse
import subprocess
import sys
from pathlib import Path

import yaml

sys.stdout.reconfigure(encoding='utf-8')

YAML_PATH = Path(__file__).parent / 'business_data.yaml'
DOCKER_CONTAINER = 'supabase_db_zpr_code'


def sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"


def run_sql(sql: str, dry: bool) -> int:
    if dry:
        print('--- SQL ---')
        print(sql)
        return 0
    cmd = ['docker', 'exec', '-i', DOCKER_CONTAINER,
           'psql', '-U', 'postgres', '-d', 'postgres',
           '-v', 'ON_ERROR_STOP=1']
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True, encoding='utf-8')
    if p.returncode != 0:
        print(f'[seed] ОШИБКА psql:\n{p.stderr}', file=sys.stderr)
        return p.returncode
    if p.stdout.strip():
        print(p.stdout)
    return 0


def build_legal_entities_sql(entities: list) -> str:
    rows = []
    for e in entities:
        if not e.get('inn'):
            continue
        rows.append(f"  ({sql_str(e['name'])}, {sql_str(e['inn'])}, "
                    f"{sql_str(e.get('kpp'))}, {sql_str(e.get('ogrn'))}, "
                    f"{sql_str(e.get('address'))}, "
                    f"{sql_str(e.get('signatory_name'))}, "
                    f"{sql_str(e.get('signatory_position'))})")
    if not rows:
        return ''
    return ('insert into legal_entities '
            '(name, inn, kpp, ogrn, address, signatory_name, signatory_position) values\n'
            + ',\n'.join(rows)
            + '\non conflict (inn) do nothing;')


def build_backfill_sql(entities: list) -> str:
    """UPDATE tasks SET assignee_entity_id по aliases каждого юр.лица."""
    branches = []
    for e in entities:
        inn = e.get('inn')
        if not inn:
            continue
        all_names = [e['name']] + list(e.get('aliases') or [])
        names_sql = ', '.join(sql_str(n) for n in all_names)
        branches.append(f"      (le.inn = {sql_str(inn)} and t.assignee_org in ({names_sql}))")
    if not branches:
        return ''
    return ('update tasks t\n'
            'set assignee_entity_id = le.id\n'
            'from legal_entities le\n'
            'where t.assignee_entity_id is null\n'
            '  and t.assignee_org is not null\n'
            '  and (\n'
            + '\n   or '.join(branches)
            + '\n  );')


def main() -> int:
    parser = argparse.ArgumentParser(description='Seed business data → БД')
    parser.add_argument('--dry', action='store_true', help='только показать SQL')
    args = parser.parse_args()

    if not YAML_PATH.exists():
        print(f'[seed] нет {YAML_PATH}. Скопируй business_data.example.yaml и заполни.',
              file=sys.stderr)
        return 1

    data = yaml.safe_load(YAML_PATH.read_text(encoding='utf-8')) or {}
    entities = data.get('legal_entities') or []
    if not entities:
        print('[seed] legal_entities пуст в yaml — нечего применять.')
        return 0

    insert_sql = build_legal_entities_sql(entities)
    if insert_sql:
        print(f'[seed] legal_entities: {sum(1 for e in entities if e.get("inn"))} записей')
        rc = run_sql(insert_sql, args.dry)
        if rc != 0:
            return rc

    backfill_sql = build_backfill_sql(entities)
    if backfill_sql:
        print('[seed] backfill tasks.assignee_entity_id...')
        rc = run_sql(backfill_sql, args.dry)
        if rc != 0:
            return rc

    print('[seed] готово.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
