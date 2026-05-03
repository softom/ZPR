# Перенос разработки между ПК

Документация для случая «работаю на двух ПК — офис и дом, переключаюсь каждый день».

## Архитектура

- **Код** — синхронизируется через `git push` / `git pull` (ветка `feature/contract-module`).
- **Секреты** (`config.py`, `ui/.env.local`, `business_data.yaml`) — синхронизируются через **Dropbox** в папке `D:\Dropbox\_secrets\zpr_code\`. В git **не уходят** (`.gitignore`).
- **MD WIKI** (Obsidian) — уже синхронизируется через Dropbox самостоятельно.
- **БД** (локальная Supabase) — варианты ниже.

## Ритуал

```powershell
# В конце дня (на любом из ПК)
.\scripts\end-day.ps1

# В начале дня (на любом из ПК)
.\scripts\start-day.ps1
```

`end-day.ps1` делает security-grep, `git add -A`, WIP-коммит со штампом времени и имени машины, `git push`. WIP-коммиты на feature-ветке нормальны — squash при merge в main.

`start-day.ps1` делает `git pull`, проверяет секреты, ставит зависимости, поднимает Supabase, применяет миграции и seed, открывает UI dev-сервер. Флаг `-SkipSupabase` если БД на другом ПК (VPN-схема).

## Стратегии БД

### A. Локальная Supabase на каждом ПК (без VPN)

Каждый ПК со своей `supabase start`. Миграции (`scripts/db-migrate.ps1`) синхронизируются через git, seed (`seed_business_data.py`) — через `business_data.yaml` в Dropbox.

Минус: **рабочие данные** (созданные через UI договоры, импортированные задачи) **не синхронизируются**. Если нужно — `supabase db dump --local --data-only > D:\Dropbox\_secrets\zpr_code\db_data.sql` в `end-day` и `psql ... < db_data.sql` в `start-day`. Громоздко и легко забыть.

Когда подходит: данные тестовые, легко пере-импортировать.

### B. Одна БД, ходим из обоих ПК через VPN (рекомендуется)

Supabase запущена на одном ПК (например, в офисе). Второй ходит туда через VPN. Единый источник истины, рабочие данные не теряются.

**Настройка (Keenetic дома, статический IP):**

1. **Открыть Supabase для VPN-сети** — `supabase/config.toml` — поменять `[api].listen_address` и `[db].listen_address` с `127.0.0.1` на `0.0.0.0` (или конкретный VPN-IP). После — `supabase stop && supabase start`.
2. **VPN-сервер на Keenetic дома** (использует статический IP):
   - WireGuard через KeenDNS — встроено в Keenetic, бесплатно
   - L2TP/IPsec — тоже встроен
3. **VPN-клиент на офисном ПК** → подключается к домашнему Keenetic. Офис теперь виден из дома по VPN-IP типа `10.x.x.x`.
4. **На домашнем ПК** в `config.py` и `ui/.env.local`:
   ```
   SUPABASE_URL = "http://<vpn-ip-офиса>:54321"
   SUPABASE_DB_URL = "postgresql://postgres:postgres@<vpn-ip-офиса>:54322/postgres"
   ```
5. **Запуск дома**: `.\scripts\start-day.ps1 -SkipSupabase` — без `supabase start` локально.

**Альтернатива без Keenetic — Tailscale:** ставится клиентом на оба ПК, peer-to-peer mesh, не требует статического IP / порт-форвардинга. 5 минут настройки. Но это US-сервис — на санкционных ограничениях см. `_secrets/README.md`.

**Учти:** Supabase listen на 0.0.0.0 без firewall — небезопасно. Убедись что:
- На офисном ПК Windows Firewall разрешает 54321/54322 **только** для VPN-сети
- VPN не делает офисный ПК публично доступным

### C. Облачная Supabase (НЕ выбран)

Supabase Cloud (free tier). Простейший способ, но коммерчески чувствительные данные (договоры, ИНН) уехали бы в зарубежное облако. Для этого проекта не подходит.

## Что куда

| | Где живёт | Как переносится |
|---|---|---|
| Код | git origin (публичный) | push/pull |
| `config.py` | `D:\Dropbox\_secrets\zpr_code\` | Dropbox |
| `business_data.yaml` | `D:\Dropbox\_secrets\zpr_code\` | Dropbox |
| `ui/.env.local` | `D:\Dropbox\_secrets\zpr_code\ui\` | Dropbox |
| MD WIKI / Obsidian | `D:\Dropbox\Obsidian\Tigra\ЗПР\` | Dropbox автоматически |
| Схема БД | `supabase/migrations/*.sql` | git + `db-migrate.ps1` |
| Seed-данные БД | `business_data.yaml` → `seed_business_data.py` | Dropbox + скрипт |
| Рабочие данные БД | Postgres-volume локально | VPN (B) или dump (A) |

## Чего НЕ делать

- **Не коммитить** `config.py`, `.env.local`, `business_data.yaml` — даже случайно. `end-day.ps1` имеет security-grep как страховку.
- **Не копировать `.git`** — клонируй заново на новом ПК.
- **Не открывать порты Supabase в публичный интернет** — только VPN-сеть.
