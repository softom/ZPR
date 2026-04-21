"""
schedule_parser.py — парсинг плановых дат из Excel ГПР (MS Project export)

Читает: SCHEDULE_DIR/**/Совмещенный график*.xlsx  (последний по имени папки)
Лист:   Таблица_задач
Колонки: Ид | Активная | Режим | Название | Длительность | Начало | Окончание
         | Предшественники | Уровень структуры | Заметки

Структура:
  Level 1 = секция стадии (Форэскиз, Концепция, Проект, Экспертиза, РНС)
  Level 2 = строка объекта — start/end = плановые даты стадии по объекту
  Level 3+ = подэтапы (не используются)

Возвращает:
  {obj_code: {stage_code: {"plan_start": date|None, "plan_end": date|None,
                            "status": str, "actual_end": date|None}}}
"""

import re
from datetime import date
from pathlib import Path

__all__ = ["load_schedule"]

MONTH_RU = {
    "Январь": 1, "Февраль": 2, "Март": 3, "Апрель": 4,
    "Май": 5, "Июнь": 6, "Июль": 7, "Август": 8,
    "Сентябрь": 9, "Октябрь": 10, "Ноябрь": 11, "Декабрь": 12,
}

# Паттерны для Level-1 названий → код стадии
# ВАЖНО: "Проект" не должен срабатывать на "Договорная работа обеспечения проекта"
STAGE_PATTERNS = [
    (re.compile(r"^форэскиз",             re.I), "Ф"),
    (re.compile(r"^концепци",             re.I), "К"),
    (re.compile(r"^проект(ная)?\s*($|\s)", re.I), "П"),
    (re.compile(r"^экспертиз",            re.I), "Э"),
    (re.compile(r"^получение разрешени",  re.I), "РНС"),
]

STATUS_MAP = {
    "выполнено":  "done",
    "в работе":   "in_progress",
    "не начато":  "pending",
}


def _parse_ru_date(s) -> "date | None":
    if not s:
        return None
    m = re.match(r"(\d+)\s+(\w+)\s+(\d{4})", str(s).strip())
    if not m:
        return None
    month = MONTH_RU.get(m.group(2).capitalize())
    if not month:
        return None
    try:
        return date(int(m.group(3)), month, int(m.group(1)))
    except ValueError:
        return None


def _parse_dmy(s: str) -> "date | None":
    if not s:
        return None
    m = re.match(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s.strip())
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def _parse_notes(notes) -> dict:
    result = {}
    if not notes:
        return result
    for part in str(notes).split("|"):
        if ":" in part:
            k, _, v = part.partition(":")
            result[k.strip().lower()] = v.strip()
    return result


def _stage_for(name: str) -> "str | None":
    for pattern, code in STAGE_PATTERNS:
        if pattern.match(name.strip()):
            return code
    return None


def load_schedule(schedule_dir: Path, excel_name_to_code: dict) -> dict:
    """Возвращает {obj_code: {stage_code: {plan_start, plan_end, status, actual_end}}}."""
    try:
        import openpyxl
    except ImportError:
        return {}

    files = sorted(schedule_dir.rglob("*.xlsx"))
    if not files:
        return {}

    try:
        wb = openpyxl.load_workbook(str(files[-1]), read_only=True, data_only=True)
        ws = wb["Таблица_задач"]
    except Exception:
        return {}

    result: dict = {}
    current_stage: "str | None" = None

    for row in ws.iter_rows(values_only=True):
        try:
            level = int(str(row[8] or ""))
        except (ValueError, TypeError):
            continue

        name = str(row[3] or "").strip()

        if level == 1:
            current_stage = _stage_for(name)
            continue

        if level == 2 and current_stage:
            obj_code = excel_name_to_code.get(name)
            if not obj_code:
                continue

            n = _parse_notes(row[9])
            status = STATUS_MAP.get(n.get("status", "").lower(), "pending")
            actual_end = _parse_dmy(n.get("actual finish", "")) if n.get("actual finish") else None

            result.setdefault(obj_code, {})[current_stage] = {
                "plan_start": _parse_ru_date(row[5]),
                "plan_end":   _parse_ru_date(row[6]),
                "status":     status,
                "actual_end": actual_end,
            }

    return result
