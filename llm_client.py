"""
llm_client.py — тонкая обёртка над Polza.AI (OpenAI-совместимый API)

Использование:
    from llm_client import ask_llm, ask_llm_json

    result = ask_llm("Извлеки этапы из текста договора: ...")
    data   = ask_llm_json("Верни JSON с этапами: ...", schema_hint="[{num, title, due}]")
"""

import json
from config import POLZA_API_KEY, POLZA_BASE_URL, LLM_MODEL


def _get_client():
    try:
        from openai import OpenAI
    except ImportError:
        raise RuntimeError("Установите openai: pip install openai")

    if not POLZA_API_KEY:
        raise RuntimeError(
            "Не задан POLZA_API_KEY в config.py\n"
            "Получите ключ на https://polza.ai/dashboard/api-keys"
        )

    return OpenAI(base_url=POLZA_BASE_URL, api_key=POLZA_API_KEY)


def ask_llm(prompt: str, system: str = "", model: str = None, max_tokens: int = 2000) -> str:
    """
    Простой запрос к LLM. Возвращает строку-ответ.
    При ошибке возвращает пустую строку и печатает предупреждение.
    """
    client = _get_client()
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    try:
        response = client.chat.completions.create(
            model=model or LLM_MODEL,
            messages=messages,
            max_tokens=max_tokens,
            temperature=0,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [LLM] ошибка: {e}")
        return ""


def ask_llm_json(prompt: str, system: str = "", model: str = None, max_tokens: int = 3000) -> dict | list | None:
    """
    Запрос к LLM с ожиданием JSON-ответа.
    Автоматически извлекает JSON из ответа (даже если модель добавила текст вокруг).
    Возвращает dict/list или None при ошибке.
    """
    json_system = (system + "\n" if system else "") + (
        "Отвечай ТОЛЬКО валидным JSON без пояснений, markdown-блоков и вводных слов."
    )
    raw = ask_llm(prompt, system=json_system, model=model, max_tokens=max_tokens)
    if not raw:
        return None

    # Извлекаем JSON даже если модель обернула его в ```json ... ```
    import re
    m = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw)
    if m:
        raw = m.group(1)

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Ищем первый [ или { и парсим от него
        for char in ("[", "{"):
            idx = raw.find(char)
            if idx != -1:
                try:
                    return json.loads(raw[idx:])
                except Exception:
                    pass
        print(f"  [LLM] не удалось распарсить JSON: {raw[:200]}")
        return None


# ─── Специализированные функции для ЗПР ──────────────────────────────────────

STAGES_SYSTEM = """Ты — ассистент, извлекающий этапы договора из текста.
Проект: строительство туристического комплекса «Золотые Пески России».
Этапы могут называться: Форэскиз, Концепция, Проект, Экспертиза, АГК, Рабочая документация,
Массинг, Эскизный проект и т.п.

ПРАВИЛА ПОИСКА ЭТАПОВ (в порядке приоритета):

1. «План Работ» в тексте Дополнительного соглашения (ДС) — таблица вида:
   «Этап | Наименование работ | Срок выполнения | Стоимость».
   ДС ВАЖНЕЕ основного договора — если в ДС есть «План Работ», используй только его.
   Пример: «1 Массинг ... До 31.10.2025»; «2 ОПР ... До 15.02.2026»

2. Приложение №3 «Календарный план» основного договора — таблица с колонками:
   «Наименование этапов», «Дата начала этапа», «Дата окончания этапа».
   Пример: «ЭТАП 01. Массинг. 16.02.2026 20.03.2026»

3. Техническое задание (Приложение №1), пункт 17 «Состав разрабатываемой документации» —
   перечень этапов в формате «ЭТАП NN: НАЗВАНИЕ» или «ЭТАП NN. НАЗВАНИЕ».
   Даты в ТЗ могут отсутствовать — тогда ищи их в Календарном плане.

4. Раздел «Сроки выполнения работ» основного договора — общие даты начала и окончания,
   если детальный Календарный план не найден.

ВАЖНО:
- Текст PDF-таблиц может быть «перемешан» (колонки читаются вперемешку).
  Ищи паттерн: «ЭТАП NN» + название + две даты формата ДД.ММ.ГГГГ рядом.
- «due» = дата ОКОНЧАНИЯ этапа (второй датой в строке).
- Если дата выглядит как «3.07.2626» — это опечатка, читай как «3.07.2026».
- Нумерация этапов: если в документе «ЭТАП 01», «ЭТАП 02» — num = 1, 2, ...
"""


def _extract_calendar_plan_section(text: str) -> str:
    """Находит раздел с этапами: План Работ ДС / Календарный план / ТЗ п.17."""
    sections = []

    # 1. «План Работ» в ДС — наивысший приоритет
    for marker in ["План Работ", "ПЛАН РАБОТ", "План работ"]:
        idx = text.find(marker)
        if idx != -1:
            sections.append(f"[ПЛАН РАБОТ (из ДС, pos {idx})]:\n{text[idx:idx+3000]}")
            break

    # 2. Приложение №3 «Календарный план» основного договора
    for marker in ["Приложение № 3", "КАЛЕНДАРНЫЙ ПЛАН", "Календарный план"]:
        idx = text.rfind(marker)   # rfind — берём последнее вхождение (само приложение, не ссылку)
        if idx != -1:
            sections.append(f"[КАЛЕНДАРНЫЙ ПЛАН (pos {idx})]:\n{text[idx:idx+3000]}")
            break

    # 3. ТЗ п.17 «Состав разрабатываемой документации»
    for marker in ["17\nразрабатываемой", "17 разрабатываемой", "ЭТАП 01", "Этап 01"]:
        idx = text.find(marker)
        if idx != -1:
            sections.append(f"[ТЗ п.17 — состав этапов (pos {idx})]:\n{text[idx:idx+3000]}")
            break

    return "\n\n".join(sections)


def extract_stages_llm(contract_text: str) -> list[dict]:
    """
    Извлекает этапы договора через LLM, когда регулярки не справились.
    Ищет этапы в Приложении №3 (Календарный план) и ТЗ п.17.
    Возвращает список: [{num, title, due, deliverables}]
    """
    # Формируем контекст: начало договора + целевые разделы с этапами
    header = contract_text[:2000]
    target_sections = _extract_calendar_plan_section(contract_text)

    if target_sections:
        context = f"[НАЧАЛО ДОГОВОРА]:\n{header}\n\n{target_sections}"
    else:
        # Fallback: отправляем начало + конец (там могут быть приложения)
        context = (
            f"[НАЧАЛО ДОГОВОРА]:\n{header}\n\n"
            f"[КОНЕЦ ДОГОВОРА]:\n{contract_text[-6000:]}"
        )

    prompt = f"""Из текста договора извлеки таблицу этапов работ.

Для каждого этапа верни JSON-объект:
{{
  "num": <номер этапа, целое число>,
  "title": "<название этапа>",
  "start": "<дата начала в формате YYYY-MM-DD или null>",
  "due": "<дата окончания в формате YYYY-MM-DD>",
  "deliverables": ["<документ1>", "<документ2>"]
}}

Верни JSON-массив всех этапов. Если этапов нет — верни [].

{context}"""

    result = ask_llm_json(prompt, system=STAGES_SYSTEM)
    if isinstance(result, list):
        return result
    return []


def summarize_meetings_llm(meetings_text: str, object_name: str) -> str:
    """
    Суммаризирует старые собрания для раздела «Ранее» в отчёте.
    meetings_text — объединённый текст итоги.md старых собраний.
    Возвращает markdown-строку.
    """
    prompt = f"""Объект: {object_name}

Ниже — выжимки из нескольких старых собраний (итоги.md).
Составь краткую таблицу в Markdown:

| Дата | Название | Ключевые решения |
|------|----------|-----------------|

Включи только существенные решения. Максимум 3 строки на собрание.

Материалы собраний:
{meetings_text[:6000]}"""

    return ask_llm(prompt) or "_нет данных_"
