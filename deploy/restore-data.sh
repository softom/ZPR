#!/usr/bin/env bash
# ЗПР migration — восстановление данных в свежий self-hosted Supabase (контейнер supabase-db).
# Порядок важен: расширения → роль arcgis_writer → SRID → auth.users (FK!) → public schema.
# Запуск на сервере: bash /opt/zpr/app/restore-data.sh
set -uo pipefail
DIR=/opt/zpr/backups/migration
C=supabase-db
psqlc(){ docker exec -i "$C" psql -U postgres -d postgres "$@"; }

echo "=== 1. extensions (postgis@extensions, vector@public) ==="
psqlc -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;"
psqlc -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;"

echo "=== 2. role arcgis_writer (для GRANT'ов в дампе; ArcGIS отложен) ==="
psqlc -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='arcgis_writer') THEN CREATE ROLE arcgis_writer LOGIN BYPASSRLS PASSWORD 'arcgis_dev_pass'; END IF; END \$\$;"

echo "=== 3. custom SRID 970634 (СК-63 z4) ==="
psqlc -v ON_ERROR_STOP=1 < "$DIR/srid_970634.sql"
psqlc -Atc "select 'SRID present: '||count(*) from extensions.spatial_ref_sys where srid=970634;"

echo "=== 4. auth.users + identities (3 логина) ==="
psqlc < "$DIR/auth_users.sql"
psqlc -Atc "select 'auth.users count: '||count(*) from auth.users;"

echo "=== 5. restore public schema (DDL+data, with ACL, no-owner) ==="
docker cp "$DIR/public.dump" "$C:/tmp/public.dump"
docker exec -i "$C" pg_restore -U postgres -d postgres --no-owner /tmp/public.dump 2>/tmp/pgrestore.err
RC=$?
echo "pg_restore rc=$RC"
echo "--- restore errors (если есть) ---"
grep -iE "error|fatal" /tmp/pgrestore.err | grep -viE "already exists|multiple primary keys|errors ignored on restore" | head -40 || true
docker exec -i "$C" sh -c 'echo "total stderr lines: $(wc -l < /tmp/pgrestore.err)"'

echo "=== 6. verify ==="
psqlc -Atc "select 'public tables: '||count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';"
psqlc -Atc "select 'applied migrations: '||count(*) from _applied_migrations;"
psqlc -Atc "select 'objects rows: '||count(*) from objects;"
psqlc -Atc "select 'documents rows: '||count(*) from documents;"
psqlc -Atc "select 'cadastrals rows: '||count(*) from cadastrals;"
psqlc -Atc "select 'postgis: '||extversion from pg_extension where extname='postgis';"
psqlc -Atc "select 'vector: '||extversion from pg_extension where extname='vector';"
