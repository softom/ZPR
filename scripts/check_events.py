"""
check_events.py — проверка структуры событий в БД.
Подключается напрямую к PostgreSQL (порт 54322) — не требует JWT-ключей.
"""
import sys
import os

# Windows UTF-8 output (emoji-safe)
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # type: ignore

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)

# Прямое подключение к локальному Supabase Postgres
DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

try:
    conn = psycopg2.connect(DB_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
except Exception as e:
    print(f"ERROR: Could not connect to {DB_URL}\n{e}")
    sys.exit(1)


def hr(title: str) -> None:
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print('─' * 60)


# ── 1. Типы событий (group by) ──────────────────────────────────────────────

hr("1. События по типам")

cur.execute("""
    SELECT event_type, count(*) AS cnt
      FROM events
     GROUP BY event_type
     ORDER BY cnt DESC
""")
rows = cur.fetchall()
print(f"{'event_type':<30} {'count':>6}")
print(f"{'─'*30} {'─'*6}")
total = 0
for row in rows:
    print(f"{row['event_type']:<30} {row['cnt']:>6}")
    total += row['cnt']
print(f"{'Итого':<30} {total:>6}")


# ── 2. event_subtypes справочник ─────────────────────────────────────────────

hr("2. Справочник event_subtypes")

cur.execute("""
    SELECT code, category, label, icon
      FROM event_subtypes
     ORDER BY category, sort_order
""")
subtypes = cur.fetchall()
print(f"{'code':<25} {'category':<10} {'icon':<5} {'label'}")
print(f"{'─'*25} {'─'*10} {'─'*5} {'─'*30}")
for row in subtypes:
    icon = row['icon'] or ''
    print(f"{row['code']:<25} {row['category']:<10} {icon:<5} {row['label']}")
print(f"\nВсего строк в event_subtypes: {len(subtypes)}")

known_codes = {row['code'] for row in subtypes}
all_types = {row['event_type'] for row in rows}
unknown = all_types - known_codes
if unknown:
    print(f"\n⚠️  Типы в events, не покрытые event_subtypes: {', '.join(sorted(unknown))}")
else:
    print("\n✅  Все типы событий покрыты справочником event_subtypes")


# ── 3. Последние 20 событий с привязками ─────────────────────────────────────

hr("3. Последние 20 событий с их привязками")

cur.execute("""
    SELECT e.id, e.event_type, e.title,
           to_char(e.date_computed, 'YYYY-MM-DD') AS date_str,
           array_agg(el.to_type || ':' || left(el.to_id, 12)) FILTER (WHERE el.id IS NOT NULL) AS links
      FROM events e
      LEFT JOIN entity_links el ON el.from_type = 'event' AND el.from_id::uuid = e.id
     GROUP BY e.id
     ORDER BY e.created_at DESC
     LIMIT 20
""")
ev_rows = cur.fetchall()
print(f"{'event_type':<22} {'date':<12} {'title':<35} {'links'}")
print(f"{'─'*22} {'─'*12} {'─'*35} {'─'*30}")
for ev in ev_rows:
    date_str = ev['date_str'] or ''
    title    = (ev['title'] or '')[:33]
    links_list = ev['links'] or ['-']
    llinks   = ', '.join(links_list[:3])
    print(f"{ev['event_type']:<22} {date_str:<12} {title:<35} {llinks}")


# ── 4. Orphan-check: события без привязок ────────────────────────────────────

hr("4. Orphan check: события без entity_links")

cur.execute("""
    SELECT e.id, e.event_type, e.title
      FROM events e
     WHERE NOT EXISTS (
         SELECT 1 FROM entity_links el
          WHERE el.from_type = 'event'
            AND el.from_id::uuid = e.id
     )
       AND e.event_type <> 'contract_loaded'
     ORDER BY e.created_at DESC
""")
orphans = cur.fetchall()
print(f"Событий без привязок (кроме contract_loaded): {len(orphans)}")
if orphans:
    for ev in orphans[:20]:
        print(f"  {ev['event_type']:<22} {(ev['title'] or '')[:50]}")
    if len(orphans) > 20:
        print(f"  ... и ещё {len(orphans) - 20}")
else:
    print("✅  Все значимые события имеют хотя бы одну привязку")


# ── 5. entity_links по типам ─────────────────────────────────────────────────

hr("5. entity_links: распределение from_type → to_type")

cur.execute("""
    SELECT from_type || ' → ' || to_type AS pair, count(*) AS cnt
      FROM entity_links
     GROUP BY from_type, to_type
     ORDER BY cnt DESC
""")
pair_rows = cur.fetchall()
print(f"{'Связь':<35} {'count':>6}")
print(f"{'─'*35} {'─'*6}")
for row in pair_rows:
    print(f"{row['pair']:<35} {row['cnt']:>6}")
print(f"\nВсего связей: {sum(r['cnt'] for r in pair_rows)}")

cur.close()
conn.close()
print("\nГотово.")
