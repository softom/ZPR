# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Проект

**ЗПР = «Золотые Пески России»** — Python-скрипты для управления проектом.
Пользователь: Артемий Ю. Антипов, Руководитель проекта.

Obsidian-хранилище (данные): `D:\Dropbox\Obsidian\Tigra\ЗПР\`
Код (этот репозиторий): `D:\Dropbox\CODE\zpr_code\`

Подробная документация по проекту: `D:\Dropbox\Obsidian\Tigra\ЗПР\CLAUDE.md`

---

## Скрипты

| Скрипт | Назначение | Запуск |
|--------|-----------|--------|
| `config.py` | Пути, API-ключи, маппинг объектов | — |
| `llm_client.py` | Обёртка над Polza.AI (LLM + эмбеддинги) | — |
| `contracts_indexer.py` | Синхронизация и индексирование договоров | `python contracts_indexer.py` |
| `meeting_processor.py` | Генерация задач из транскрипции собрания | `python meeting_processor.py "ПОДРЯДЧИКИ/МЛА+/Собрания/2026-04-17 ..."` |
| `protocol_generator.py` | Генерация протокола .docx из MD-задач | `python protocol_generator.py "ПОДРЯДЧИКИ/Бюро82/Собрания/2026-04-17 ..."` |
| `pinecone_indexer.py` | Индексирование документов в Pinecone | `python pinecone_indexer.py` |
| `report_generator.py` | Еженедельный отчёт | `python report_generator.py` |

---

## Конфигурация

API-ключи хранятся в `config.py` (не в git).
LLM-модель задаётся в `D:\Dropbox\Obsidian\Tigra\ЗПР\CLAUDE.md` → раздел `## LLM`.

```
LLM_MODEL: anthropic/claude-sonnet-4.6
LLM_PROVIDER: polza
POLZA_BASE_URL: https://polza.ai/api/v1
```

---

## Зависимости

```bash
pip install -r requirements.txt
```
