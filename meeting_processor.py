"""
meeting_processor.py — генератор задач из собрания ЗПР

Читает:
  - Участники.md (участники + Обязательные пункты)
  - транскрипцию .csv (Speaker, Start, Text)
Создаёт через LLM:
  - Задачи/ПРОТ-YYYY-MM-DD-КОД-ЗАД-NN.md  — по одному файлу на задачу
  - _задачи.md                               — Obsidian Dataview-индекс

Запуск:
  python meeting_processor.py "ПОДРЯДЧИКИ/МЛА+/Собрания/2026-04-17 Рабочее собрание"
  python meeting_processor.py "..." --dry-run   # показать задачи без записи
"""

import sys
import re
import csv
import json
import argparse
from datetime import date, datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from config import BASE_DIR

# ─── Коды подрядчиков ─────────────────────────────────────────────────────────

CONTRACTOR_CODES = {
    "хэдс": "ХГ", "хедс": "ХГ", "heads": "ХГ", "headsgroup": "ХГ",
    "мла":  "МЛА", "mla":  "МЛА",
    "8d":   "8D",  "8д":   "8D", "акулова": "8D",
    "бюро": "Б82", "симоненко": "Б82", "бюро82": "Б82",
    "зпр":  "ЗПР", "общее": "ЗПР",  # общепроектные собрания
}

OBJECT_CODES = {
    "00_ЗПР",
    "01_APT_375", "02_FAM_800", "03_FAM_500", "04_HLT_260",
    "05_EMR_340", "06_CLB_350", "07_SEL_400", "08_PRS_450",
}

# ─── Чтение Участники.md ──────────────────────────────────────────────────────

def parse_participants_file(path: Path) -> dict:
    """Извлекает метаданные, таблицу участников и обязательные пункты."""
    text = path.read_text(encoding="utf-8")

    # frontmatter
    fm = {}
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                fm[k.strip()] = v.strip().strip("#").strip()

    # Таблица участников (весь MD-блок)
    participants_block = ""
    m = re.search(r"## Участники\n(.*?)(?=\n##|\Z)", text, re.DOTALL)
    if m:
        participants_block = m.group(1).strip()

    # Обязательные пункты
    mandatory = []
    m = re.search(r"## Обязательные пункты для протокола\n(.*?)(?=\n##|\Z)", text, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            line = line.strip()
            point = re.sub(r"^(\d+[.)]\s*|<!--.*?-->\s*)", "", line).strip()
            if point and not point.startswith("<!--"):
                mandatory.append(point)

    return {
        "meeting":      fm.get("meeting", ""),
        "date":         fm.get("date", ""),
        "project":      fm.get("project", ""),
        "participants": participants_block,
        "mandatory":    mandatory,
    }


# ─── Чтение транскрипции CSV ──────────────────────────────────────────────────

def parse_transcription(path: Path) -> str:
    """Читает CSV Телемоста/Zoom, возвращает форматированный текст."""
    lines = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            speaker = row.get("Speaker") or row.get("Говорящий") or "?"
            start   = row.get("Start")   or row.get("Время")     or ""
            text    = row.get("Text")    or row.get("Текст")     or ""
            if text.strip():
                lines.append(f"[{start}] {speaker}: {text.strip()}")
    return "\n".join(lines)


# ─── Определение кода подрядчика ──────────────────────────────────────────────

def detect_contractor_code(meeting_folder: Path) -> str:
    """Угадывает код подрядчика из пути папки."""
    path_lower = str(meeting_folder).lower()
    for key, code in CONTRACTOR_CODES.items():
        if key in path_lower:
            return code
    return "ДОГ"


# ─── LLM: генерация задач ────────────────────────────────────────────────────

TASK_SCHEMA = """{
  "tasks": [
    {
      "title":       "<краткое название задачи — до 80 символов>",
      "explanation": "<подробное описание, что конкретно нужно сделать>",
      "object":      "<код объекта: 01_APT_375 / 02_FAM_800 / ... / all-МЛА / all>",
      "objects":     ["<код1>", "<код2>"],  // только если object = all-XXX
      "assignee":    "<название организации-исполнителя>",
      "due":         "<YYYY-MM-DD или пустая строка>",
      "priority":    "<high / medium / low>",
      "quotes":      ["<дословная цитата из транскрипции>"]
    }
  ]
}"""

SYSTEM_PROMPT = """Ты — ассистент руководителя проекта «Золотые Пески России» (ЗПР).
Твоя задача — извлечь из транскрипции рабочего собрания все задачи, поручения и решения.

ПРАВИЛА:
1. Каждое поручение / решение / договорённость → отдельная задача.
2. title — конкретный глагол + объект: «Разработать схему зонирования», не «Вопрос о зонировании».
3. object — код объекта из списка: 01_APT_375 / 02_FAM_800 / 03_FAM_500 / 04_HLT_260 /
   05_EMR_340 / 06_CLB_350 / 07_SEL_400 / 08_PRS_450.
   Если задача касается всех объектов подрядчика — «all-МЛА» (или all-ХГ, all-8D, all-Б82).
4. assignee — организация-исполнитель (не физлицо).
5. due — если в тексте назван конкретный срок — зафикируй его (YYYY-MM-DD).
   Если срок не назван — пустая строка.
6. priority:
   high   — блокирует следующий этап или срок ≤ 2 недели
   medium — важно, но не блокирует
   low    — желательно, срок не критичен
7. quotes — 1–3 дословные цитаты, подтверждающие задачу.
8. Не дублируй задачи. Объединяй близкие поручения в одну задачу.
9. Отвечай ТОЛЬКО валидным JSON по схеме ниже — без пояснений."""


def generate_tasks_llm(info: dict, transcription: str) -> list[dict]:
    """Шаг 1: LLM извлекает задачи из транскрипции."""
    from llm_client import ask_llm_json

    prompt = f"""Собрание: {info['meeting']}
Дата: {info['date']}
Проект/объект: {info['project']}

Участники:
{info['participants']}

Транскрипция:
{transcription}

Верни JSON по схеме:
{TASK_SCHEMA}"""

    print("  [LLM] извлечение задач из транскрипции...")
    result = ask_llm_json(prompt, system=SYSTEM_PROMPT, max_tokens=6000)
    if isinstance(result, dict) and "tasks" in result:
        tasks = result["tasks"]
        print(f"  [LLM] извлечено задач: {len(tasks)}")
        return tasks
    if isinstance(result, list):
        return result
    print("  [LLM] ошибка формата ответа")
    return []


def check_mandatory_points_llm(tasks: list[dict], mandatory: list[str], date_str: str) -> list[dict]:
    """Шаг 2: LLM проверяет покрытие обязательных пунктов и добавляет/правит задачи."""
    if not mandatory:
        return tasks

    from llm_client import ask_llm_json

    tasks_brief = [{"num": i+1, "title": t["title"]} for i, t in enumerate(tasks)]

    prompt = f"""Дата собрания: {date_str}

Ниже — список уже извлечённых задач и список ОБЯЗАТЕЛЬНЫХ пунктов протокола.

Обязательные пункты (должны быть покрыты задачами):
{chr(10).join(f"{i+1}. {p}" for i, p in enumerate(mandatory))}

Уже извлечённые задачи:
{json.dumps(tasks_brief, ensure_ascii=False, indent=2)}

Для каждого обязательного пункта определи:
- COVERED: задача под номером N уже покрывает его (достаточно смысловое совпадение)
- RENAME: задача под номером N покрывает, но title нужно скорректировать → дай новый title
- ADD: ни одна задача не покрывает — нужно добавить новую задачу

Верни JSON:
{{
  "checks": [
    {{
      "mandatory_num": 1,
      "action": "COVERED" | "RENAME" | "ADD",
      "task_num": <номер задачи или null>,
      "new_title": "<новый title если RENAME или ADD>",
      "explanation": "<описание если ADD>"
    }}
  ]
}}"""

    print("  [LLM] проверка обязательных пунктов...")
    result = ask_llm_json(prompt)
    if not isinstance(result, dict) or "checks" not in result:
        print("  [LLM] не удалось проверить обязательные пункты")
        return tasks

    for check in result["checks"]:
        action = check.get("action")
        task_num = check.get("task_num")  # 1-based
        mnum = check.get("mandatory_num", "?")

        if action == "COVERED":
            print(f"  ✅ Обяз.п.{mnum} → покрыт задачей #{task_num}")

        elif action == "RENAME" and task_num and 1 <= task_num <= len(tasks):
            old = tasks[task_num-1]["title"]
            tasks[task_num-1]["title"] = check["new_title"]
            print(f"  ✏️  Обяз.п.{mnum} → задача #{task_num} переименована: «{old}» → «{check['new_title']}»")

        elif action == "ADD":
            new_task = {
                "title":       check.get("new_title", mandatory[mnum-1] if isinstance(mnum, int) else ""),
                "explanation": check.get("explanation", mandatory[mnum-1] if isinstance(mnum, int) else ""),
                "object":      "all",
                "objects":     [],
                "assignee":    "",
                "due":         "",
                "priority":    "medium",
                "quotes":      [],
                "mandatory":   True,  # помечаем что добавлено из обязательных
            }
            tasks.append(new_task)
            print(f"  ➕ Обяз.п.{mnum} → добавлена новая задача: «{new_task['title']}»")

    return tasks


def enrich_mandatory_tasks_llm(tasks: list[dict], transcription: str) -> list[dict]:
    """Шаг 3: для задач из обязательных пунктов (mandatory=True) ищет цитаты
    в транскрипции и при наличии контекста уточняет название задачи."""
    mandatory_tasks = [(i, t) for i, t in enumerate(tasks) if t.get("mandatory") and not t.get("quotes")]
    if not mandatory_tasks:
        return tasks

    from llm_client import ask_llm_json

    for idx, task in mandatory_tasks:
        prompt = f"""В транскрипции рабочего собрания найди фрагменты, относящиеся к следующей теме:

Тема: «{task['title']}»

Описание: {task.get('explanation', '')}

Из найденных фрагментов:
1. Выбери 1–3 наиболее точных дословных цитаты (если есть).
2. Уточни title задачи — сделай его конкретнее, если цитаты дают дополнительный контекст.
   Если тема в транскрипции не упомянута — оставь title без изменений.

Верни JSON:
{{
  "quotes": ["<цитата 1>", "<цитата 2>"],
  "title": "<уточнённое название задачи>"
}}

Транскрипция:
{transcription}"""

        result = ask_llm_json(prompt)
        if not isinstance(result, dict):
            continue

        new_quotes = result.get("quotes") or []
        new_title  = result.get("title", "").strip()

        if new_quotes:
            tasks[idx]["quotes"] = new_quotes
            print(f"  🔍 Задача #{idx+1}: найдено {len(new_quotes)} цит. в транскрипции")
        else:
            print(f"  🔍 Задача #{idx+1}: цитаты не найдены (тема не упомянута явно)")

        if new_title and new_title != task["title"]:
            old_title = tasks[idx]["title"]
            tasks[idx]["title"] = new_title
            print(f"  ✏️  Задача #{idx+1} уточнена: «{old_title}» → «{new_title}»")

    return tasks


# ─── Запись MD-файлов задач ───────────────────────────────────────────────────

def write_task_md(task: dict, code: str, output_dir: Path, meeting_date: str, is_mandatory: bool = False) -> Path:
    """Создаёт один MD-файл задачи."""
    # due: нормализуем в YYYY-MM-DD
    due = task.get("due", "")
    if due:
        m = re.match(r"(\d{4}-\d{2}-\d{2})", due)
        due = m.group(1) if m else ""

    today = date.today().isoformat()

    # Цитаты в раздел ## Цитаты
    quotes_md = ""
    quotes = task.get("quotes", [])
    if quotes:
        quotes_md = "\n## Цитаты из обсуждения\n\n"
        for q in quotes:
            quotes_md += f"> {q}\n\n"

    mandatory_note = "\n> ⚠️ Задача добавлена из списка обязательных пунктов протокола\n" if is_mandatory else ""

    content = f"""---
type: protocol
code: {code}
source: {code.rsplit('-ЗАД-', 1)[0]}
title: "{task.get('title', '').replace('"', "'")}"
explanation: "{task.get('explanation', '').replace('"', "'")}"
object: "{task.get('object', 'all')}"
objects: {json.dumps(task.get('objects', []), ensure_ascii=False)}
status: open
priority: {task.get('priority', 'medium')}
assignee: "{task.get('assignee', '')}"
due: "{due}"
done: false
done_date: ""
done_note: ""
created: {today}
tags:
  - protocol
---

# {task.get('title', '')}
{mandatory_note}
{task.get('explanation', '')}
{quotes_md}"""

    filepath = output_dir / f"{code}.md"
    filepath.write_text(content, encoding="utf-8")
    return filepath


# ─── Обзор собрания ──────────────────────────────────────────────────────────

OVERVIEW_SYSTEM = """Ты — ассистент руководителя проекта «Золотые Пески России».
Пишешь краткий деловой обзор рабочего собрания на русском языке.
Стиль: нейтральный, профессиональный, без вводных слов («итак», «таким образом»).
Не пересказывай транскрипцию дословно — выдели суть."""


def generate_overview_llm(info: dict, transcription: str, tasks: list[dict]) -> str:
    """Шаг 4: LLM формирует обзор собрания на основе транскрипции и задач."""
    from llm_client import ask_llm

    tasks_list = "\n".join(
        f"{i+1}. [{t.get('priority','?')}] {t['title']} "
        f"(исп.: {t.get('assignee','—')}, срок: {t.get('due','—') or '—'})"
        for i, t in enumerate(tasks)
    )

    prompt = f"""Собрание: {info['meeting']}
Дата: {info['date']}
Объект/проект: {info['project']}

Участники:
{info['participants']}

Зафиксированные задачи:
{tasks_list}

Транскрипция:
{transcription}

Напиши обзор собрания в формате Markdown:

## На собрании обсуждали
<2–4 абзаца: ключевые темы, принятые решения, принципиальные договорённости>

## Задачи
<По каждой задаче — краткий абзац (3–6 предложений): что нужно сделать, почему это важно,
что обсуждалось. Не более половины страницы на задачу.>

Не добавляй заголовков уровня # (только ##). Не перечисляй участников отдельно.
"""

    print("  [LLM] формирование обзора собрания...")
    result = ask_llm(prompt, system=OVERVIEW_SYSTEM, max_tokens=4000)
    return result or ""


def write_overview_md(meeting_folder: Path, info: dict, tasks: list[dict], overview_text: str, date_iso: str) -> Path:
    """Записывает Обзор.md в папку собрания."""
    # Дата в формате DD.MM.YYYY для заголовка
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", date_iso)
    date_display = f"{m.group(3)}.{m.group(2)}.{m.group(1)}" if m else date_iso

    content = f"""---
type: meeting-overview
meeting: "{info['meeting']}"
date: "{info['date']}"
project: "{info['project']}"
created: {date.today().isoformat()}
---

# Обзор собрания: {info['meeting']} — {date_display}

{overview_text}
"""
    filepath = meeting_folder / "Обзор.md"
    filepath.write_text(content, encoding="utf-8")
    return filepath


# ─── Obsidian Dataview-индекс ─────────────────────────────────────────────────

def write_dataview_index(output_dir: Path, meeting_info: dict, tasks_dir: Path):
    """Создаёт _задачи.md с Dataview-таблицей задач собрания."""
    # путь относительно корня хранилища Obsidian (BASE_DIR.parent)
    vault_root = BASE_DIR.parent
    rel_path = tasks_dir.relative_to(vault_root).as_posix()

    content = f"""---
type: meeting-tasks-index
meeting: "{meeting_info['meeting']}"
date: "{meeting_info['date']}"
project: "{meeting_info['project']}"
---

# Задачи собрания {meeting_info['meeting']} — {meeting_info['date']}

```dataview
TABLE
  title AS "Задача",
  assignee AS "Исполнитель",
  due AS "Срок",
  priority AS "Приоритет",
  status AS "Статус"
FROM "{rel_path}"
WHERE type = "protocol"
SORT priority DESC, due ASC
```

## Обязательные пункты

{chr(10).join(f"- {p}" for p in meeting_info.get('mandatory', []))}
"""
    index_file = output_dir.parent / "_задачи.md"
    index_file.write_text(content, encoding="utf-8")
    return index_file


# ─── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Генератор задач из собрания ЗПР")
    parser.add_argument("meeting_dir", help="Путь к папке собрания")
    parser.add_argument("--dry-run", action="store_true", help="Показать задачи без записи файлов")
    args = parser.parse_args()

    meeting_folder = Path(args.meeting_dir)
    if not meeting_folder.is_absolute():
        meeting_folder = BASE_DIR / meeting_folder
    if not meeting_folder.exists():
        print(f"❌ Папка не найдена: {meeting_folder}")
        sys.exit(1)

    # Ищем Участники.md
    participants_file = meeting_folder / "Участники.md"
    if not participants_file.exists():
        print("❌ Файл Участники.md не найден")
        sys.exit(1)

    # Ищем транскрипцию .csv
    csv_files = list(meeting_folder.glob("*.csv"))
    if not csv_files:
        print("❌ Транскрипция .csv не найдена")
        sys.exit(1)
    transcription_file = csv_files[0]

    print(f"\n📋 Собрание: {meeting_folder.name}")
    print(f"📄 Транскрипция: {transcription_file.name}")

    # Парсинг входных данных
    info = parse_participants_file(participants_file)
    transcription = parse_transcription(transcription_file)

    print(f"👥 Участников: {info['participants'].count('|') // 2}")
    print(f"📌 Обязательных пунктов: {len(info['mandatory'])}")
    print(f"💬 Строк транскрипции: {transcription.count(chr(10))}")

    # Дата из frontmatter или имени папки
    meeting_date = info["date"]
    if not meeting_date:
        m = re.match(r"(\d{4}-\d{2}-\d{2})", meeting_folder.name)
        meeting_date = m.group(1) if m else date.today().isoformat()

    # Нормализуем дату к YYYY-MM-DD
    date_iso = meeting_date
    m = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", meeting_date)
    if m:
        date_iso = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"

    # Код подрядчика
    contractor_code = detect_contractor_code(meeting_folder)

    # Шаг 1: LLM извлекает задачи
    tasks = generate_tasks_llm(info, transcription)
    if not tasks:
        print("❌ LLM не вернул задач")
        sys.exit(1)

    # Шаг 2: проверка обязательных пунктов
    tasks = check_mandatory_points_llm(tasks, info["mandatory"], date_iso)

    # Шаг 3: обогащение задач из обязательных пунктов цитатами
    tasks = enrich_mandatory_tasks_llm(tasks, transcription)

    # Вывод итогов
    print(f"\n{'─'*55}")
    print(f"Итого задач: {len(tasks)}")
    for i, t in enumerate(tasks, 1):
        flag = "📌" if t.get("mandatory") else "  "
        print(f"  {flag} {i:2d}. [{t.get('priority','?'):6}] {t['title'][:60]}")

    if args.dry_run:
        print("\n[dry-run] файлы не записаны")
        return

    # Создаём папку Задачи/
    tasks_dir = meeting_folder / "Задачи"
    tasks_dir.mkdir(exist_ok=True)

    # Записываем MD-файлы
    print(f"\n💾 Записываем задачи в {tasks_dir.relative_to(BASE_DIR)}/")
    for i, task in enumerate(tasks, 1):
        code = f"ПРОТ-{date_iso}-{contractor_code}-ЗАД-{i:02d}"
        is_mandatory = task.pop("mandatory", False)
        filepath = write_task_md(task, code, tasks_dir, date_iso, is_mandatory)
        print(f"  ✅ {filepath.name}")

    # Dataview-индекс
    index_file = write_dataview_index(tasks_dir, {**info, "date": meeting_date}, tasks_dir)
    print(f"\n📊 Dataview-индекс: {index_file.name}")

    # Шаг 4: обзор собрания
    overview_text = generate_overview_llm(info, transcription, tasks)
    if overview_text:
        overview_file = write_overview_md(meeting_folder, info, tasks, overview_text, date_iso)
        print(f"📝 Обзор: {overview_file.name}")
    else:
        print("⚠️  Обзор не сформирован (LLM не ответил)")

    print(f"\n✅ Готово. Откройте {meeting_folder.name}/_задачи.md или Обзор.md в Obsidian.")


if __name__ == "__main__":
    main()
