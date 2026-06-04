#!/usr/bin/env bash
# ЗПР — ежедневный бэкап серверной БД (self-hosted Supabase). Хранит последние 14.
set -euo pipefail
OUT=/opt/zpr/backups/db
mkdir -p "$OUT"
STAMP=$(date +%Y%m%d_%H%M)
FILE="$OUT/zpr_full_${STAMP}.dump"
docker exec supabase-db pg_dump -U postgres -Fc postgres > "$FILE"
# ротация: оставить 14 свежих
ls -1t "$OUT"/zpr_full_*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "backup: $FILE ($(du -h "$FILE" | cut -f1)); kept $(ls -1 "$OUT"/zpr_full_*.dump | wc -l)"
