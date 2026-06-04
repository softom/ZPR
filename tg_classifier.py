"""
tg_classifier.py — автомат-классификатор TG-сообщений → preliminary events

Что делает:
  1. Загружает tg_messages из чатов, привязанных к объектам (`tg_chats.object_id`).
  2. Фильтрует уже связанные с событиями (есть запись в `event_tg_messages`).
  3. Применяет правила L1 из `event_classifier_templates` (`layer='rule'`):
     - Группирует рассылки одного файла в N чатов → одно событие с N объектами.
     - Создаёт title по шаблону.
  4. Применяет L2 (LLM) к окнам обсуждений ≥3 сообщений от ≥2 авторов в ±2ч:
     - Просит LLM выбрать тип из `event_classifier_templates` (`layer='llm'`).
     - Принимает только при confidence ≥ порога.
  5. В --dry-run пишет markdown-отчёт; в --apply создаёт `events` + `event_tg_messages`.

Запуск:
  python tg_classifier.py --dry-run                     # отчёт без записи
  python tg_classifier.py --dry-run --days 30           # окно 30 дней
  python tg_classifier.py --dry-run --layer rule        # только правила
  python tg_classifier.py --apply                       # создать preliminary events
  python tg_classifier.py --apply --layer rule          # без LLM (быстро, дёшево)

После --apply preliminary события видны через:
  SELECT * FROM events WHERE is_preliminary = true ORDER BY created_at DESC;
"""

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from supabase import create_client, ClientOptions

from config import (
    SUPABASE_URL, SUPABASE_SECRET_KEY,
    SUPABASE_CLOUD_URL, SUPABASE_CLOUD_SECRET_KEY,
)
from llm_client import ask_llm_json


# ─── Константы ───────────────────────────────────────────────────────────────

ME_NAMES = ["артем антипов", "artem antipov", "артемий антипов", "artemy antipov"]
DEFAULT_REPORT_DIR = Path(__file__).parent / "docs" / "reports"

# Окно для L2: серия сообщений в одном чате
L2_GAP_MINUTES = 120  # разрыв > 2ч начинает новое окно
L2_MIN_MSGS = 3       # минимум сообщений в окне
L2_MIN_SENDERS = 2    # минимум разных авторов
L2_MIN_CONFIDENCE = 50  # LLM-confidence ниже этого — skip
L2_MAX_CONFIDENCE = 75  # cap для записи (manual confirm = 100)


def is_me(sender_name: str | None) -> bool:
    if not sender_name:
        return False
    s = sender_name.lower()
    return any(name in s for name in ME_NAMES)


def fill_template(template: str, vars_: dict) -> str:
    """Заполняет {placeholder} из словаря."""
    def replace(m):
        return str(vars_.get(m.group(1), m.group(0)))
    return re.sub(r"\{(\w+)\}", replace, template)


def parse_dt(s: str) -> datetime:
    """ISO string из Supabase → datetime."""
    # Supabase возвращает '2026-05-12T12:34:56+00:00' или '2026-05-12T12:34:56.123456+00:00'
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ─── Загрузка данных ─────────────────────────────────────────────────────────


CLOUD_PAGE = 200   # меньше страница → меньше шанс reset на флапающем RF→US пути


def _retry(fn, what="cloud read", attempts=5, base=1.5):
    """Повтор при httpx-сбоях (ReadError/Timeout/reset) — RF→US путь нестабилен без VPN."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last = e
            print(f"  ⚠ {what} retry {i+1}/{attempts}: {type(e).__name__}", flush=True)
            time.sleep(base * (i + 1))
    raise last


def load_data(sb, sb_cloud, days: int, object_filter: str | None):
    """Возвращает (messages, templates_l1, templates_l2, objects_map, chat_titles, chat_to_contractor).
    sb — локальный Supabase (ЗПР: справочники + события). sb_cloud — облачный (tg_chats/tg_messages)."""
    # Шаблоны
    templates = (
        sb.table("event_classifier_templates")
        .select("*")
        .eq("active", True)
        .order("priority")
        .execute()
        .data
    )
    templates_l1 = [t for t in templates if t["layer"] == "rule"]
    templates_l2 = [t for t in templates if t["layer"] == "llm"]

    # Объекты (с подрядчиком + aliases для caption-резолва)
    objects = sb.table("objects").select("id,code,contractor,current_name,aliases").execute().data or []
    objects_map = {o["id"]: o["code"] for o in objects}
    # Кэшируем distinctive-токены для каждого объекта (для substring match по caption)
    for o in objects:
        o["_tokens"] = _extract_object_tokens(o)
    obj_to_contractor = {o["id"]: o.get("contractor") for o in objects}
    if object_filter:
        target = next((o for o in objects if o["code"].startswith(object_filter)), None)
        if not target:
            sys.exit(f"Объект '{object_filter}' не найден")
        target_obj_id = target["id"]
    else:
        target_obj_id = None

    # Подрядчики: code → полное имя (для title типа «от Бюро 82 отправитель Ольга»)
    contractors = sb.table("contractors").select("code,full_name").execute().data or []
    contractor_name_by_code = {c["code"]: (c["full_name"] or c["code"]) for c in contractors}

    # Привязанные чаты — из ОБЛАКА (object_id проставляет UI; plain uuid, без FK)
    chats = (
        _retry(lambda: sb_cloud.table("tg_chats")
               .select("chat_id,object_id,title")
               .not_.is_("object_id", "null")
               .eq("is_whitelisted", True)
               .execute(), what="tg_chats")
        .data
    ) or []
    if target_obj_id:
        chats = [c for c in chats if c["object_id"] == target_obj_id]
    chat_to_obj = {c["chat_id"]: c["object_id"] for c in chats}
    chat_titles = {c["chat_id"]: c["title"] for c in chats}

    # Чат → читаемое имя подрядчика (через объект → contractor код → contractors.full_name)
    chat_to_contractor: dict[int, str | None] = {}
    for c in chats:
        contractor_code = obj_to_contractor.get(c["object_id"])
        chat_to_contractor[c["chat_id"]] = contractor_name_by_code.get(contractor_code) if contractor_code else None

    if not chats:
        print("Нет привязанных чатов — нечего классифицировать")
        return [], set(), templates_l1, templates_l2, objects_map, chat_titles, chat_to_contractor

    # Сообщения за окно
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    msgs: list[dict] = []
    for c in chats:
        page = 0
        while True:
            res = _retry(lambda: (
                sb_cloud.table("tg_messages")
                .select("id,chat_id,message_id,sender_id,sender_name,"
                        "msg_date,text,has_media,media_kind,media_file_name")
                .eq("chat_id", c["chat_id"])
                .gte("msg_date", cutoff)
                .range(page * CLOUD_PAGE, page * CLOUD_PAGE + CLOUD_PAGE - 1)
                .execute()
            ), what=f"tg_messages {c['chat_id']}")
            chunk = res.data or []
            for m in chunk:
                m["object_id"] = c["object_id"]
                m["chat_title"] = c["title"]
                m["msg_date"] = parse_dt(m["msg_date"])
            msgs.extend(chunk)
            if len(chunk) < CLOUD_PAGE:
                break
            page += 1

    # Уже связанные с событиями — исключаем
    linked_ids: set[str] = set()
    page = 0
    while True:
        res = (
            sb.table("event_tg_messages")
            .select("tg_message_id")
            .range(page * 1000, page * 1000 + 999)
            .execute()
        )
        chunk = res.data or []
        for l in chunk:
            linked_ids.add(l["tg_message_id"])
        if len(chunk) < 1000:
            break
        page += 1
    orphan_count = sum(1 for m in msgs if m["id"] not in linked_ids)
    print(f"Сообщений в окне: {len(msgs)}, не связано с событиями: {orphan_count}")

    # ВАЖНО: возвращаем ВСЕ сообщения + linked_ids set.
    # L1 фильтрует орфанов внутри (нужно media + не связано).
    # L2 использует ВСЕ сообщения для контекста окон, но создаёт события только
    # из орфан-источников (linked-сообщения помечаются «уже зафиксировано» для LLM).
    return msgs, linked_ids, templates_l1, templates_l2, objects_map, chat_titles, chat_to_contractor


# ─── L1: правила ─────────────────────────────────────────────────────────────


STOP_TOKENS = {
    "отель", "гостиница", "номеров", "номера", "отлеь", "5*", "4*", "3*",
    "программы", "системы", "проект", "проекта", "звезд", "номеров.",
    "это", "для", "при", "под", "над",
}


def _extract_object_tokens(o: dict) -> set[str]:
    """Distinctive tokens из current_name + aliases для caption-резолва."""
    tokens: set[str] = set()
    sources = [o.get("current_name") or ""] + list(o.get("aliases") or [])
    for src in sources:
        for raw in src.lower().split():
            tok = raw.strip(".,!?():;«»\"'#")
            if len(tok) < 4:
                continue
            if tok in STOP_TOKENS:
                continue
            tokens.add(tok)
    return tokens


def resolve_objects_from_caption(text: str | None, objects: list[dict]) -> set[str]:
    """Сканирует caption на distinctive токены каждого объекта.
    Возвращает set object_id (UUID) — все, чьи токены встречены в тексте."""
    if not text:
        return set()
    t = text.lower()
    matched: set[str] = set()
    for o in objects:
        for tok in o.get("_tokens", ()):
            if tok in t:
                matched.add(o["id"])
                break
    return matched


def apply_l1(messages, linked_ids, templates, chat_to_contractor, objects=None):
    objects = objects or []
    # Орфаны: ещё не связаны ни с одним event
    messages = [m for m in messages if m["id"] not in linked_ids]
    """
    Применяет L1-правила. Группирует рассылки по (sender, filename, ±30min bucket).
    Title включает имя подрядчика (если чат привязан к объекту с подрядчиком):
      «Получен документ «X» от {Бюро 82} отправитель {Ольга Анциферман}»
    Возвращает список кандидатов.
    """
    grouped: dict[tuple, list[dict]] = defaultdict(list)

    for m in messages:
        # Без имени файла — пропускаем (forward'ы создают шум)
        if not m.get("media_file_name"):
            continue
        if not m.get("has_media") or m.get("media_kind") not in (
            "document", "photo", "video", "webpage", "audio", "voice"
        ):
            continue

        sender = m.get("sender_name") or "unknown"
        # Bucket 30 мин — обычная рассылка одного файла в N чатов укладывается
        bucket = m["msg_date"].replace(second=0, microsecond=0)
        bucket = bucket.replace(minute=(bucket.minute // 30) * 30)

        # Caption-based object resolution: ищем упоминания объектов в тексте сообщения
        chat_obj = m.get("object_id")
        caption_objs = resolve_objects_from_caption(m.get("text"), objects)
        effective_objs = frozenset(({chat_obj} if chat_obj else set()) | caption_objs)
        m["_effective_objs"] = effective_objs

        # Группируем по (sender, filename, bucket, frozenset(objects))
        # → сообщения с разным составом объектов в группу не сольются
        key = (sender, m["media_file_name"], bucket, effective_objs)
        grouped[key].append(m)

    candidates = []
    for (sender, fname, bucket, effective_objs), msgs in grouped.items():
        media_kind = msgs[0].get("media_kind") or "document"
        sender_role = "me" if is_me(sender) else "other"

        # Выбираем шаблон
        chosen = None
        for t in templates:
            kinds = t.get("trigger_media_kinds") or []
            if media_kind not in kinds:
                continue
            role = t.get("trigger_sender_role")
            if role and role != "any" and role != sender_role:
                continue
            chosen = t
            break
        if not chosen:
            # Фоллбэк для типа без шаблона: общий шаблон по направлению
            chosen = next(
                (t for t in templates
                 if t["code"] == ("doc_sent" if sender_role == "me" else "doc_received")),
                None,
            )
            if not chosen:
                continue

        caption = (msgs[0].get("text") or "").strip()
        contractor_name = chat_to_contractor.get(msgs[0]["chat_id"])

        # Строим title по направлению + наличию подрядчика
        if chosen["code"] == "doc_received":
            title = (
                f'Получен документ «{fname}» от {contractor_name} отправитель {sender}'
                if contractor_name
                else f'Получен документ «{fname}» от {sender}'
            )
        elif chosen["code"] == "doc_sent":
            title = (
                f'Направлен документ «{fname}» подрядчику {contractor_name}'
                if contractor_name
                else f'Направлен документ «{fname}»'
            )
        elif chosen["code"] == "material_link":
            cap_short = caption[:120] if caption else fname
            title = (
                f'Передана ссылка ({contractor_name}): {cap_short}'
                if contractor_name
                else f'Передана ссылка: {cap_short}'
            )
        else:
            # photo_with_caption и фоллбэки — старый template
            title = fill_template(chosen["title_template"], {
                "filename": fname,
                "sender": sender,
                "caption": (caption[:120] if caption else "(без подписи)"),
            })

        # object_ids = объекты из чата + найденные в caption (через aliases)
        object_ids = sorted(effective_objs)
        chat_obj_ids = {m["object_id"] for m in msgs if m.get("object_id")}
        caption_only_objs = set(object_ids) - chat_obj_ids

        note_lines = [
            f"Цитата: «{caption[:400]}»" if caption else f"Файл: {fname}",
            "",
        ]
        src_line = f"Источник: Telegram, {sender}, {msgs[0]['msg_date']:%d.%m.%Y %H:%M}"
        if contractor_name:
            src_line += f" (подрядчик {contractor_name})"
        note_lines.append(src_line)
        if len(chat_obj_ids) > 1:
            note_lines.append(f"Рассылка в {len(chat_obj_ids)} чатов одновременно.")
        if caption_only_objs:
            note_lines.append(
                f"⚠ Объекты {len(caption_only_objs)} добавлены по упоминанию в тексте — проверь."
            )

        candidates.append({
            "layer": "rule",
            "template_code": chosen["code"],
            "event_type": chosen["event_type"],
            "title": title[:240],
            "note": "\n".join(note_lines),
            "object_ids": object_ids,
            "event_date": msgs[0]["msg_date"].date(),
            "source_msg_ids": [m["id"] for m in msgs],
            "confidence": 85 if len(fname) > 5 else 70,
            "_preview_files": [fname],
            "_preview_sender": sender,
            "_preview_dt": msgs[0]["msg_date"],
        })

    return candidates


# ─── Feedback (few-shot examples из event_classifier_feedback) ───────────────


def load_feedback_examples(sb, object_code: str, limit: int = 8) -> list[dict]:
    """Последние решения оператора по этому объекту — для подмешивания в LLM-промпт.
    Берём по auto_object_codes (что предложил классификатор), чтобы поднять «кейсы для обучения»
    даже если оператор убрал этот объект в final."""
    try:
        # Объекты, изначально предложенные классификатором для этого object_code
        auto_resp = (
            sb.table("event_classifier_feedback")
            .select("decision, auto_title, final_title, title_edited, layer, template_code, auto_object_codes, object_codes")
            .contains("auto_object_codes", [object_code])
            .order("decided_at", desc=True)
            .limit(limit)
            .execute()
        )
        rows = auto_resp.data or []
        if len(rows) < limit:
            # Дополнить рядами где object_code оставлен в final (но не был в auto — редкий случай)
            final_resp = (
                sb.table("event_classifier_feedback")
                .select("decision, auto_title, final_title, title_edited, layer, template_code, auto_object_codes, object_codes")
                .contains("object_codes", [object_code])
                .order("decided_at", desc=True)
                .limit(limit)
                .execute()
            )
            seen = {(r.get("auto_title"), r.get("decided_at")) for r in rows}
            for r in (final_resp.data or []):
                key = (r.get("auto_title"), r.get("decided_at"))
                if key not in seen:
                    rows.append(r)
                    if len(rows) >= limit:
                        break
        return rows[:limit]
    except Exception as e:
        print(f"  ⚠ load_feedback: {e}", flush=True)
        return []


def format_feedback_block(examples: list[dict]) -> str:
    """Форматирует feedback-примеры как блок для LLM-промпта."""
    if not examples:
        return ""
    accepted = [e for e in examples if e["decision"] == "accepted"]
    rejected = [e for e in examples if e["decision"] == "rejected"]

    lines = ["", "ПРИМЕРЫ ПРЕДЫДУЩИХ РЕШЕНИЙ ОПЕРАТОРА НА ЭТОМ ОБЪЕКТЕ:", ""]

    def _obj_diff_str(ex: dict) -> str:
        """Возвращает строку '[X→Y]' если оператор менял состав объектов, иначе пустую."""
        auto_obj = sorted(ex.get("auto_object_codes") or [])
        final_obj = sorted(ex.get("object_codes") or [])
        if not auto_obj or auto_obj == final_obj:
            return ""
        added = [o for o in final_obj if o not in auto_obj]
        removed = [o for o in auto_obj if o not in final_obj]
        parts = []
        if removed:
            parts.append(f"убрал {', '.join(removed)}")
        if added:
            parts.append(f"добавил {', '.join(added)}")
        return f"  [объекты: {'; '.join(parts)}]" if parts else ""

    if accepted:
        lines.append("✅ ПРИНЯТЫЕ события (запоминай этот стиль):")
        for ex in accepted:
            obj_diff = _obj_diff_str(ex)
            if ex.get("title_edited") and ex.get("final_title"):
                lines.append(f"  • было: «{ex['auto_title']}»")
                lines.append(f"    стало: «{ex['final_title']}» (оператор исправил){obj_diff}")
            else:
                lines.append(f"  • «{ex.get('final_title') or ex['auto_title']}»{obj_diff}")
        lines.append("")

    if rejected:
        lines.append("🗑 ОТБРОШЕННЫЕ (НЕ создавай событий такого вида — это шум/болтовня):")
        for ex in rejected:
            lines.append(f"  • «{ex['auto_title']}»")
        lines.append("")

    lines.append("Учитывай эти паттерны:")
    lines.append("• повторяй стиль accepted-формулировок;")
    lines.append("• избегай тем/типов, похожих на rejected;")
    lines.append("• если оператор регулярно [убирает X / добавляет Y] — учитывай это")
    lines.append("  при выборе object_ids в новых событиях (упомянуто в caption — добавляй, лишнее — не предлагай).")
    return "\n".join(lines)


# ─── L2: LLM по окнам обсуждений ─────────────────────────────────────────────


def find_windows(messages, gap_minutes=L2_GAP_MINUTES, min_msgs=L2_MIN_MSGS, min_senders=L2_MIN_SENDERS):
    """Группирует сообщения в окна обсуждений в рамках одного чата."""
    by_chat: dict[str, list[dict]] = defaultdict(list)
    for m in messages:
        by_chat[str(m["chat_id"])].append(m)

    windows = []
    for chat_id, msgs in by_chat.items():
        msgs.sort(key=lambda x: x["msg_date"])
        current: list[dict] = []
        for m in msgs:
            if not current:
                current = [m]
                continue
            gap = (m["msg_date"] - current[-1]["msg_date"]).total_seconds() / 60
            if gap < gap_minutes:
                current.append(m)
            else:
                if len(current) >= min_msgs and len({x.get("sender_name") for x in current}) >= min_senders:
                    windows.append(current[:])
                current = [m]
        if current and len(current) >= min_msgs and len({x.get("sender_name") for x in current}) >= min_senders:
            windows.append(current)
    return windows


def llm_classify_window(window, templates_l2, object_code, contractor_name=None, feedback_examples=None, linked_ids=None):
    """Просит LLM проанализировать окно. Возвращает dict или None."""
    templates_block = "\n".join(
        f"- {t['code']}: {t['label']}  →  «{t['title_template']}»"
        for t in templates_l2
    )
    linked_ids = linked_ids or set()
    msg_lines = []
    for i, m in enumerate(window):
        text = (m.get("text") or "").replace("\n", " ").strip()
        if m.get("has_media") and m.get("media_file_name"):
            text = f"[📎 {m['media_kind']}: {m['media_file_name']}] {text}"
        elif m.get("has_media"):
            text = f"[📎 {m['media_kind']}] {text}"
        prefix = "[уже зафиксировано как event] " if m["id"] in linked_ids else ""
        msg_lines.append(f"{i}. [{m['msg_date']:%d.%m %H:%M}] {m.get('sender_name') or '?'}: {prefix}{text[:400]}")
    msg_block = "\n".join(msg_lines)

    system = (
        "Ты — ассистент, анализирующий рабочие диалоги в Telegram-чате проекта строительства."
        " Определи, произошло ли значимое СОБЫТИЕ для журнала проекта."
        " Событие = конкретный факт/действие/решение, влияющий на ход договора:"
        " получены материалы, проведено совещание, принято решение, изменены сроки,"
        " получены замечания, ЗАПРОС от подрядчика на форму/шаблон/материал/информацию"
        " (блокирует выполнение договора → ВСЕГДА событие типа request_for_action)."
        " Простое подтверждение получения («приняли», «спасибо»), уточнения времени"
        " («во вторник в 11?»), приветствия — НЕ событие."
        "\n\n"
        "Сообщения с пометкой [уже зафиксировано как event] — это КОНТЕКСТ для понимания диалога."
        " Не включай их в message_indices как источник нового события (по ним event уже создан)."
        " Но используй для понимания, что обсуждается в диалоге."
    )

    contractor_line = f"Подрядчик: {contractor_name}\n" if contractor_name else ""
    feedback_block = format_feedback_block(feedback_examples or [])
    prompt = f"""Объект: {object_code}
{contractor_line}
Допустимые типы событий:
{templates_block}
{feedback_block}

Диалог (окно ~2 часа):
{msg_block}

Верни JSON:
{{
  "has_event": true | false,
  "template_code": "<code из списка> или null",
  "title": "<до 100 символов>",
  "note": "<1-3 предложения, суть события>",
  "confidence": <0-100, твоя уверенность>,
  "message_indices": [<номера сообщений из списка, послуживших основанием>]
}}

Если события нет — has_event=false, остальные поля пусты."""

    return ask_llm_json(prompt, system=system, max_tokens=600)


def apply_l2(messages, linked_ids, templates_l2, objects_map, chat_to_contractor, sb, verbose=False, max_windows=None):
    if not templates_l2:
        return []
    # Используем ВСЕ сообщения окна (включая уже связанные) для контекста,
    # но events создаём только когда есть источники-орфаны.
    windows = find_windows(messages)
    if max_windows:
        windows = windows[:max_windows]
    print(f"L2: {len(windows)} окон обсуждений → LLM")

    # Кеш few-shot examples по объекту (один SELECT на объект, не на каждое окно)
    feedback_cache: dict[str, list[dict]] = {}

    candidates = []
    for i, w in enumerate(windows, 1):
        obj_code = objects_map.get(w[0]["object_id"], "?")
        contractor_name = chat_to_contractor.get(w[0]["chat_id"])
        if obj_code not in feedback_cache:
            feedback_cache[obj_code] = load_feedback_examples(sb, obj_code, limit=8)
        examples = feedback_cache[obj_code]
        if verbose:
            print(f"  [{i}/{len(windows)}] {obj_code} {w[0]['msg_date']:%d.%m %H:%M} "
                  f"({len(w)} msgs, feedback: {len(examples)})")

        result = llm_classify_window(w, templates_l2, obj_code, contractor_name, examples, linked_ids)
        if not result or not result.get("has_event"):
            continue
        conf = int(result.get("confidence") or 0)
        if conf < L2_MIN_CONFIDENCE:
            continue

        indices = result.get("message_indices") or []
        all_msg_ids = [(idx, w[idx]) for idx in indices if isinstance(idx, int) and 0 <= idx < len(w)]
        # L2 — для текстовых обсуждений. Media-сообщения с filename — это L1 territory.
        # Не забираем их как source у L2 (иначе блокируем L1).
        text_only_msg_ids = [
            wm["id"] for _, wm in all_msg_ids
            if not (wm.get("has_media") and wm.get("media_file_name"))
        ]
        if not text_only_msg_ids:
            if verbose:
                print(f"      ↳ skip: LLM указал только media-сообщения — это работа L1, не L2")
            continue
        # Отфильтровать уже связанные сообщения — они только контекст, не источник нового event
        orphan_msg_ids = [mid for mid in text_only_msg_ids if mid not in linked_ids]
        if not orphan_msg_ids:
            if verbose:
                print(f"      ↳ skip: все text-источники LLM ({len(text_only_msg_ids)}) уже связаны")
            continue
        msg_ids = orphan_msg_ids

        tcode = result.get("template_code")
        if not any(t["code"] == tcode for t in templates_l2):
            tcode = "request_for_action"  # фоллбэк

        title = (result.get("title") or "Событие из обсуждения")[:240]
        note = result.get("note") or ""
        note += (
            f"\n\nИсточник: Telegram (LLM-классификация, {len(w)} сообщений, "
            f"{w[0]['msg_date']:%d.%m %H:%M} — {w[-1]['msg_date']:%d.%m %H:%M})"
        )

        candidates.append({
            "layer": "llm",
            "template_code": tcode,
            "event_type": "project_note",
            "title": title,
            "note": note,
            "object_ids": sorted(set(m["object_id"] for m in w if m["id"] in msg_ids)) or [w[0]["object_id"]],
            "event_date": w[0]["msg_date"].date(),
            "source_msg_ids": msg_ids,
            "confidence": min(conf, L2_MAX_CONFIDENCE),
            "_preview_files": [],
            "_preview_sender": f"{len({m.get('sender_name') for m in w})} авторов",
            "_preview_dt": w[0]["msg_date"],
        })
    return candidates


# ─── Запись в БД ─────────────────────────────────────────────────────────────


TG_KIND_TO_EA_KIND = {
    "photo": "image", "document": "document", "video": "video",
    "audio": "audio", "voice": "audio",
    "sticker": "image", "gif": "image", "webpage": "other",
}


def _find_existing_l1_event(sb, template_code: str, filename: str, event_date, new_obj_ids: list[str]) -> dict | None:
    """Cross-run dedup для L1: ищет существующее preliminary event с тем же шаблоном и filename за тот же день.
    Слияние только при пересечении object_ids — это значит один и тот же акт (рассылка одного файла).
    Если object_ids не пересекаются — семантически разные действия (один файл, но другая аудитория)."""
    if template_code not in ("doc_received", "doc_sent", "material_link", "photo_with_caption"):
        return None
    if not filename or not new_obj_ids:
        return None
    resp = (
        sb.table("events")
        .select("id, object_ids, title")
        .eq("is_preliminary", True)
        .eq("classifier_template_code", template_code)
        .eq("date_end", event_date.isoformat())
        .execute()
    )
    fname_marker = f"«{filename}»"
    new_set = set(new_obj_ids)
    for ev in (resp.data or []):
        if fname_marker not in (ev.get("title") or ""):
            continue
        existing_set = set(ev.get("object_ids") or [])
        # Сливаем только если есть хотя бы один общий object — один акт
        if existing_set & new_set:
            return ev
    return None


def write_to_db(sb, candidates, messages):
    """Создаёт events, event_tg_messages и event_attachments (для media-сообщений).
    Cross-run dedup: для L1 кандидатов с filename — если уже есть preliminary event
    с тем же template_code + filename + date → слияние (добавляем object_ids и связи)."""
    msg_by_id = {m["id"]: m for m in messages}

    inserted = 0
    merged = 0
    failed = 0
    attachments_created = 0

    for c in candidates:
        try:
            # ─── Cross-run dedup (только для L1) ──────────────────────────────
            existing = None
            if c["layer"] == "rule":
                filename = (c.get("_preview_files") or [None])[0]
                existing = _find_existing_l1_event(
                    sb, c["template_code"], filename, c["event_date"], c["object_ids"]
                )

            if existing:
                # Сливаем: добавляем object_ids + создаём event_tg_messages + event_attachments
                event_id = existing["id"]
                current_obj_ids = existing.get("object_ids") or []
                new_obj_ids = list(dict.fromkeys(current_obj_ids + c["object_ids"]))
                if new_obj_ids != current_obj_ids:
                    sb.table("events").update({"object_ids": new_obj_ids}).eq("id", event_id).execute()
                merged += 1
                # Continue к связям и attachments — общий блок ниже
            else:
                ev = sb.table("events").insert({
                    "event_type": c["event_type"],
                    "title": c["title"],
                    "note": c["note"],
                    "date_end": c["event_date"].isoformat(),
                    "object_ids": c["object_ids"],
                    "derived_source": "tg",
                    "is_preliminary": True,
                    "classifier_template_code": c["template_code"],
                }).execute()
                if not ev.data:
                    failed += 1
                    continue
                event_id = ev.data[0]["id"]

            # Связки с TG-сообщениями + event_attachments для media
            for msg_id in c["source_msg_ids"]:
                try:
                    sb.table("event_tg_messages").insert({
                        "event_id": event_id,
                        "tg_message_id": msg_id,
                        "confidence": c["confidence"],
                        "link_kind": "source",
                    }).execute()
                except Exception as e:
                    print(f"  ⚠ link insert: {e}")

                # Если у сообщения есть скачанный media-файл — прикрепляем к событию.
                # Это автоматически делает файл доступным через UI карточки события (FilesSection),
                # т.е. «файл едет в хранилище → видим в событии».
                m = msg_by_id.get(msg_id)
                if not m or not m.get("media_path") or not m.get("media_file_name"):
                    continue
                # Skip non-downloadable kinds (webpage без локального файла)
                if m.get("media_kind") == "webpage":
                    continue
                try:
                    sb.table("event_attachments").insert({
                        "event_id": event_id,
                        "kind": TG_KIND_TO_EA_KIND.get(m.get("media_kind"), "other"),
                        "file_name": m["media_file_name"],
                        "file_path": m["media_path"],
                        "file_size": m.get("media_size"),
                        "mime_type": m.get("media_mime"),
                    }).execute()
                    attachments_created += 1
                except Exception as e:
                    print(f"  ⚠ attachment insert ({m.get('media_file_name')}): {e}")
            if not existing:
                inserted += 1
        except Exception as e:
            print(f"  ⚠ event insert: {e}")
            failed += 1
    return inserted, merged, failed, attachments_created


# ─── Отчёт ───────────────────────────────────────────────────────────────────


def write_report(candidates, objects_map, chat_titles, mode, days, report_path: Path):
    by_layer = defaultdict(list)
    by_object = defaultdict(list)
    by_template = defaultdict(int)
    for c in candidates:
        by_layer[c["layer"]].append(c)
        for oid in c["object_ids"]:
            by_object[objects_map.get(oid, "?")].append(c)
        by_template[c["template_code"]] += 1

    lines = [
        f"# tg_classifier — прогон {datetime.now():%Y-%m-%d %H:%M}",
        "",
        f"**Режим:** `{mode}` · **Окно:** {days} дней · **Кандидатов:** {len(candidates)}",
        "",
        "## Сводка",
        "",
        f"- L1 (правила): **{len(by_layer.get('rule', []))}** кандидатов",
        f"- L2 (LLM): **{len(by_layer.get('llm', []))}** кандидатов",
        "",
        "### По объектам",
        "",
        "| Объект | Кандидатов |",
        "|--------|------------|",
    ]
    for obj_code, items in sorted(by_object.items(), key=lambda x: -len(x[1])):
        lines.append(f"| {obj_code} | {len(items)} |")
    lines += [
        "",
        "### По типам (template_code)",
        "",
        "| code | n |",
        "|------|---|",
    ]
    for tc, n in sorted(by_template.items(), key=lambda x: -x[1]):
        lines.append(f"| `{tc}` | {n} |")

    lines += ["", "## L1 кандидаты", ""]
    if not by_layer.get("rule"):
        lines.append("_нет_")
    else:
        lines += ["| Когда | Объекты | От | Тип | Title | conf |",
                  "|-------|---------|----|----|-------|------|"]
        for c in sorted(by_layer["rule"], key=lambda x: x["_preview_dt"], reverse=True):
            objs = ", ".join(objects_map.get(o, "?") for o in c["object_ids"])
            when = c["_preview_dt"].strftime("%d.%m %H:%M")
            sender = c["_preview_sender"]
            tc = c["template_code"]
            title = c["title"].replace("|", "/")
            lines.append(f"| {when} | {objs} | {sender} | `{tc}` | {title} | {c['confidence']} |")

    lines += ["", "## L2 кандидаты (LLM)", ""]
    if not by_layer.get("llm"):
        lines.append("_нет_")
    else:
        for c in sorted(by_layer["llm"], key=lambda x: x["_preview_dt"], reverse=True):
            objs = ", ".join(objects_map.get(o, "?") for o in c["object_ids"])
            when = c["_preview_dt"].strftime("%d.%m %H:%M")
            lines.append(f"### {when} · {objs} · `{c['template_code']}` · conf={c['confidence']}")
            lines.append(f"**{c['title']}**")
            lines.append("")
            lines.append(c["note"])
            lines.append("")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Отчёт: {report_path}")


# ─── Main ────────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser(description="tg_classifier — TG-сообщения → preliminary events")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="Не писать в БД, только отчёт")
    g.add_argument("--apply", action="store_true", help="Создать preliminary events в БД")
    ap.add_argument("--days", type=int, default=14, help="Окно в днях (default 14)")
    ap.add_argument("--object", default=None, help="Фильтр: только этот объект (по код-префиксу)")
    ap.add_argument("--layer", choices=["rule", "llm", "all"], default="all", help="Только rule / только llm / оба")
    ap.add_argument("--report", default=None, help="Путь к отчёту-файлу")
    ap.add_argument("--max-windows", type=int, default=None, help="Лимит L2-окон (для тестового прогона)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)                    # локальный (канон ЗПР)
    sb_cloud = create_client(SUPABASE_CLOUD_URL, SUPABASE_CLOUD_SECRET_KEY,  # облако (реестр TG)
                             options=ClientOptions(postgrest_client_timeout=60))
    msgs, linked_ids, t_l1, t_l2, obj_map, chat_titles, chat_to_contractor = load_data(sb, sb_cloud, args.days, args.object)
    if not msgs:
        print("Нет новых сообщений для классификации.")
        return

    print(f"Шаблоны: L1={len(t_l1)} L2={len(t_l2)}")

    candidates = []
    if args.layer in ("rule", "all"):
        # Загружаем объекты с aliases для caption-резолва (уже подгружены в load_data, но reload-safe)
        objects_full = sb.table("objects").select("id,code,current_name,aliases").execute().data or []
        for o in objects_full:
            o["_tokens"] = _extract_object_tokens(o)
        c1 = apply_l1(msgs, linked_ids, t_l1, chat_to_contractor, objects=objects_full)
        print(f"L1: {len(c1)} кандидатов")
        candidates += c1
    if args.layer in ("llm", "all"):
        c2 = apply_l2(msgs, linked_ids, t_l2, obj_map, chat_to_contractor, sb,
                      verbose=args.verbose, max_windows=args.max_windows)
        print(f"L2: {len(c2)} кандидатов")
        candidates += c2

    # Отчёт
    mode = "dry-run" if args.dry_run else "apply"
    if args.report:
        report_path = Path(args.report)
    else:
        report_path = DEFAULT_REPORT_DIR / f"{datetime.now():%Y-%m-%d_%H%M%S}_tg_classifier_{mode}.md"
    write_report(candidates, obj_map, chat_titles, mode, args.days, report_path)

    if args.apply:
        if not candidates:
            print("Нет кандидатов — нечего записывать.")
            return
        inserted, merged, failed, attached = write_to_db(sb, candidates, msgs)
        print(f"\nЗаписано в БД: {inserted} новых preliminary, {merged} слито с существующими "
              f"(failed: {failed}), прикреплено файлов: {attached}")
        print(f"Проверить: SELECT * FROM events WHERE is_preliminary=true ORDER BY created_at DESC LIMIT 20;")
    else:
        print(f"\nDRY-RUN: {len(candidates)} кандидатов не записаны. Запусти с --apply чтобы создать preliminary events.")


if __name__ == "__main__":
    main()
