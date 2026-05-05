"""
⚠️ НЕ ОТТЕСТИРОВАНО — написано 2026-04-27 в рамках перевода workflow на БД.
   Использовать после /protocol-tasks. Безопасный dry-run: добавить флаг --list.

tasks_approve.py — переводит preliminary-задачи собрания в open

Используется командой /protocol-build после ревью пользователя.
Принимает source_protocol (например ПРОТ-2026-04-24-XXX) — переводит все
оставшиеся preliminary в open.

Запуск:
  python tasks_approve.py ПРОТ-2026-04-24-XXX
  python tasks_approve.py ПРОТ-2026-04-24-XXX --list  # только показать, без изменений
"""

import sys
import argparse
import subprocess
import json


def run_sql(sql: str) -> tuple[int, str, str]:
    cmd = ['docker', 'exec', '-i', 'supabase_db_zpr_code',
           'psql', '-U', 'postgres', '-d', 'postgres',
           '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t']
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True, encoding='utf-8')
    return p.returncode, p.stdout, p.stderr


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source_protocol', help='ПРОТ-YYYY-MM-DD-{КОД}')
    parser.add_argument('--list', action='store_true', help='Только показать, не менять')
    args = parser.parse_args()

    src = args.source_protocol.replace("'", "''")

    # Сводка до утверждения
    rc, out, _ = run_sql(f"""
    select status, count(*) from tasks
    where source_protocol = '{src}'
    group by status order by 1;
    """)
    print(f'Задачи по протоколу {args.source_protocol}:')
    for line in out.strip().split('\n'):
        if line.strip():
            print(f'  {line}')

    if args.list:
        return

    # Утверждение: preliminary → open
    rc, out, err = run_sql(f"""
    update tasks set status = 'open'
    where source_protocol = '{src}' and status = 'preliminary'
    returning code;
    """)
    if rc != 0:
        print(f'ERROR: {err.strip()}', file=sys.stderr)
        sys.exit(1)
    approved = [c.strip() for c in out.strip().split('\n') if c.strip()]
    print(f'\n✅ Утверждено: {len(approved)}')


if __name__ == '__main__':
    main()
