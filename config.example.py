"""
config.example.py — шаблон конфигурации.
Скопируйте в config.py и заполните ключи.
"""

from pathlib import Path

BASE_DIR     = Path(r"D:\Dropbox\Obsidian\Tigra\ЗПР")  # путь к Obsidian-хранилищу
STORAGE_DIR  = Path(r"D:\ЗПР_Хранилище")              # первичное хранилище документов

SOURCE_DIRS_CONTRACTS = [
    BASE_DIR / "ОБЪЕКТЫ",
    Path(r"D:\Bitrix24\Концепции отелей\01_УПРАВЛЕНИЕ ПРОЕКТОМ\02_ДОГОВОРА_ЗПР"),
]

INDEX_DIR     = BASE_DIR / "_ОБЩЕЕ" / "ДОГОВОРА_ИНДЕКС"
CONTRACTS_DIR = INDEX_DIR / "contracts"
REGISTRY      = INDEX_DIR / "00_registry.json"

OBJECTS_DIR     = BASE_DIR / "ОБЪЕКТЫ"
CONTRACTORS_DIR = BASE_DIR / "ПОДРЯДЧИКИ"
REPORTS_DIR     = BASE_DIR / "ОТЧЁТЫ"
SCHEDULE_DIR    = BASE_DIR / "ГРАФИК"

FINECMD_PATH = r"C:\Program Files (x86)\ABBYY FineReader 15\FineCmd.exe"
ABBYY_LANG   = "Russian,English"

POLZA_API_KEY    = ""   # https://polza.ai/dashboard/api-keys
POLZA_BASE_URL   = "https://polza.ai/api/v1"
LLM_MODEL        = "anthropic/claude-sonnet-4.6"
EMBEDDING_MODEL  = "openai/text-embedding-3-small"  # для векторного поиска

# ─── Supabase (локальный Docker-стек) ────────────────────────────────────────
# Векторный поиск — через pgvector, расширение уже установлено в Supabase.
# После `supabase start` CLI показывает актуальные URL и ключи (`supabase status`).

SUPABASE_URL              = "http://127.0.0.1:54321"
SUPABASE_PUBLISHABLE_KEY  = ""   # клиентский ключ (Next.js, браузер) — безопасен
SUPABASE_SECRET_KEY       = ""   # серверный ключ (Python-скрипты) — НИКОГДА не в git
SUPABASE_DB_URL           = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# ─── Telegram (личный аккаунт через MTProto) ─────────────────────────────────
# api_id / api_hash получают на https://my.telegram.org/apps (один раз).
# Session-файл хранит авторизованную сессию — секрет уровня логина, в .gitignore.
# При первом запуске telegram_listener.py попросит телефон + код подтверждения.

TG_API_ID        = 0
TG_API_HASH      = ""
TG_SESSION_PATH  = Path(r"D:\CODE\zpr_code\.tg_session")           # для listener (long-running)
TG_SESSION_SEND_PATH = Path(r"D:\CODE\zpr_code\.tg_session_send")  # отдельная сессия для send-only
                                                                   # (scripts/send_telegram_protocol.py),
                                                                   # чтобы не конфликтовать с listener
TG_WHITELIST     = Path(r"D:\CODE\zpr_code\telegram_whitelist.yaml")
