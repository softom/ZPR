"""
⚠️ НЕ ОТТЕСТИРОВАНО — написано 2026-04-27 в рамках перевода workflow на БД.
   Перед первым реальным прогоном /protocol-tasks пройди по логике вручную:
   - проверь find_legal_entity_id (поиск по '«...»' fragile)
   - проверь sql_jsonb на цитатах с двойными кавычками
   - убедись, что docker контейнер supabase_db_zpr_code запущен
   - проверь UNIQUE conflict по code (skipped) на повторном прогоне

tasks_create_preliminary.py — вставка предварительных задач в БД из JSON

Используется командой /protocol-tasks: Claude извлекает задачи из транскрипции,
формирует JSON и передаёт через stdin. Скрипт вставляет в tasks со status='preliminary'
и создаёт связи в entity_links.

Формат входного JSON:
{
  "meeting_date": "2026-04-24",            // ISO
  "meeting_path": "ПОДРЯДЧИКИ/.../дата",   // относительный путь
  "source_protocol": "ПРОТ-2026-04-24-XXX",
  "tasks": [
    {
      "code": "ПРОТ-2026-04-24-XXX-ЗАД-01",
      "title": "...",
      "explanation": "...",
      "priority": "high",
      "assignee_org": "ООО «Подрядчик»",
      "object_codes": ["001_TYPE_VAL"],
      "due_date": "2026-05-01",            // или null
      "quotes": [{"speaker_org": "...", "text": "..."}]
    }
  ]
}

Вывод: JSON со списком созданных id и кодов.
"""

import json
import sys
import subprocess


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


def sql_array(arr):
    if not arr:
        return "'{}'::text[]"
    items = ",".join("'" + str(x).replace("'", "''") + "'" for x in arr)
    return f"ARRAY[{items}]::text[]"


def sql_jsonb(obj):
    return "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def find_legal_entity_id(name: str) -> str | None:
    """Находит legal_entities.id по точному или похожему имени организации."""
    if not name:
        return None
    sql = f"""
    select id::text from legal_entities
    where name = {sql_str(name)}
    union
    select id::text from legal_entities
    where name ilike {sql_str('%' + name.split('«')[1].split('»')[0] if '«' in name else name + '%')}
    limit 1;
    """
    rc, out, _ = run_sql(sql)
    if rc != 0:
        return None
    out = out.strip()
    return out if out else None


def main():
    data = json.load(sys.stdin)
    meeting_date = data.get('meeting_date')
    meeting_path = data.get('meeting_path')
    source_protocol = data.get('source_protocol')
    tasks = data.get('tasks', [])

    created = []
    skipped = []

    for t in tasks:
        code = t['code']
        # Проверяем, нет ли уже такого кода
        rc, out, _ = run_sql(f"select 1 from tasks where code = {sql_str(code)};")
        if out.strip() == '1':
            skipped.append(code)
            continue

        # Находим legal_entity по имени
        entity_id = find_legal_entity_id(t.get('assignee_org', ''))

        # Вставка
        sql = f"""
        insert into tasks (
            code, title, explanation, status, priority, assignee_org, assignee_entity_id,
            object_codes, due_date,
            source_protocol, source_meeting_date, source_meeting_path,
            quotes, tags
        ) values (
            {sql_str(code)},
            {sql_str(t['title'])},
            {sql_str(t.get('explanation', ''))},
            'preliminary',
            {sql_str(t.get('priority', 'medium'))},
            {sql_str(t.get('assignee_org', ''))},
            {sql_str(entity_id)}::uuid,
            {sql_array(t.get('object_codes', []))},
            {sql_str(t.get('due_date'))}::date,
            {sql_str(source_protocol)},
            {sql_str(meeting_date)}::date,
            {sql_str(meeting_path)},
            {sql_jsonb(t.get('quotes', []))},
            ARRAY['protocol']::text[]
        )
        returning id::text;
        """
        rc, out, err = run_sql(sql)
        if rc != 0:
            print(f'ERROR inserting {code}: {err.strip()[:200]}', file=sys.stderr)
            continue
        task_id = out.strip()

        # entity_links: task → object
        for obj_code in t.get('object_codes', []):
            run_sql(f"""
            insert into entity_links (from_type, from_id, to_type, to_id, link_type)
            values ('task', {sql_str(task_id)}, 'object', {sql_str(obj_code)}, 'belongs_to')
            on conflict do nothing;
            """)

        # entity_links: task → contractor (legal_entity)
        if entity_id:
            run_sql(f"""
            insert into entity_links (from_type, from_id, to_type, to_id, link_type)
            values ('task', {sql_str(task_id)}, 'contractor', {sql_str(entity_id)}, 'assigned_to')
            on conflict do nothing;
            """)

        created.append({'id': task_id, 'code': code})

    json.dump({
        'created': created,
        'skipped': skipped,
        'created_count': len(created),
        'skipped_count': len(skipped),
    }, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
