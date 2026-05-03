#!/usr/bin/env python3
"""
test_contract_analysis.py — автономное тестирование LLM-анализа договоров.

Обходит Next.js и браузер: извлекает PDF → вызывает LLM напрямую → печатает результат.

Использование:
  python test_contract_analysis.py договор.pdf [приложение.pdf ...]
  python test_contract_analysis.py договор.pdf --save result.json
  python test_contract_analysis.py договор.pdf --no-color
"""
import sys, json, re, argparse, textwrap
from pathlib import Path
from datetime import date, datetime, timedelta

import pdfplumber
import requests

# ─── Config ───────────────────────────────────────────────────────────────────

try:
    from config import POLZA_BASE_URL, POLZA_API_KEY, LLM_MODEL
except ImportError:
    POLZA_BASE_URL = "https://polza.ai/api/v1"
    POLZA_API_KEY  = ""
    LLM_MODEL      = "anthropic/claude-sonnet-4.6"

MAX_TEXT_CHARS = 90_000

# ─── Colors ───────────────────────────────────────────────────────────────────

USE_COLOR = True

def c(text, code): return f"\033[{code}m{text}\033[0m" if USE_COLOR else text

GREEN  = lambda t: c(t, "32")
YELLOW = lambda t: c(t, "33")
RED    = lambda t: c(t, "31")
CYAN   = lambda t: c(t, "36")
BOLD   = lambda t: c(t, "1")
GRAY   = lambda t: c(t, "90")
VIOLET = lambda t: c(t, "35")

EVENT_ICONS = {
    "payment_advance":  "💰",
    "payment_final":    "✅",
    "milestone_start":  "▶ ",
    "milestone_end":    "⬛",
    "milestone_event":  "◆ ",
}

# ─── PDF extraction ────────────────────────────────────────────────────────────

def extract_pdf(path: Path) -> str:
    pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            pages.append(text)
    return "\n".join(pages)

# ─── Prompt (must match ui/app/api/contracts/analyze/route.ts) ────────────────

def build_prompt(text: str) -> str:
    truncated = text[:MAX_TEXT_CHARS] + "\n[...текст обрезан...]" if len(text) > MAX_TEXT_CHARS else text

    return f"""Ты помощник по обработке строительных договоров. Проанализируй текст и верни ТОЛЬКО JSON-объект без пояснений.

═══ СТОРОНЫ ДОГОВОРА ═══

Найди в тексте все стороны договора — обычно это ЗАКАЗЧИК и ПОДРЯДЧИК (или ИСПОЛНИТЕЛЬ, ПРОЕКТИРОВЩИК).
Не пытайся угадать кто из них ЗПР — просто читай договор.

"customer" — сторона с ролью «Заказчик» / «Технический заказчик» / «Застройщик»:
  - "name": полное наименование как в договоре
  - "role": как указана в договоре
  - "inn": ИНН (10 цифр), пустая строка если не найден
  - "kpp": КПП (9 цифр), пустая строка если не найден
  - "address": юридический адрес, пустая строка если не найден
  - "signatory": подписант — ФИО и должность, пустая строка если не найден

"contractor" — сторона с ролью «Подрядчик» / «Исполнитель» / «Проектировщик»:
  Те же поля: name, role, inn, kpp, address, signatory

"from_to" — краткое наименование подрядчика/исполнителя. Пример: «ООО «Альфа+»» → «Альфа+».

═══ ОБЩИЕ ПОЛЯ ═══

"date" — дата подписания договора (YYYY-MM-DD).
  ГДЕ ИСКАТЬ: начало документа («г. Москва, «__» ___ 202_ г.»), рядом с подписями,
  в реквизитах («Договор № ___ от ДД.ММ.ГГГГ»).
  ФОРМАТЫ: ДД.ММ.ГГГГ → YYYY-MM-DD, «10 января 2026 г.» → 2026-01-10.
  Если не найдена — пустая строка.

"direction": "outgoing" по умолчанию. "incoming" только если это входящий от инвестора/девелопера.

"method": ЭДО / Электронная_почта / Курьер / Скан / Факс / Лично. По умолчанию "ЭДО".

"contract_type": "Договор" / "ДС" / "Акт".

"version": "v1" для первичного, "ДС1"/"ДС2"... для доп. соглашений.

"title" — до 60 символов. Включи номер договора если есть.

"subject" — предмет договора, одно предложение.

"amount" — итоговая сумма. Пример: «1 250 000 ₽». Пустая строка если нет.

"object_codes" — пустой массив (тест без таблицы объектов).

═══ ЭТАПЫ И СОБЫТИЯ ═══

"milestones" — ВСЕ этапы работ. Каждый этап содержит список событий с датами.

  ПРИОРИТЕТ ИСТОЧНИКОВ:
  1. «График производства работ» / «Календарный план» — особенно в Приложениях
  2. Любое Приложение с таблицей этапов
  3. Раздел «Этапы выполнения работ» / «Сроки выполнения»
  4. Любые упоминания этапов с датами в основном тексте

  АБСОЛЮТНЫЕ ДАТЫ:
  - Форматы: ДД.ММ.ГГГГ, «до 31.10.2026», «31 октября 2026 г.», «IV квартал 2026»
  - Квартал: Q1=31.03, Q2=30.06, Q3=30.09, Q4=31.12
  - Опечатки типа 2626→2026 исправляй

  ОТНОСИТЕЛЬНЫЕ СРОКИ (очень частый случай в российских договорах):
  Сроки могут быть выражены как «N рабочих/календарных дней с даты X».

  КАК ОБРАБАТЫВАТЬ ОТНОСИТЕЛЬНЫЕ СРОКИ — ОБЯЗАТЕЛЬНЫЙ ПОСЛЕДОВАТЕЛЬНЫЙ РАСЧЁТ:

  ШАГ 1: Определи base_date = дата подписания договора (уже нашёл в поле "date").

  ШАГ 2: Рассчитывай даты ЦЕПОЧКОЙ — каждая следующая зависит от предыдущей:
    - "N рабочих дней от подписания" → base_date + N×1.4 к.д. (5 р.д.→+7к, 10→+14к, 35→+49к)
    - "следующий день после события X" → дата_X + 1 к.д.
    - "N р.д. от начала работ" → дата_начала + N×1.4 к.д.
    - "N р.д. от подписания Акта" → дата_завершения + N×1.4 к.д.

  ШАГ 3: ПРАВИЛО — поле "date" НИКОГДА не оставляй пустым если формула известна!
    Рассчитай и запиши YYYY-MM-DD. Приблизительная дата лучше пустого поля.
    Пустым оставляй ТОЛЬКО если база расчёта неизвестна (например, зависит от будущего акта).

  ВАЖНО: Даже если СУММА аванса в Приложении — СРОК оплаты (в рабочих днях) скорее всего
  ЕСТЬ в основном тексте договора. Найди его и рассчитай дату. Не путай "не знаю сумму" с
  "не знаю когда". Если нашёл "в течение N рабочих дней" — этого достаточно для расчёта.

  ПРИМЕР для договора от 20.03.2026:
    Аванс Этапа 1 (5 р.д. от подписания)   → 20.03 + 7к = 2026-03-27  ← ЗАПОЛНИ
    Начало работ (след. день после аванса)  → 27.03 + 1  = 2026-03-28  ← ЗАПОЛНИ
    Завершение (35 р.д. от начала)          → 28.03 + 49 = 2026-05-16  ← ЗАПОЛНИ
    Расчёт (5 р.д. от Акта Этапа 1)        → 16.05 + 7  = 2026-05-23  ← ЗАПОЛНИ

  ШАГ 4: В поле "duration_note" — ВСЕГДА записывай оригинальную формулировку из текста.

  СОБЫТИЯ ПЛАТЕЖЕЙ — извлекай из графика платежей или основного текста.
  Включай их ПЕРВЫМИ в соответствующий этап:
  - Аванс: «Аванс Этапа N — XX% / XX ₽ (N р.д. от подписания)»
  - Окончательный расчёт: «Окончательный расчёт Этапа N (N р.д. от подписания Акта)»

  Структура каждого этапа:
  - "number": номер этапа (целое число)
  - "name": название этапа как в документе (не сокращай)
  - "source": откуда взят («Приложение №2», «Раздел 4.2» и т.п.)
  - "events": массив событий этапа в ХРОНОЛОГИЧЕСКОМ порядке:
    - "event_type": "payment_advance" | "payment_final" | "milestone_start" | "milestone_end" | "milestone_event"
    - "event_name": название события
    - "date": дата (YYYY-MM-DD). Для относительных — рассчитанная приблизительная дата или ""
    - "duration_note": оригинальная формулировка срока из текста, или "" если дата абсолютная

  ПРАВИЛО ПОРЯДКА событий в этапе:
  1. Платёжное событие (payment_advance)
  2. Начало работ (milestone_start)
  3. Промежуточные события (milestone_event)
  4. Завершение (milestone_end)
  5. Окончательный расчёт (payment_final)

Текст документов:
{truncated}"""

# ─── LLM call ─────────────────────────────────────────────────────────────────

def call_llm(prompt: str) -> dict:
    resp = requests.post(
        f"{POLZA_BASE_URL}/chat/completions",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {POLZA_API_KEY}"},
        json={"model": LLM_MODEL, "messages": [{"role": "user", "content": prompt}], "temperature": 0.1},
        timeout=120,
    )
    resp.raise_for_status()
    content: str = resp.json()["choices"][0]["message"]["content"]

    m = re.search(r"```json\s*([\s\S]*?)\s*```", content) or re.search(r"(\{[\s\S]*\})", content)
    raw = m.group(1) if m else content
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(RED(f"JSON parse error: {e}"))
        return {"error": "parse_failed", "raw": content}

# ─── Pretty-print ─────────────────────────────────────────────────────────────

def fmt_date_status(d: str) -> str:
    if not d:
        return RED("  нет даты  ")
    return GREEN(f"  {d}  ")

def print_party(label: str, p: dict):
    print(f"  {BOLD(label)}: {p.get('name','?')} [{p.get('role','')}]")
    if p.get('inn'):  print(f"    ИНН {p['inn']}", end="")
    if p.get('kpp'):  print(f"  КПП {p['kpp']}", end="")
    if p.get('inn') or p.get('kpp'): print()
    if p.get('signatory'): print(f"    Подписант: {p['signatory']}")

def print_result(result: dict, texts: list[dict]):
    total_chars = sum(len(t["text"]) for t in texts)
    print()
    print(BOLD("═" * 70))
    print(BOLD("  РЕЗУЛЬТАТ АНАЛИЗА"))
    print(BOLD("═" * 70))

    # Meta
    print(f"\n{CYAN(BOLD('МЕТАДАННЫЕ'))}:")
    print(f"  Название:  {result.get('title','?')}")
    print(f"  Тип:       {result.get('contract_type','?')} {result.get('version','')}")
    print(f"  Дата:      {BOLD(result.get('date','—'))}")
    print(f"  Сторона:   {result.get('from_to','?')}")
    print(f"  Сумма:     {result.get('amount','—')}")
    print(f"  Объекты:   {result.get('object_codes', [])}")
    print(f"  Предмет:   {textwrap.shorten(result.get('subject','—'), 80)}")
    print(f"  Текст:     {total_chars:,} символов")

    # Parties
    print(f"\n{CYAN(BOLD('СТОРОНЫ'))}:")
    if result.get('customer'):  print_party('Заказчик', result['customer'])
    if result.get('contractor'): print_party('Подрядчик', result['contractor'])

    # Milestones
    milestones = result.get("milestones", [])
    print(f"\n{CYAN(BOLD('ЭТАПЫ И СОБЫТИЯ'))} ({len(milestones)} этапов):")

    total_events = 0
    dated_events = 0

    for m in milestones:
        mnum = m.get('number', '?')
        mname = m.get('name', '?')
        print(f"\n  {BOLD(f'Этап {mnum}: {mname}')}"
              f"  {GRAY(m.get('source',''))}")
        events = m.get("events", [])
        for ev in events:
            total_events += 1
            et   = ev.get("event_type", "milestone_event")
            icon = EVENT_ICONS.get(et, "  ")
            name = ev.get("event_name", "?")
            d    = ev.get("date", "")
            note = ev.get("duration_note", "")

            if d: dated_events += 1

            date_col = fmt_date_status(d)
            is_pay   = et in ("payment_advance", "payment_final")
            name_str = BOLD(name) if is_pay else name

            print(f"    {icon} {date_col}  {name_str}")
            if note:
                wrapped = textwrap.shorten(note, 65)
                print(f"              {GRAY(wrapped)}")

    # Summary
    pct = dated_events / total_events * 100 if total_events else 0
    color = GREEN if pct >= 80 else YELLOW if pct >= 50 else RED
    print()
    print("─" * 70)
    print(f"  Событий с датами: {color(f'{dated_events}/{total_events} ({pct:.0f}%)')}")

    if result.get("error"):
        print(RED(f"\n  ОШИБКА: {result['error']}"))
    if result.get("raw"):
        print(GRAY(f"\n  RAW:\n{result['raw'][:500]}"))
    print()

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Тест LLM-анализа договора")
    parser.add_argument("pdfs", nargs="+", metavar="PDF", help="PDF-файлы договора и приложений")
    parser.add_argument("--save",     metavar="FILE",  help="Сохранить JSON-результат в файл")
    parser.add_argument("--no-color", action="store_true", help="Без цвета в выводе")
    parser.add_argument("--show-prompt", action="store_true", help="Напечатать промпт (для отладки)")
    args = parser.parse_args()

    global USE_COLOR
    if args.no_color:
        USE_COLOR = False

    # Extract text
    texts: list[dict] = []
    for path_str in args.pdfs:
        p = Path(path_str)
        if not p.exists():
            print(RED(f"Файл не найден: {p}"))
            sys.exit(1)
        print(f"Читаю: {p.name} … ", end="", flush=True)
        text = extract_pdf(p)
        texts.append({"name": p.name, "text": text})
        print(f"{len(text):,} символов")

    combined = "\n\n".join(f"=== {t['name']} ===\n{t['text']}" for t in texts)

    # Build and (optionally) show prompt
    prompt = build_prompt(combined)
    if args.show_prompt:
        print("\n" + "─" * 70)
        print(prompt[:3000] + "...[обрезан]")
        print("─" * 70 + "\n")

    # Call LLM
    print(f"\nЗапрос LLM ({LLM_MODEL}) … ", end="", flush=True)
    t0 = datetime.now()
    result = call_llm(prompt)
    elapsed = (datetime.now() - t0).total_seconds()
    print(f"{elapsed:.1f}s")

    # Save raw JSON
    if args.save:
        out = Path(args.save)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"JSON сохранён: {out}")

    # Print pretty report
    print_result(result, texts)


if __name__ == "__main__":
    main()
