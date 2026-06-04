#!/usr/bin/env python3
# ЗПР migration — патч config.py под сервер Beget (Linux-пути + серверный Supabase).
# Читает свежие ключи из /opt/zpr/app/supabase/.env. Идемпотентен (повторный запуск — no-op).
import re, sys, pathlib

CONFIG = pathlib.Path("/opt/zpr/code/config.py")
ENV = pathlib.Path("/opt/zpr/app/supabase/.env")

env = {}
for line in ENV.read_text().splitlines():
    m = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
    if m:
        env[m.group(1)] = m.group(2)

ANON = env["ANON_KEY"]
SVC = env["SERVICE_ROLE_KEY"]
PG = env["POSTGRES_PASSWORD"]

text = CONFIG.read_text(encoding="utf-8")

repl = {
    r'Path(r"D:\Dropbox\Obsidian\Tigra\ЗПР")': 'Path("/opt/zpr/obsidian")',
    r'Path(r"D:\ЗПР_Хранилище")': 'Path("/opt/zpr/storage")',
    '"http://127.0.0.1:54321"': '"http://10.8.0.1:8000"',
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres':
        f'postgresql://postgres.zpr:{PG}@10.8.0.1:5432/postgres',
    r'Path(r"D:\CODE\zpr_code\.tg_session")': 'Path("/opt/zpr/.tg_session")',
    r'Path(r"D:\CODE\zpr_code\telegram_whitelist.yaml")': 'Path("/opt/zpr/code/telegram_whitelist.yaml")',
    r'Path(r"D:\CODE\zpr_code\bitrix_whitelist.yaml")': 'Path("/opt/zpr/code/bitrix_whitelist.yaml")',
}

applied = 0
for old, new in repl.items():
    if old in text:
        text = text.replace(old, new)
        applied += 1

# Ключи Supabase — заменяем по паттерну (старые значения не храним в коде/git)
text, n_anon = re.subn(r'sb_publishable_[A-Za-z0-9_-]+', ANON, text)
text, n_svc = re.subn(r'sb_secret_[A-Za-z0-9_-]+', SVC, text)
applied += n_anon + n_svc

OVERRIDE_MARK = "# ─── Server overrides (Beget) ───"
if OVERRIDE_MARK not in text:
    text += (
        f"\n\n{OVERRIDE_MARK}\n"
        'LLM_MODEL = "anthropic/claude-sonnet-4.6"\n'
        'ASK_MODEL = "openai/gpt-4o-mini"\n'
        'EMBEDDING_MODEL = "openai/text-embedding-3-small"\n'
    )

CONFIG.write_text(text, encoding="utf-8")
print(f"patched: {applied} substitutions, override block ensured")
# sanity: no Windows paths left
leftover = re.findall(r'D:\\\\|D:\\|127\.0\.0\.1:5432', text)
print(f"windows/local leftovers in active config: {len(leftover)}")
