#!/usr/bin/env bash
# ЗПР migration — забиндить published-порты Supabase на интерфейс wg0 (10.8.0.1),
# чтобы стек был доступен ТОЛЬКО по VPN (Docker обходит ufw — лочим биндом, не файрволом).
# Идемпотентно: повторный запуск не добавит префикс второй раз.
set -euo pipefail
cd /opt/zpr/app/supabase
f=docker-compose.yml
ip="${ZPR_WG_IP:-10.8.0.1}"

cp -n "$f" "$f.orig"   # одноразовый снимок оригинала

sed -i \
  -e "s|- \${KONG_HTTP_PORT}:8000/tcp|- ${ip}:\${KONG_HTTP_PORT}:8000/tcp|" \
  -e "s|- \${KONG_HTTPS_PORT}:8443/tcp|- ${ip}:\${KONG_HTTPS_PORT}:8443/tcp|" \
  -e "s|- \${POSTGRES_PORT}:5432|- ${ip}:\${POSTGRES_PORT}:5432|" \
  -e "s|- \${POOLER_PROXY_PORT_TRANSACTION}:6543|- ${ip}:\${POOLER_PROXY_PORT_TRANSACTION}:6543|" \
  "$f"

echo "=== bound port lines ==="
grep -nE "${ip}:" "$f" || { echo "ERROR: no bound ports found"; exit 1; }
