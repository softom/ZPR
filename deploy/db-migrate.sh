#!/usr/bin/env bash
# db-migrate.sh — применяет новые SQL-миграции к self-hosted Supabase на сервере.
# Bash-порт scripts/db-migrate.ps1. Идемпотентен по реестру _applied_migrations.
#
# Использование:
#   /opt/zpr/code/scripts/db-migrate.sh            # применить новые
#   /opt/zpr/code/scripts/db-migrate.sh --dry-run  # показать, что применилось бы
#
# UTF-8/кириллица: файлы копируются в контейнер через `docker cp` и применяются
# `psql -f` (а не пайп через stdin) — это сохраняет UTF-8-байты (как в ps1-оригинале).
set -uo pipefail

CONTAINER="${ZPR_DB_CONTAINER:-supabase-db}"
MIGDIR="${ZPR_MIGRATIONS_DIR:-/opt/zpr/code/supabase/migrations}"
DRY=0
[ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "-DryRun" ] && DRY=1

psql() { docker exec -i "$CONTAINER" psql -U postgres -d postgres "$@"; }

[ -d "$MIGDIR" ] || { echo "[FAIL] migrations dir not found: $MIGDIR"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || { echo "[FAIL] container '$CONTAINER' not running"; exit 1; }
echo "[OK] container '$CONTAINER' is running"

applied="$(psql -t -A -c 'SELECT filename FROM _applied_migrations ORDER BY filename;' 2>/dev/null)"
applied_count=$(printf '%s\n' "$applied" | grep -c . || true)
echo "[OK] registry: ${applied_count} migrations already applied"

mapfile -t files < <(ls -1 "$MIGDIR"/*.sql 2>/dev/null | xargs -n1 basename | sort)
echo "[OK] migration files on disk: ${#files[@]}"

new=()
for f in "${files[@]}"; do
  printf '%s\n' "$applied" | grep -qxF "$f" || new+=("$f")
done

if [ "${#new[@]}" -eq 0 ]; then
  echo "[OK] all migrations applied, nothing to do"
  psql -c "NOTIFY pgrst, 'reload schema';" >/dev/null
  exit 0
fi

echo ""
echo "New migrations to apply: ${#new[@]}"
for f in "${new[@]}"; do echo "  - $f"; done
echo ""

if [ "$DRY" -eq 1 ]; then
  echo "[DryRun] nothing applied. Remove --dry-run to apply."
  exit 0
fi

for f in "${new[@]}"; do
  echo "-> $f"
  remote="/tmp/zpr_migrate_${f}"
  docker cp "$MIGDIR/$f" "$CONTAINER:$remote" || { echo "[FAIL] docker cp $f"; exit 1; }
  if ! psql -v ON_ERROR_STOP=1 -q -f "$remote"; then
    echo "[FAIL] migration '$f' errored. Subsequent NOT applied."
    docker exec -i "$CONTAINER" rm -f "$remote" >/dev/null 2>&1 || true
    exit 1
  fi
  docker exec -i "$CONTAINER" rm -f "$remote" >/dev/null 2>&1 || true
  psql -c "INSERT INTO _applied_migrations (filename) VALUES ('$f') ON CONFLICT DO NOTHING;" >/dev/null
  echo "   [OK] applied and registered"
done

psql -c "NOTIFY pgrst, 'reload schema';" >/dev/null
echo ""
echo "[OK] done: ${#new[@]} migrations applied, PostgREST cache reloaded"
