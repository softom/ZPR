"""
report_generator.py — еженедельный отчёт по проекту ЗПР

Читает:
  - ОБЪЕКТЫ/*/Задачи/*.md          — задачи конкретных объектов
  - ПОДРЯДЧИКИ/*/Задачи/*.md       — задачи по всем объектам подрядчика
  - _ОБЩЕЕ/Задачи/*.md             — общепроектные задачи
  - _ОБЩЕЕ/ДОГОВОРА_ИНДЕКС/        — реестр договоров и этапы

Создаёт:
  - ОТЧЁТЫ/Отчёт_YYYY-MM-DD.md

Запуск:
  python report_generator.py
  python report_generator.py --date 2026-04-17
  python report_generator.py --dry-run
"""

import sys
import re
import json
import argparse
from datetime import date, timedelta, datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from config import (
    BASE_DIR, OBJECTS_DIR, CONTRACTORS_DIR, REPORTS_DIR,
    REGISTRY, CONTRACTS_DIR, OBJECT_NAMES, OBJECT_FOLDERS, SCHEDULE_DIR,
    EXCEL_NAME_TO_CODE,
)
from schedule_parser import load_schedule

# ─── Справочники ───────────────────────────────────────────────────────────────

OBJECT_ORDER = [
    "01_APT_375", "02_FAM_800", "03_FAM_500", "04_HLT_260",
    "05_EMR_340", "06_CLB_350", "07_SEL_400", "08_PRS_450",
]

OBJECT_CONTRACTOR = {
    "02_FAM_800": "ХэдсГрупп",
    "03_FAM_500": "ХэдсГрупп",
    "04_HLT_260": "ХэдсГрупп",
    "08_PRS_450": "ХэдсГрупп",
    "05_EMR_340": "8D",
    "06_CLB_350": "МЛА+",
    "07_SEL_400": "Бюро82",
}

CONTRACTOR_TAG = {
    "ХэдсГрупп": {"хг", "hg", "хэдс", "heads"},
    "8D":         {"8d", "8д"},
    "МЛА+":       {"мла", "mla"},
    "Бюро82":     {"б82", "бюро", "b82", "бюро82"},
}

STAGE_ICONS = {
    "done":        "✅",
    "in_progress": "🔄",
    "in-progress": "🔄",
    "overdue":     "⚠️",
    "pending":     "🔲",
}

PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}

PROBLEM_WINDOW = 5  # дней: окно показа «новых» и «решённых» проблем

STAGE_DISPLAY = {
    "Ф":   "Форэскиз",
    "К":   "Концепция",
    "П":   "Проект",
    "Э":   "Экспертиза",
    "РНС": "РНС",
}
STAGE_ORDER = ["Ф", "К", "П", "Э", "РНС"]

# ─── Разбор frontmatter задачи ─────────────────────────────────────────────────

def parse_task(path: Path) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None
    fm: dict = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" ") and not line.startswith("-"):
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip().strip('"').strip("'")
    fm.setdefault("status", "open")
    fm.setdefault("priority", "medium")
    fm.setdefault("object", "")
    fm.setdefault("due", "")
    fm.setdefault("assignee", "")
    fm["_path"] = str(path)

    # Для проблем: title = H1 из тела, иначе имя файла
    body = text[m.end():].strip()
    h1 = re.search(r"^#\s+(.+)", body, re.MULTILINE)
    fm.setdefault("title", h1.group(1).strip() if h1 else path.stem)

    # Первый абзац тела (не H1) = краткое описание
    body_lines = [l for l in body.splitlines() if l.strip() and not l.startswith("#")]
    fm.setdefault("_body", body_lines[0].strip() if body_lines else "")

    return fm


def collect_all_tasks() -> list[dict]:
    tasks = []
    for p in OBJECTS_DIR.glob("*/Задачи/*.md"):
        t = parse_task(p)
        if t:
            tasks.append(t)
    for p in CONTRACTORS_DIR.glob("*/Задачи/*.md"):
        t = parse_task(p)
        if t:
            tasks.append(t)
    general_dir = BASE_DIR / "_ОБЩЕЕ" / "Задачи"
    if general_dir.exists():
        for p in general_dir.glob("*.md"):
            t = parse_task(p)
            if t:
                tasks.append(t)
    return tasks


def _contractor_for_obj(obj_code: str) -> str:
    return OBJECT_CONTRACTOR.get(obj_code, "")


def _tag_matches_contractor(tag: str, contractor: str) -> bool:
    return tag.lower() in CONTRACTOR_TAG.get(contractor, set())


def tasks_for_object(all_tasks: list[dict], obj_code: str) -> list[dict]:
    """Возвращает задачи, относящиеся к данному объекту."""
    contractor = _contractor_for_obj(obj_code)
    result = []
    seen = set()
    for t in all_tasks:
        obj = t.get("object", "")
        path = t["_path"]
        if obj == obj_code:
            if path not in seen:
                seen.add(path)
                result.append(t)
        elif obj.startswith("all-"):
            tag = obj[4:]
            if contractor and _tag_matches_contractor(tag, contractor):
                if path not in seen:
                    seen.add(path)
                    result.append(t)
    return result


def tasks_general(all_tasks: list[dict]) -> list[dict]:
    """Задачи, помеченные как общепроектные (не привязанные к конкретному объекту)."""
    return [t for t in all_tasks if t.get("object") in ("all", "00_ЗПР", "")]


# ─── Проблемы объекта ─────────────────────────────────────────────────────────

def _parse_date(s: str) -> date | None:
    """YYYY-MM-DD → date, или None если пусто/неверно."""
    if not s:
        return None
    try:
        return datetime.strptime(s.strip(), "%Y-%m-%d").date()
    except ValueError:
        return None


def collect_problems_for_object(obj_code: str) -> list[dict]:
    """Читает все ПРОБ-*.md из ОБЪЕКТЫ/{obj_code}/Проблемы/."""
    folder_name = OBJECT_FOLDERS.get(obj_code, "")
    if not folder_name:
        return []
    prob_dir = OBJECTS_DIR / folder_name / "Проблемы"
    if not prob_dir.exists():
        return []
    problems = []
    for p in prob_dir.glob("*.md"):
        t = parse_task(p)
        if t:
            problems.append(t)
    return problems


def classify_problems(problems: list[dict], report_date: date):
    """Делит проблемы на три группы по логике +5 дней.

    Returns:
        fresh       — 🔴 новые (found_date >= report_date − PROBLEM_WINDOW)
        open_probs  — 🟡 требуют решения (open, старше окна)
        done_recent — ✅ решённые за период (done_date >= report_date − PROBLEM_WINDOW)
        Архив (done старше окна) — не возвращается, не показывается.
    """
    cutoff = report_date - timedelta(days=PROBLEM_WINDOW)
    fresh, open_probs, done_recent = [], [], []

    for p in problems:
        status  = p.get("status", "open")
        found_d = _parse_date(p.get("found_date", ""))
        done_d  = _parse_date(p.get("done_date", ""))

        if status == "done":
            if done_d and done_d >= cutoff:
                done_recent.append(p)
            # иначе — архив, не показываем
        else:
            if found_d and found_d >= cutoff:
                fresh.append(p)
            else:
                open_probs.append(p)

    return fresh, open_probs, done_recent


# ─── Ленточный график (Mermaid Gantt) ────────────────────────────────────────

# Latin IDs for Mermaid (Cyrillic not safe in all renderers)
_STAGE_ID = {"Ф": "pF", "К": "pK", "П": "pP", "Э": "pE", "РНС": "pRNS"}

_MERMAID_STATUS = {
    "done":        "done,",
    "in_progress": "active,",
    "overdue":     "crit,",
    "pending":     "",
}

# Contract type keywords → stage code (for table matching)
_CONTRACT_STAGE_KEYWORDS = [
    ("форэскиз",  "Ф"),
    ("агк",       "Ф"),
    ("эскиз",     "Ф"),
    ("концепц",   "К"),
    ("проект",    "П"),
    ("эксперт",   "Э"),
    ("рнс",       "РНС"),
]

def _contract_stage_code(contract: dict) -> str:
    """Determine which plan stage this contract covers."""
    text = (contract.get("type", "") + " " + contract.get("contractor", "")).lower()
    for kw, code in _CONTRACT_STAGE_KEYWORDS:
        if kw in text:
            return code
    return "Ф"  # default


def fmt_mermaid_gantt(obj_name: str, obj_contracts: list, obj_schedule: dict) -> list[str]:
    """Mermaid Gantt: section Плановые (ГПР) + section Договорные."""

    plan_rows = []
    for code in STAGE_ORDER:
        s = obj_schedule.get(code)
        if not s:
            continue
        start = s.get("plan_start")
        end   = s.get("plan_end")
        if not start or not end:
            continue
        ms = _MERMAID_STATUS.get(s.get("status", "pending"), "")
        label = STAGE_DISPLAY.get(code, code)
        pid = _STAGE_ID.get(code, f"p{code}")
        plan_rows.append(f"    {label} :{ms} {pid}, {start}, {end}")

    cont_rows = []
    for ci, c in enumerate(obj_contracts):
        signed_d = _parse_date(c.get("signed", ""))
        prev_end = signed_d
        for s in c.get("stages", []):
            start = _parse_date(s.get("start", "")) or prev_end
            end   = _parse_date(s.get("due", ""))
            if not start:
                continue
            if not end:
                prev_end = start
                continue
            status = s.get("status", "pending").replace("-", "_")
            ms = _MERMAID_STATUS.get(status, "")
            title = (s.get("title") or f"Этап {s.get('num','?')}")[:24]
            sid = f"c{ci}s{s.get('num', 0)}"
            cont_rows.append(f"    {title} :{ms} {sid}, {start}, {end}")
            prev_end = end

    if not plan_rows and not cont_rows:
        return []

    lines = ["```mermaid", "gantt",
             f"    title {obj_name}",
             "    dateFormat YYYY-MM-DD",
             "    axisFormat %b'%y"]
    if plan_rows:
        lines.append("    section Плановые (ГПР)")
        lines += plan_rows
    if cont_rows:
        lines.append("    section Договорные")
        lines += cont_rows
    lines += ["```", ""]
    return lines


def fmt_dates_table(obj_contracts: list, obj_schedule: dict) -> list[str]:
    """Два блока: план (все стадии) + договор (только там где подписан)."""

    def _fmt(d): return d.strftime("%d.%m.%y") if d else "—"
    def _delta(plan_end, cont_end):
        if plan_end and cont_end:
            d = (cont_end - plan_end).days
            return f"+{d}д" if d > 0 else (f"{d}д" if d else "—")
        return "—"
    STATUS_ICON = {"done": "✅", "in_progress": "🔄", "pending": "🔲", "overdue": "⚠️"}

    lines: list[str] = []

    # ── Блок 1: Плановые сроки (ГПР) ────────────────────────────────────────
    plan_rows = []
    for code in STAGE_ORDER:
        s = obj_schedule.get(code)
        if not s:
            continue
        icon = STATUS_ICON.get(s.get("status", "pending"), "—")
        plan_rows.append(
            f"| {STAGE_DISPLAY.get(code, code)}"
            f" | {_fmt(s.get('plan_start'))}"
            f" | {_fmt(s.get('plan_end'))}"
            f" | {icon} |"
        )

    if plan_rows:
        lines += [
            "**📅 Плановые сроки (ГПР):**",
            "",
            "| Стадия | Начало | Конец | Ст |",
            "|--------|--------|-------|----|",
            *plan_rows,
            "",
        ]

    # ── Блок 2: Договорные сроки (только подписанные) ───────────────────────
    cont_rows = []
    for c in obj_contracts:
        stage_code = _contract_stage_code(c)
        signed_d   = _parse_date(c.get("signed", ""))
        dues       = [_parse_date(s.get("due", "")) for s in c.get("stages", [])]
        dues       = [d for d in dues if d]
        last_due   = max(dues) if dues else None
        cid        = c.get("contract_id", "—")

        plan_s = obj_schedule.get(stage_code, {})
        pe     = plan_s.get("plan_end") if plan_s else None

        cont_rows.append(
            f"| {cid}"
            f" | {STAGE_DISPLAY.get(stage_code, stage_code)}"
            f" | {_fmt(signed_d)}"
            f" | {_fmt(last_due)}"
            f" | {_delta(pe, last_due)} |"
        )

    if cont_rows:
        lines += [
            "**📋 Договорные сроки:**",
            "",
            "| Договор | Стадия | Подписан | Срок | Откл от плана |",
            "|---------|--------|----------|------|---------------|",
            *cont_rows,
            "",
        ]

    return lines


def find_schedule_link() -> str:
    """Returns Obsidian wikilink to latest schedule Excel file, or empty string."""
    if not SCHEDULE_DIR.exists():
        return ""
    files = sorted(SCHEDULE_DIR.rglob("*.xlsx"))
    if not files:
        return ""
    return f"[[{files[-1].stem}|График производства работ 📊]]"


# ─── Загрузка договоров ────────────────────────────────────────────────────────

def load_contracts() -> dict[str, list[dict]]:
    """Возвращает {object_code: [contract_detail, ...]}."""
    if not REGISTRY.exists():
        return {}
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    result: dict[str, list] = {}
    for contract_id, summary in registry.items():
        obj_code = summary.get("object_code", "")
        detail_path = CONTRACTS_DIR / f"{contract_id}.json"
        detail = json.loads(detail_path.read_text(encoding="utf-8")) if detail_path.exists() else summary
        result.setdefault(obj_code, []).append(detail)
    return result


# ─── Форматирование ────────────────────────────────────────────────────────────

def fmt_stages(stages: list[dict]) -> str:
    if not stages:
        return "  *Этапы не определены*"
    lines = []
    for s in stages:
        icon = STAGE_ICONS.get(s.get("status", "pending"), "🔲")
        num = s.get("num", "?")
        title = s.get("title", "—")
        due = s.get("due", "")
        due_str = f" — срок {due}" if due else ""
        lines.append(f"  {icon} Этап {num}: {title}{due_str}")
    return "\n".join(lines)


def sort_key(t: dict) -> tuple:
    prio = PRIORITY_ORDER.get(t.get("priority", "medium"), 1)
    due = t.get("due", "") or "9999-99-99"
    # Convert DD.MM.YYYY → YYYY-MM-DD for sorting
    m = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", due)
    if m:
        due = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return (prio, due)


def fmt_task(t: dict) -> str:
    priority = t.get("priority", "medium")
    icon = "❗ " if priority == "high" else ""
    title = t.get("title", "—")
    due = t.get("due", "")
    assignee = t.get("assignee", "")
    due_str = f" _(до {due})_" if due else ""
    assign_str = f" — {assignee}" if assignee else ""
    return f"- {icon}{title}{due_str}{assign_str}"


def fmt_problems_block(fresh: list, open_probs: list, done_recent: list, report_date: date) -> list[str]:
    """Формирует MD-блок трёх секций проблем объекта."""
    lines: list[str] = []

    if fresh:
        lines += [
            "**🔴 Свежевыявленные проблемы:**",
            "",
            "| Проблема | Описание | Выявлена | Срок |",
            "|----------|----------|----------|------|",
        ]
        for p in sorted(fresh, key=lambda x: PRIORITY_ORDER.get(x.get("priority", "medium"), 1)):
            icon = "❗ " if p.get("priority") == "high" else ""
            lines.append(
                f"| {icon}{p.get('title', '')} | {p.get('_body', '')} "
                f"| {p.get('found_date', '')} | {p.get('due', '—')} |"
            )
        lines.append("")

    if open_probs:
        lines += [
            "**🟡 Требуют решения:**",
            "",
            "| Проблема | Описание | Открыта | Дней |",
            "|----------|----------|---------|------|",
        ]
        for p in sorted(open_probs, key=lambda x: (PRIORITY_ORDER.get(x.get("priority", "medium"), 1), x.get("found_date", ""))):
            found_d = _parse_date(p.get("found_date", ""))
            age = (report_date - found_d).days if found_d else "?"
            icon = "❗ " if p.get("priority") == "high" else ""
            lines.append(
                f"| {icon}{p.get('title', '')} | {p.get('_body', '')} "
                f"| {p.get('found_date', '')} | {age} |"
            )
        lines.append("")

    if done_recent:
        lines += [
            "**✅ Решено за период:**",
            "",
            "| Проблема | Решена | Решение |",
            "|----------|--------|---------|",
        ]
        for p in sorted(done_recent, key=lambda x: x.get("done_date", "")):
            solution = p.get("solution", "") or p.get("done_note", "") or "—"
            lines.append(
                f"| {p.get('title', '')} | {p.get('done_date', '')} | {solution} |"
            )
        lines.append("")

    return lines


def week_period(report_date: date) -> tuple[date, date]:
    mon = report_date - timedelta(days=report_date.weekday())
    sun = mon + timedelta(days=6)
    return mon, sun


# ─── Генерация ────────────────────────────────────────────────────────────────

def generate_report(report_date: date) -> str:
    all_tasks = collect_all_tasks()
    contracts = load_contracts()
    schedule  = load_schedule(SCHEDULE_DIR, EXCEL_NAME_TO_CODE)

    open_tasks = [t for t in all_tasks if t.get("status") != "done" and t.get("done", "").lower() != "true"]
    done_this_week = [
        t for t in all_tasks
        if t.get("status") == "done" or t.get("done", "").lower() == "true"
    ]

    mon, sun = week_period(report_date)
    period_str = f"{mon.strftime('%d.%m.%Y')} – {sun.strftime('%d.%m.%Y')}"

    lines: list[str] = []

    # ── Шапка ────────────────────────────────────────────────────────────────
    schedule_link = find_schedule_link()
    lines += [
        "# Отчёт о ходе работ",
        "",
        f"**Период:** {period_str}",
        f"**Дата составления:** {report_date.strftime('%d.%m.%Y')}",
        "**Автор:** Артемий Ю. Антипов, Руководитель проекта",
        "**Проект:** Туристический комплекс «Золотые пески России»",
        f"**График:** {schedule_link}" if schedule_link else "",
        "",
        "---",
        "",
    ]

    # ── Сводная таблица ───────────────────────────────────────────────────────
    lines += [
        "## Сводная таблица",
        "",
        "| Объект | Подрядчик | Договор | Этапы | Откр. задачи |",
        "|--------|-----------|---------|-------|--------------|",
    ]

    for obj_code in OBJECT_ORDER:
        obj_name = OBJECT_NAMES.get(obj_code, obj_code)
        contractor = OBJECT_CONTRACTOR.get(obj_code, "—")
        obj_contracts = contracts.get(obj_code, [])

        if obj_contracts:
            c = obj_contracts[0]
            stages = c.get("stages", [])
            done_cnt = sum(1 for s in stages if s.get("status") == "done")
            overdue_cnt = sum(1 for s in stages if s.get("status") == "overdue")
            stage_str = f"{done_cnt}/{len(stages)}"
            if overdue_cnt:
                stage_str += f" ⚠️{overdue_cnt}"
            contract_id = c.get("contract_id", "—")
        else:
            contract_id = "—"
            stage_str = "—"

        obj_open = tasks_for_object(open_tasks, obj_code)
        high_cnt = sum(1 for t in obj_open if t.get("priority") == "high")
        task_str = str(len(obj_open)) if obj_open else "—"
        if high_cnt:
            task_str += f" (❗{high_cnt})"

        lines.append(f"| {obj_name} | {contractor} | {contract_id} | {stage_str} | {task_str} |")

    lines += ["", "---", ""]

    # ── Статус по объектам ─────────────────────────────────────────────────────
    lines += ["## Статус по объектам", ""]

    for obj_code in OBJECT_ORDER:
        obj_name = OBJECT_NAMES.get(obj_code, obj_code)
        contractor = OBJECT_CONTRACTOR.get(obj_code, "—")
        obj_contracts = contracts.get(obj_code, [])
        obj_open = sorted(tasks_for_object(open_tasks, obj_code), key=sort_key)

        if not obj_contracts and not obj_open:
            continue

        lines += [f"### {obj_name}", f"*{contractor}*", ""]

        for c in obj_contracts:
            stages = c.get("stages", [])
            contract_id = c.get("contract_id", "")
            contract_type = c.get("type", "Договор")
            signed = c.get("signed", "")
            signed_str = f", подписан {signed}" if signed else ""
            lines.append(f"**{contract_type}** ({contract_id}{signed_str}):")
            lines.append(fmt_stages(stages))
            lines.append("")

        obj_schedule = schedule.get(obj_code, {})
        gantt = fmt_mermaid_gantt(obj_name, obj_contracts, obj_schedule)
        if gantt:
            lines += gantt
        dt = fmt_dates_table(obj_contracts, obj_schedule)
        if dt:
            lines += dt

        if obj_open:
            lines.append("**Открытые задачи:**")
            for t in obj_open:
                lines.append(fmt_task(t))
            lines.append("")

        problems = collect_problems_for_object(obj_code)
        if problems:
            fresh, open_probs, done_recent = classify_problems(problems, report_date)
            if fresh or open_probs or done_recent:
                lines += fmt_problems_block(fresh, open_probs, done_recent, report_date)

        lines += ["---", ""]

    # ── Общие задачи проекта ───────────────────────────────────────────────────
    general = sorted(tasks_general(open_tasks), key=sort_key)
    # exclude tasks with empty object that are really just unparsed
    general = [t for t in general if t.get("type") == "protocol" or t.get("object") in ("all", "00_ЗПР")]

    if general:
        lines += ["## Общие задачи проекта", ""]
        for t in general:
            lines.append(fmt_task(t))
        lines += ["", "---", ""]

    # ── Подпись ───────────────────────────────────────────────────────────────
    lines += [
        "**С уважением,**  ",
        "Антипов А.Ю.",
        "",
        f"*Дата составления: {report_date.strftime('%d.%m.%Y')}*",
    ]

    return "\n".join(lines)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Еженедельный отчёт ЗПР")
    parser.add_argument("--date", help="Дата YYYY-MM-DD (по умолчанию: сегодня)")
    parser.add_argument("--dry-run", action="store_true", help="Вывести в консоль без записи")
    args = parser.parse_args()

    report_date = (
        datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else date.today()
    )

    report_md = generate_report(report_date)

    if args.dry_run:
        print(report_md)
        return

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = REPORTS_DIR / f"Отчёт_{report_date.strftime('%Y-%m-%d')}.md"
    out_path.write_text(report_md, encoding="utf-8")
    print(f"Отчёт записан: {out_path}")


if __name__ == "__main__":
    main()
