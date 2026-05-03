"""
fix_event_subtypes.py — восстановить корректные данные event_subtypes.
Данные были записаны с битой кодировкой через PowerShell → psql.
Этот скрипт исправляет через psycopg2 (Python → UTF-8 напрямую).
"""
import sys
try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)

DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

SUBTYPES = [
    # (code, category, label, icon, sort_order)
    # fin
    ("fin_advance",        "fin",    "Аванс",                   "💰", 10),
    ("fin_interim",        "fin",    "Промежуточный платёж",    "💸", 20),
    ("fin_final",          "fin",    "Окончательный расчёт",    "✅", 30),
    # work
    ("work_start",         "work",   "Начало работ",            "▶",  10),
    ("work_end",           "work",   "Завершение работ",        "⬛", 20),
    ("work_stage",         "work",   "Этап работ",              "◆",  30),
    ("work_event",         "work",   "Рабочее событие",         "◇",  40),
    # appr
    ("appr_submission",    "appr",   "Сдача на согласование",   "📤", 10),
    ("appr_review",        "appr",   "Проверка",                "🔍", 20),
    ("appr_sign",          "appr",   "Подписание",              "📝", 30),
    # exec
    ("exec_report",        "exec",   "Отчёт подрядчика",        "📊", 10),
    ("exec_issue",         "exec",   "Проблема / замечание",    "⚠",  20),
    ("exec_start",         "exec",   "Начало исполнения",       "🟢", 30),
    ("exec_end",           "exec",   "Завершение исполнения",   "🏁", 40),
    ("exec_work",          "exec",   "Ход работ",               "🔨", 50),
    # system
    ("contract_signed",    "system", "Договор подписан",        "📋", 10),
    ("contract_loaded",    "system", "Договор загружен в БД",   "📂", 20),
    ("meeting",            "system", "Совещание",               "🤝", 30),
    ("protocol_published", "system", "Протокол опубликован",    "📄", 40),
]

conn = psycopg2.connect(DB_URL)
cur  = conn.cursor()

for code, category, label, icon, sort_order in SUBTYPES:
    cur.execute(
        """
        UPDATE event_subtypes
           SET label = %s, icon = %s, sort_order = %s
         WHERE code = %s
        """,
        (label, icon, sort_order, code)
    )
    if cur.rowcount == 0:
        cur.execute(
            """
            INSERT INTO event_subtypes (code, category, label, icon, sort_order)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (code) DO UPDATE
               SET label = EXCLUDED.label, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order
            """,
            (code, category, label, icon, sort_order)
        )

conn.commit()
cur.close()
conn.close()
print(f"✅  Обновлено {len(SUBTYPES)} строк в event_subtypes.")
