# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Проект

**ЗПР = «Золотые Пески России»** — Python-скрипты для управления проектом.
Пользователь: Артемий Ю. Антипов, Руководитель проекта.

Четыре уровня хранения:

| # | Уровень | Путь |
|---|---------|------|
| 0 | Хранилище (первичное) | `D:\ЗПР_Хранилище\` |
| 1 | Dropbox (копия для команды) | `D:\Dropbox\ЗПР\` |
| 2 | Git (этот репозиторий) | `D:\CODE\zpr_code\` |
| 3 | БД | Supabase (Docker локально) |

Рабочая база Obsidian: `D:\Dropbox\Obsidian\Tigra\ЗПР\`

---

## Скрипты

| Скрипт | Назначение | Запуск |
|--------|-----------|--------|
| `config.py` | Пути, API-ключи, маппинг объектов | — |
| `llm_client.py` | Обёртка над Polza.AI (LLM + эмбеддинги) | — |
| `schedule_parser.py` | Парсинг Excel ГПР (MS Project export) | — |
| `contracts_indexer.py` | Синхронизация и индексирование договоров | `python contracts_indexer.py` |
| `meeting_processor.py` | Генерация задач из транскрипции собрания | `python meeting_processor.py "ПОДРЯДЧИКИ/МЛА+/Собрания/2026-04-17 ..."` |
| `protocol_generator.py` | Генерация протокола .docx из MD-задач | `python protocol_generator.py "ПОДРЯДЧИКИ/Бюро82/Собрания/2026-04-17 ..."` |
| `report_generator.py` | Еженедельный отчёт по всем объектам | `python report_generator.py [--date YYYY-MM-DD] [--dry-run]` |
| `document_processor.py` | Загрузка документа в хранилище + pgvector | *(в разработке)* |

---

## Конфигурация

API-ключи хранятся в `config.py` (не в git).

```
LLM_MODEL: anthropic/claude-sonnet-4.6
LLM_PROVIDER: polza
POLZA_BASE_URL: https://polza.ai/api/v1
```

---

## Локальный стенд (разработка)

**Запуск БД и сервисов:** `supabase start` в корне репозитория (требует Docker Desktop).

### Компоненты

| Слой | Инструмент | Назначение |
|------|-----------|------------|
| Контейнеризация | Docker Desktop | Движок для контейнеров Supabase |
| БД-стек | Supabase CLI (`supabase.exe`) | Оркестрация локального Supabase |
| Бэкенд-скрипты | Anaconda (Python 3.13, conda env `zpr`) | Скрипты `*.py` этого репозитория |
| UI | Node.js 24 LTS + Next.js | Веб-интерфейс (папка `ui/`) |
| Python-клиент Supabase | `supabase-py` | Доступ из скриптов к локальной/прод БД |
| JS-клиент Supabase | `@supabase/supabase-js` | Доступ из Next.js к той же БД |

### Структура репозитория

```
D:\CODE\zpr_code\
├─ config.py              # ключи (в .gitignore)
├─ *.py                   # бэкенд-скрипты ЗПР (Python, conda env `zpr`)
├─ requirements.txt       # Python-зависимости (включая supabase, python-dotenv)
├─ supabase\              # конфиг Local Dev (в git)
│  ├─ config.toml
│  └─ migrations\         # schema-миграции (источник истины для таблиц)
├─ ui\                    # Next.js интерфейс (App Router + TS + Tailwind)
│  ├─ .env.local          # URL/ключи (в .gitignore)
│  └─ src\                # страницы, компоненты, supabase-клиент
└─ MD WIKI\               # база знаний (не в git)
```

### Порты локального стека

| Порт | Сервис | URL |
|------|--------|-----|
| 54321 | Kong API gateway | http://127.0.0.1:54321 — REST/Realtime/Auth/Storage |
| 54322 | PostgreSQL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| 54323 | Supabase Studio | http://127.0.0.1:54323 — веб-админка, SQL-редактор, логи |
| 54324 | Inbucket | http://127.0.0.1:54324 — тестовый SMTP для писем Auth |

Python-скрипты и Next.js ходят **в одну БД** через Kong (порт 54321).
Ключи (`anon`, `service_role`) CLI выводит после `supabase start` — сохраняются в `config.py` и `ui/.env.local`.

### Схема БД — источник истины

Миграции в `supabase/migrations/*.sql`. Применяются скриптом `scripts/db-migrate.ps1`.
Описание таблиц и ролей — `MD WIKI/CLAUDE/06_БАЗА_ДАННЫХ.md`.
Регламент миграций — `MD WIKI/CLAUDE/16_Регламент_миграций.md`.

### Применение миграций — обязательный workflow

**Источник истины** — таблица `_applied_migrations` в БД + файлы в `supabase/migrations/`.
**Инструмент** — `scripts/db-migrate.ps1` (идемпотентно, с учётом уже применённых).

```powershell
# Обычное применение
.\scripts\db-migrate.ps1

# Проверка без применения
.\scripts\db-migrate.ps1 -DryRun
```

⚠️ **ВСЕГДА используй скрипт, а не ручной `docker exec < file.sql`.** Ручной путь не регистрирует миграцию в `_applied_migrations` → в следующий раз скрипт применит её повторно.

### Правила для Claude при работе с миграциями

При создании любой новой миграции Claude **ОБЯЗАН** в том же ответе:

1. Написать файл `supabase/migrations/YYYYMMDDNNNNNN_<name>.sql`
2. Выполнить `.\scripts\db-migrate.ps1` и **показать вывод**
3. Проверить схему через `docker exec supabase_db_zpr_code psql -U postgres -d postgres -c "\df <name>"` или `\d <table>` — показать вывод
4. **Если миграция содержит кириллицу** (seed `INSERT`, `COMMENT ON`, `DEFAULT 'строка'`) — **проверить кодировку**:
   `SELECT col, octet_length(col) FROM <table>;` — если `bytes ≈ кол-во символов` → данные битые (`???`). Лечить прямым `docker exec ... psql -c "UPDATE ..."` (bash сохраняет UTF-8). Подробности — `MD WIKI/CLAUDE/16_Регламент_миграций.md` → раздел «UTF-8 / кириллица».
5. Только **после** подтверждённого apply и проверки кодировки — писать код, зависящий от новой схемы

**Если Docker не запущен / скрипт падает** — Claude немедленно сообщает пользователю с точной командой. **НЕ продолжает** писать зависимый код — он сломается в runtime с невнятным «Ошибка поиска в БД».

### Чувствительные бизнес-данные — `business_data.yaml`

Реальные ИНН/адреса/подписанты юр.лиц и маппинг подрядчик→объекты вынесены из миграций в `business_data.yaml` (в `.gitignore`, синхронизируется через Dropbox). Шаблон в репо — `business_data.example.yaml`.

Применение к БД:

```bash
python seed_business_data.py        # INSERT в legal_entities + backfill tasks.assignee_entity_id
python seed_business_data.py --dry  # показать SQL без записи
```

Используется также `tasks_importer.py` — нормализация имён организаций при импорте задач из .md.

### Миграция на другую машину / в прод

1. `git clone` репозитория
2. Скопировать секреты из Dropbox: `config.py`, `ui/.env.local`, `business_data.yaml`
3. `supabase start` — поднимает идентичный стек
4. `.\scripts\db-migrate.ps1` — применяет все миграции с учётом `_applied_migrations`
5. `python seed_business_data.py` — заливает чувствительные seed-данные из yaml
6. Для прод-Supabase (облако): `supabase link --project-ref <ref>` + `supabase db push`

---

## Зависимости

```bash
pip install -r requirements.txt
```

---

## Git — рабочий процесс

`config.py` в `.gitignore` — ключи не уходят в GitHub.

**Первый раз на новом ПК:**
```bash
git clone https://github.com/softom/ZPR.git
cd ZPR
cp config.example.py config.py   # вписать API-ключи
pip install -r requirements.txt
```

**После каждой правки:**
```bash
git add .
git commit -m "описание изменений"
git push
```

---

## MD WIKI — база знаний

Папка `MD WIKI/CLAUDE/` — база знаний проекта. **Источник истины — этот репозиторий (git).**
Obsidian (`D:\Dropbox\Obsidian\Tigra\ЗПР\`) — хранилище отчётных форм (ПРОТ-*, ПРОБ-*), не база знаний.

### Структура MD WIKI

| Файл | Тема |
|------|------|
| `CLAUDE/01_СТРУКТУРА_ПРОЕКТА.md` | 4 уровня хранения, взаимодействие |
| `CLAUDE/02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ.md` | Папки, коды объектов, именование, типы документов |
| `CLAUDE/03_ПРОГРАММНЫЙ_КОД.md` | Репозиторий, скрипты, git |
| `CLAUDE/04_MD_WIKI.md` | MD WIKI — база знаний, инструкция для Claude |
| `CLAUDE/05_OBSIDIAN.md` | Obsidian — отчётные формы в Dropbox |
| `CLAUDE/06_БАЗА_ДАННЫХ.md` | Supabase: схема, роли, pgvector |
| `CLAUDE/07_Генерация_задач_и_кодировка.md` | Генерация задач из протоколов |
| `CLAUDE/08_Синхронизация_договоров.md` | Синхронизация договоров из Bitrix24 |
| `CLAUDE/09_Промпт_привязка_цитат.md` | Промпт для привязки цитат к задачам |
| `CLAUDE/10_Алгоритм_собрания.md` | Обработка собраний |
| `CLAUDE/11_График_и_отклонения.md` | ГПР, плановые даты, отчёт |
| `CLAUDE/12_Проблемы_объекта.md` | Журнал проблем (ПРОБ-*) |
| `CLAUDE/13_Workflow_входящие_документы.md` | Обработка входящей почты |
| `CLAUDE/14_Модель_событий.md` | Модель событий (даты, вехи, даты этапов) |
| `CLAUDE/15_AI_Ассистент.md` | AI-ассистент по материалам: RAG + pgvector + Polza.AI |
| `CLAUDE/16_Регламент_миграций.md` | Регламент применения миграций БД (реестр + скрипт) |
| `CLAUDE/17_Сущность_Договор_и_ЮрЛицо.md` | Договор / ПунктДоговора / ЮрЛицо — сущности ветки «Договор» |
| `CLAUDE/18_Архитектура_модулей.md` | Модули A/B/C/D/E, две ветки + мост, поток данных |
| `CLAUDE/19_Сущность_Юридическое_лицо.md` | Справочник юридических лиц: реквизиты, валидация, админ-экран |
| `CLAUDE/Регламенты/` | Регламенты по типам документов (9 файлов) |

### Правило чтения по подпроектам

**При каждом запросе Claude ОБЯЗАН** читать соответствующие файлы:

| Подпроект | Файлы |
|-----------|-------|
| Структура и хранилище | `01_СТРУКТУРА_ПРОЕКТА` + `02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ` |
| Программный код | `03_ПРОГРАММНЫЙ_КОД` |
| MD WIKI | `04_MD_WIKI` |
| Obsidian / отчётные формы | `05_OBSIDIAN` |
| База данных | `06_БАЗА_ДАННЫХ` |
| Еженедельный отчёт | `11_График_и_отклонения` |
| Обработка собраний | `10_Алгоритм_собрания` + `07_Генерация_задач_и_кодировка` |
| Проблемы объекта | `12_Проблемы_объекта` |
| Входящие документы | `13_Workflow_входящие_документы` + `Регламенты/Регламент_{ТИП}` |
| AI-ассистент / поиск с ответами | `15_AI_Ассистент` + `06_БАЗА_ДАННЫХ` |
| Создание/применение миграций БД | `16_Регламент_миграций` + `06_БАЗА_ДАННЫХ` |

---

## База знаний — Wiki-ссылки

Все записи ведутся в формате Obsidian Wiki-ссылок: `[[Название страницы]]`.

При упоминании значимого элемента (объект, подрядчик, процесс, документ, решение) —
оформлять как `[[Элемент]]`, чтобы он стал узлом базы знаний.

---

## VS Code — расширения

Устанавливаются автоматически (`.vscode/extensions.json`):
- `ms-python.python` · `ms-python.pylance` · `ms-python.autopep8`
- `anthropic.claude-code`
