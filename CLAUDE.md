# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Проект

**ЗПР = «Золотые Пески России»** — Python-скрипты для управления проектом.
Пользователь: Артемий Ю. Антипов, Руководитель проекта.

Четыре уровня хранения + GIS-клиент (полная картина — [[01_СТРУКТУРА_ПРОЕКТА]]):

| #   | Уровень | Путь |
|-----|---------|------|
| 0   | Хранилище (первичное) | `D:\ЗПР_Хранилище\` |
| 1   | Dropbox (копия для команды) | `D:\Dropbox\ЗПР\` |
| 2   | Git (этот репозиторий) | `D:\CODE\zpr_code\` |
| 3   | БД | Supabase (Docker локально), PostGIS — для геометрии |
| 3+  | GIS-клиент | ArcGIS Pro → напрямую в Postgres 54322 под `arcgis_writer` |

Рабочая база Obsidian: `D:\Dropbox\Obsidian\Tigra\ЗПР\`

---

## Скрипты

| Скрипт | Назначение | Запуск |
|--------|-----------|--------|
| `config.py` | Пути, API-ключи, маппинг объектов | — |
| `llm_client.py` | Обёртка над Polza.AI (LLM + эмбеддинги) | — |
| `schedule_parser.py` | Парсинг Excel ГПР (MS Project export) | — |
| `contracts_indexer.py` | Синхронизация и индексирование договоров | `python contracts_indexer.py` |
| `document_processor.py` | Загрузка документа в хранилище + pgvector | `python document_processor.py <path>` |
| `report_generator.py` | Еженедельный отчёт по всем объектам | `python report_generator.py [--date YYYY-MM-DD] [--dry-run]` |
| `contacts_importer.py` | Импорт контактов в `contacts` | `python contacts_importer.py` |
| `movement_importer.py` | Импорт ведомости движения | `python movement_importer.py` |
| `seed_business_data.py` | Сидирование справочников после `db reset` | `python seed_business_data.py` |
| `telegram_listener.py` | MTProto-listener Telegram (Telethon) → `tg_messages` | `python telegram_listener.py` |
| `tg_classifier.py` | Классификатор TG-сообщений в события (L1+L2) | `python tg_classifier.py` |
| `test_contract_analysis.py` | Smoke-тест анализа договоров | `python test_contract_analysis.py` |
| `meeting_processor.py` | ⚠️ Legacy. Используется только для исторического переразбора (основной поток — UI POST `/api/protocols/[id]/process`) | `python meeting_processor.py "ПОДРЯДЧИКИ/ПОДР-X/Собрания/..."` |
| `scripts/db-migrate.ps1` | **Единственный** способ применения SQL-миграций. См. [[16_Регламент_миграций]] | `.\scripts\db-migrate.ps1 [-DryRun]` |

**Архив (`_archive/`)** — заменено UI-пайплайном или одноразовое:
- `tasks_importer.py` — единоразовый импорт `.md`-задач в `tasks` (27.04.2026)
- `tasks_create_preliminary.py` — POST `/api/protocols/[id]/process`
- `tasks_approve.py` — функция `approveAll()` в `app/protocols/[id]/page.tsx`
- `protocol_generator.py` — `ui/lib/protocol/generateDocx.ts` (npm-пакет `docx`)

---

## Конфигурация

API-ключи хранятся в `config.py` (не в git).

```
LLM_MODEL: anthropic/claude-sonnet-4.6
LLM_PROVIDER: polza
POLZA_BASE_URL: https://polza.ai/api/v1
```

LLM-модели — три ENV-переменные с разными ролями (детально в [[03_ПРОГРАММНЫЙ_КОД]] → «LLM-модели»):

| ENV | Дефолт | Назначение |
|-----|--------|------------|
| `LLM_MODEL` | `anthropic/claude-sonnet-4.6` | Тяжёлая обработка: договоры, протоколы, отчёты, классификатор событий |
| `ASK_MODEL` | `openai/gpt-4o-mini` | **Только** `/api/ask` (RAG-чат) — в 3–5× дешевле для коротких вопросов |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Векторы 1536-dim в `document_chunks.embedding` |

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
├─ _archive\              # legacy-хелперы (tasks_create_preliminary, tasks_approve, protocol_generator)
├─ requirements.txt       # Python-зависимости (включая supabase, python-dotenv)
├─ supabase\              # конфиг Local Dev (в git)
│  ├─ config.toml
│  └─ migrations\         # schema-миграции (источник истины для таблиц)
├─ ui\                    # Next.js интерфейс (App Router + TS + Tailwind)
│  ├─ .env.local          # URL/ключи (в .gitignore)
│  └─ src\                # страницы, компоненты, supabase-клиент
└─ MD WIKI\               # база знаний — junction → Dropbox (не в git, см. ниже)
```

> ⚠️ `MD WIKI\` — это **directory junction**, а не обычная папка. Физически WIKI лежит в
> синхронизируемом Obsidian-vault: `D:\Dropbox\Приложения\remotely-save\Золотые Пески России\MD WIKI`.
> Junction даёт доступ по привычному относительному пути `MD WIKI/` в основном чекауте **и в каждом
> git-worktree**. После `git clone` или создания нового worktree линк нужно восстановить:
> `.\scripts\link-wiki.ps1` (идемпотентно, создаёт junction во всех worktree'ах).

### Порты локального стека

| Порт | Сервис | URL |
|------|--------|-----|
| 54321 | Kong API gateway | http://127.0.0.1:54321 — REST/Realtime/Auth/Storage |
| 54322 | PostgreSQL | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| 54323 | Supabase Studio | http://127.0.0.1:54323 — веб-админка, SQL-редактор, логи |
| 54324 | Mailpit | http://127.0.0.1:54324 — тестовый SMTP для писем Auth (образ `mailpit`, имя контейнера исторически `supabase_inbucket_*`) |

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

Используется также `_archive/tasks_importer.py` (одноразовый, в архиве) — нормализация имён организаций при импорте задач из .md (27.04.2026).

### Миграция на другую машину / в прод

1. `git clone` репозитория
2. Скопировать секреты из Dropbox: `config.py`, `ui/.env.local`, `business_data.yaml`
3. `.\scripts\link-wiki.ps1` — восстановить junction `MD WIKI\` → синхронизируемый vault (база знаний не в git)
4. `supabase start` — поднимает идентичный стек
5. `.\scripts\db-migrate.ps1` — применяет все миграции с учётом `_applied_migrations`
6. `python seed_business_data.py` — заливает чувствительные seed-данные из yaml
7. Для прод-Supabase (облако): `supabase link --project-ref <ref>` + `supabase db push`

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

Папка `MD WIKI/CLAUDE/` — база знаний проекта.

**Источник истины — синхронизируемый Obsidian-vault** `D:\Dropbox\Приложения\remotely-save\Золотые Пески России\MD WIKI`
(remotely-save → синхронизация на телефон/др. устройства). В репозиторий WIKI **не коммитится** —
доступ через directory junction `MD WIKI\` (восстановить: `.\scripts\link-wiki.ps1`).
Obsidian (`D:\Dropbox\Obsidian\Tigra\ЗПР\`) — хранилище отчётных форм (ПРОТ-*, ПРОБ-*), не база знаний.

### Структура MD WIKI

| Файл | Тема |
|------|------|
| `CLAUDE/01_СТРУКТУРА_ПРОЕКТА.md` | 4 уровня хранения, взаимодействие |
| `CLAUDE/02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ.md` | Папки, коды объектов, именование, типы документов |
| `CLAUDE/03_ПРОГРАММНЫЙ_КОД.md` | Репозиторий, скрипты, git |
| `CLAUDE/04_MD_WIKI.md` | MD WIKI — база знаний, индекс файлов |
| `CLAUDE/05_OBSIDIAN.md` | Obsidian — отчётные формы в Dropbox |
| `CLAUDE/06_БАЗА_ДАННЫХ.md` | Supabase: схема, роли, pgvector |
| `CLAUDE/07_Генерация_задач_и_кодировка.md` | Генерация задач из протоколов (LEGACY CLI) |
| `CLAUDE/08_Синхронизация_договоров.md` | Синхронизация договоров из Bitrix24 (LEGACY) |
| `CLAUDE/10_Алгоритм_собрания.md` | Обработка собраний (актуальный WEB-флоу) |
| `CLAUDE/11_График_и_отклонения.md` | ГПР, плановые даты, отклонения |
| `CLAUDE/12_Проблемы_объекта.md` | Журнал проблем (ПРОБ-*) |
| `CLAUDE/13_Workflow_входящие_документы.md` | Обработка входящей почты |
| `CLAUDE/14_Модель_событий.md` | Модель событий (журнал фактов: project_note / meeting / protocol_correction) |
| `CLAUDE/15_Календарь_объекта.md` | Календарь объекта (`calendar_entries`) — план/прогноз договорных вех |
| `CLAUDE/16_Регламент_миграций.md` | Регламент применения миграций БД (реестр + скрипт) |
| `CLAUDE/17_Сущность_Договор_и_ЮрЛицо.md` | Договор / ПунктДоговора / ЮрЛицо — сущности ветки «Договор» |
| `CLAUDE/18_Архитектура_модулей.md` | Модули A/B/C/D/E, две ветки + мост, поток данных |
| `CLAUDE/19_Сущность_Задача.md` | Сущность Задача (`tasks`) + per-object статусы |
| `CLAUDE/09_Правило_связей.md` | Правило: связи между сущностями — по UUID, имена JOIN'ом |
| `CLAUDE/21_Сущность_Отчёт.md` | Еженедельный/месячный отчёт (`reports` + `object_reports`) |
| `CLAUDE/22_Сущность_Контакт.md` | Справочник физлиц организаций (`contacts`) |
| `CLAUDE/23_Сущность_Юридическое_лицо.md` | Справочник юр.лиц (`legal_entities`): реквизиты, валидация, админ-экран |
| `CLAUDE/24_Стратегические_темы.md` | Стратегические темы (`strategic_topics`) — каркас управленческих рисков |
| `CLAUDE/20_AI_Ассистент.md` | AI-ассистент по материалам: RAG + pgvector + Polza.AI |
| `CLAUDE/25_Сущность_Объект.md` | Сущность Объект (`objects`) — каноническая таблица, источник правды по кодам |
| `CLAUDE/26_Внешние_каналы.md` | Telegram / Email / Bitrix — обзор inbox + outbox |
| `CLAUDE/27_Классификатор_событий.md` | tg/mail/bitrix → preliminary events (L1 правила + L2 LLM + ручной ревью) |
| `CLAUDE/28_Сущность_Новость.md` | Новости (`news`) — лента на главной + публикация в каналы |
| `CLAUDE/29_Сущность_Участок.md` | Участки (`plots` + `plot_polygons` + `plot_polygon_assignments` + `functional_objects`) — нормализованная модель ЗУ ↔ полигонов с версионированием границ. v0.5 |
| `CLAUDE/30_GIS.md` | Геопространственные данные: PostGIS, СК-63 z4, ArcGIS Pro, `object_geometries` |
| `CLAUDE/31_Данные_ПМТ_по_участкам.md` | Стейджинг-таблицы `pmt_*` — выгрузка из ПМТ (17 таблиц, ~3 100 точек координат) |
| `CLAUDE/32_План_импорта_ПМТ.md` | Фазовый план импорта ПМТ → целевую модель (Ф1 ЗУ → Ф2 ОКС → Ф3 нагрузки → Ф4 прочее) |
| `CLAUDE/Регламенты/` | Регламенты по типам документов и каналам (13 файлов): BITRIX, EMAIL, TELEGRAM, ГРАФИКИ, ДОГОВОРА, ИРД, МАТЕРИАЛЫ, ОБЪЕКТЫ, ПЕРЕПИСКА, СТАНДАРТЫ, ТЗ, ТУ, ФЗ |

> Архив: `09_Промпт_привязка_цитат.md` перенесён в `_АРХИВ/2026-05-08_аудит/` — промпты теперь в коде.
> Хроника проекта (журнал вех, новые записи сверху): `MD WIKI/Хроника проекта.md`.

### Правило чтения по подпроектам

**При каждом запросе Claude ОБЯЗАН** читать соответствующие файлы:

| Подпроект | Файлы |
|-----------|-------|
| Структура и хранилище | `01_СТРУКТУРА_ПРОЕКТА` + `02_ФАЙЛОВОЕ_ХРАНИЛИЩЕ` |
| Программный код | `03_ПРОГРАММНЫЙ_КОД` |
| MD WIKI | `04_MD_WIKI` |
| Obsidian / отчётные формы | `05_OBSIDIAN` |
| База данных | `06_БАЗА_ДАННЫХ` |
| Еженедельный/месячный отчёт | `21_Сущность_Отчёт` + `11_График_и_отклонения` |
| Обработка собраний | `10_Алгоритм_собрания` + `19_Сущность_Задача` |
| Проблемы объекта | `12_Проблемы_объекта` |
| Входящие документы | `13_Workflow_входящие_документы` + `Регламенты/Регламент_{ТИП}` |
| Договоры (загрузка, пункты) | `17_Сущность_Договор_и_ЮрЛицо` + `18_Архитектура_модулей` |
| События / журнал фактов | `14_Модель_событий` + `09_Правило_связей` |
| Календарь / плановые вехи | `15_Календарь_объекта` |
| Задачи (`tasks`) | `19_Сущность_Задача` |
| Связи между сущностями | `09_Правило_связей` |
| Контакты / физлица | `22_Сущность_Контакт` |
| Юр.лица (`legal_entities`) | `23_Сущность_Юридическое_лицо` |
| Стратегические темы | `24_Стратегические_темы` |
| AI-ассистент / поиск с ответами | `20_AI_Ассистент` + `06_БАЗА_ДАННЫХ` |
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
