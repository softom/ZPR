#!/usr/bin/env bash
# deploy-ui.sh — точечный деплой изменённых файлов UI на сервер Beget.
# Регламент: MD WIKI/CLAUDE/39_Регламент_деплоя.md
#
# Для каждого файла: создаёт каталог при необходимости → бэкап (если файл уже
# есть) → атомарная заливка (tmp → sha256-сверка → mv) → в конце ОДИН рестарт
# zpr-ui с проверкой и хвостом лога. НЕ использует rsync --delete.
#
# Использование (пути ОТНОСИТЕЛЬНО ui/):
#   bash scripts/deploy-ui.sh "app/reports/[id]/page.tsx" "app/api/reports/[id]/route.ts"
#
# Откат набора этого прогона (общая метка $TS печатается ниже):
#   ssh beget-zpr 'cp "/opt/zpr/ui/<путь>.bak_<TS>" "/opt/zpr/ui/<путь>" && systemctl restart zpr-ui'
#   (новый файл, у которого бэкапа нет, откатывается через rm)
#
# Переменные окружения:
#   SSH_ALIAS=beget-zpr     ssh-alias (root@45.130.42.178, ключ ~/.ssh/zpr_deploy)
#   REMOTE_UI=/opt/zpr/ui   корень UI на сервере
#   SKIP_RESTART=1          не перезапускать zpr-ui (если деплоишь несколько раз подряд)

set -uo pipefail

SSH_ALIAS="${SSH_ALIAS:-beget-zpr}"
REMOTE_UI="${REMOTE_UI:-/opt/zpr/ui}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_UI="$(dirname "$SCRIPT_DIR")/ui"

if [ "$#" -eq 0 ]; then
  echo "Укажи хотя бы один путь относительно ui/. Пример:" >&2
  echo "  bash scripts/deploy-ui.sh \"app/reports/[id]/page.tsx\"" >&2
  exit 2
fi

TS="$(date +%Y%m%d_%H%M%S)"
echo "Метка этого прогона (для отката): $TS"
fail=0

for REL in "$@"; do
  LOCAL="$LOCAL_UI/$REL"
  REMOTE="$REMOTE_UI/$REL"
  TMP="$REMOTE.tmp_$TS"
  echo "──────── $REL ────────"

  if [ ! -f "$LOCAL" ]; then
    echo "  [FAIL] нет локального файла: $LOCAL" >&2
    fail=1; continue
  fi

  # 0) гарантируем родительский каталог (нужно для НОВЫХ файлов в новой папке)
  if ! ssh "$SSH_ALIAS" "mkdir -p \"$(dirname "$REMOTE")\""; then
    echo "  [FAIL] не удалось создать каталог на сервере" >&2; fail=1; continue
  fi

  # 1) бэкап — ТОЛЬКО если файл на сервере уже есть; провал cp = стоп (без бэкапа не перезаписываем)
  exists="$(ssh "$SSH_ALIAS" "test -f \"$REMOTE\" && echo yes || echo no")"
  if [ "$exists" = "yes" ]; then
    if ssh "$SSH_ALIAS" "cp \"$REMOTE\" \"$REMOTE.bak_$TS\""; then
      echo "  [ok] backup → $REMOTE.bak_$TS"
    else
      echo "  [FAIL] бэкап не удался — файл НЕ перезаписываю" >&2; fail=1; continue
    fi
  else
    echo "  [info] нового файла на сервере ещё нет — бэкап не нужен (откат = rm \"$REMOTE\")"
  fi

  # 2) атомарная заливка: сначала во временный файл (обрыв ssh не испортит рабочий)
  if ! ssh "$SSH_ALIAS" "cat > \"$TMP\"" < "$LOCAL"; then
    echo "  [FAIL] заливка не удалась" >&2
    ssh "$SSH_ALIAS" "rm -f \"$TMP\"" 2>/dev/null
    fail=1; continue
  fi

  # 3) сверка sha256 (tmp на сервере vs локальный); пустой r = не смогли посчитать
  l="$(sha256sum "$LOCAL" | cut -d' ' -f1)"
  r="$(ssh "$SSH_ALIAS" "sha256sum \"$TMP\" 2>/dev/null" | cut -d' ' -f1)"
  if [ -z "$r" ]; then
    echo "  [FAIL] не удалось получить sha256 с сервера" >&2
    ssh "$SSH_ALIAS" "rm -f \"$TMP\"" 2>/dev/null
    fail=1; continue
  fi
  if [ "$l" != "$r" ]; then
    echo "  [FAIL] sha256 РАЗОШЁЛСЯ: local=$l remote=$r (заливка повреждена)" >&2
    ssh "$SSH_ALIAS" "rm -f \"$TMP\"" 2>/dev/null
    fail=1; continue
  fi

  # 4) атомарная замена
  if ssh "$SSH_ALIAS" "mv \"$TMP\" \"$REMOTE\""; then
    echo "  [ok] deployed → $REMOTE (sha256 $l)"
  else
    echo "  [FAIL] mv не удался" >&2
    ssh "$SSH_ALIAS" "rm -f \"$TMP\"" 2>/dev/null
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "⚠️  Были ошибки — zpr-ui НЕ перезапускаю. Разберись и повтори (откат набора: метка $TS)." >&2
  exit 1
fi

if [ "${SKIP_RESTART:-0}" = "1" ]; then
  echo "SKIP_RESTART=1 — рестарт пропущен."
  exit 0
fi

echo "──────── restart zpr-ui ────────"
# Команды через ';' (не '&&'), чтобы хвост лога печатался ВСЕГДА, даже если UI не поднялся.
active="$(ssh "$SSH_ALIAS" '
  systemctl restart zpr-ui
  sleep 4
  a=$(systemctl is-active zpr-ui)
  echo "is-active: $a"
  echo "── tail ui.log (компиляция/ошибки) ──"
  tail -n 18 /opt/zpr/logs/ui.log
  echo "__ACTIVE__:$a"
' | tee /dev/stderr | sed -n 's/^__ACTIVE__://p')"

if [ "$active" != "active" ]; then
  echo "⚠️  zpr-ui НЕ active ('$active') — смотри лог выше. Возможен откат по метке $TS." >&2
  exit 1
fi
echo "✅ Готово. Проверь в браузере: http://10.8.0.1:3000  (если вкладка висит на «Загрузка…» — Ctrl+Shift+R)"
