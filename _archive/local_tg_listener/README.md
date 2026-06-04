# Архив: локальный Telegram-листенер

Заменён на серверный `tg_raw_listener.py` (US VPS, systemd).
Архивировано 2026-05-29.

## Что здесь

| Файл | Был | Назначение |
|------|-----|------------|
| `telegram_listener.py` | корень репо | Локальный MTProto-листенер (whitelist, Хранилище) |
| `run_tg_listener.ps1` | `scripts/` | Task Scheduler обёртка для `--listen` |
| `run_tg_classifier.ps1` | `scripts/` | Task Scheduler обёртка для классификатора (раз в 4ч) |
| `refresh_tg_now.ps1` | `scripts/` | Ручной триггер из UI (stop→backfill→classify→start) |
| `route.ts` | `ui/app/api/events/refresh-tg/` | API-роут, вызывал `refresh_tg_now.ps1` |

## Task Scheduler (отключены)

- `ZPR_Telegram_Listener` — Disabled
- `ZPR_TG_Classifier_Batch` — Disabled

## Замена

- Сбор: `tg_raw_listener.py` на US VPS (systemd `zpr-tg-listener.service`)
- Классификация: `tg_classifier.py` читает из облачного Supabase (cloud-read)
- UI: планируется Realtime-подписка (Фаза 2)

См. WIKI: `35_Внешний_сервер_и_облако.md`
