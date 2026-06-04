"""
telegram_listener.py — слушает whitelisted Telegram-группы под личным
аккаунтом пользователя (MTProto, Telethon) и складывает сообщения
в систему ЗПР.

Команды:
  --auth              Авторизация (телефон + код), создаёт session-файл.
  --list-dialogs      Вывести все диалоги с chat_id — для telegram_whitelist.yaml.
  --listen            Подписаться на новые сообщения whitelisted чатов и писать в БД.
  --backfill DAYS     Забрать историю whitelisted чатов за последние N дней.

Все команды требуют пройденного --auth (создан .tg_session).

Раскладка медиа в Хранилище:
  STORAGE_DIR/TELEGRAM/{YYYY}/{MM}/{abs_chat_id}/{message_id}_{filename}

Запись в БД: tg_chats (реестр чатов) + tg_messages (сообщения).
См. миграцию 20260512000001_tg_messages.sql.
"""

import argparse
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

import yaml
from telethon import TelegramClient, events, utils
from telethon.tl.functions.messages import GetDialogFiltersRequest
from telethon.tl.types import (
    Channel,
    Chat,
    User,
    Message,
    MessageMediaPhoto,
    MessageMediaDocument,
    MessageMediaPoll,
    MessageMediaContact,
    MessageMediaGeo,
    MessageMediaWebPage,
    DocumentAttributeFilename,
    DocumentAttributeVideo,
    DocumentAttributeAudio,
    DocumentAttributeSticker,
    DocumentAttributeAnimated,
)

from config import (
    TG_API_ID,
    TG_API_HASH,
    TG_SESSION_PATH,
    TG_WHITELIST,
    STORAGE_DIR,
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
)

TELEGRAM_STORAGE_ROOT = "TELEGRAM"

# In-memory кеш дедупликации рассылок (один файл в N чатов в ±5 мин окне).
# Ключ: (sender_name, media_file_name, date, hour, 30min_bucket) → event_id.
# При совпадении — не создаём новое event, а аттачим новое сообщение к существующему
# и добавляем object_id в events.object_ids.
_recent_l1_events: dict[tuple, str] = {}
_RECENT_L1_MAX = 100   # эвикция: держим последние N записей


# Карта media_kind из tg_messages → kind для event_attachments (см. 14_Модель_событий)
TG_KIND_TO_EA_KIND = {
    "photo": "image", "document": "document", "video": "video",
    "audio": "audio", "voice": "audio",
    "sticker": "image", "gif": "image", "webpage": "other",
}


# ─── Клиенты ─────────────────────────────────────────────────────────────────


def _make_client() -> TelegramClient:
    if not TG_API_ID or not TG_API_HASH:
        sys.exit("config.TG_API_ID / TG_API_HASH не заполнены — см. https://my.telegram.org/apps")
    return TelegramClient(str(TG_SESSION_PATH), TG_API_ID, TG_API_HASH)


def _make_sb():
    from supabase import create_client

    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _entity_kind(entity) -> str:
    if isinstance(entity, Channel):
        return "channel" if entity.broadcast else "supergroup"
    if isinstance(entity, Chat):
        return "group"
    if isinstance(entity, User):
        return "user"
    return "group"


def _abs_chat_id(chat_id: int) -> int:
    """Для пути в Хранилище — убираем знак и Telegram-префикс супергрупп (-100)."""
    cid = abs(chat_id)
    s = str(cid)
    if len(s) >= 13 and s.startswith("100"):
        return int(s[3:])
    return cid


def _detect_media(msg: Message):
    """Возвращает (kind, file_name, size, mime) или (None, None, None, None)."""
    media = msg.media
    if media is None:
        return None, None, None, None

    if isinstance(media, MessageMediaPhoto):
        return "photo", None, None, "image/jpeg"
    if isinstance(media, MessageMediaPoll):
        return "poll", None, None, None
    if isinstance(media, MessageMediaContact):
        return "contact", None, None, None
    if isinstance(media, MessageMediaGeo):
        return "geo", None, None, None
    if isinstance(media, MessageMediaWebPage):
        return "webpage", None, None, None
    if isinstance(media, MessageMediaDocument):
        doc = media.document
        if doc is None:
            return "other", None, None, None
        mime = doc.mime_type or ""
        size = doc.size
        file_name = None
        is_voice = is_video = is_audio = is_sticker = is_animated = False
        for attr in (doc.attributes or []):
            if isinstance(attr, DocumentAttributeFilename):
                file_name = attr.file_name
            elif isinstance(attr, DocumentAttributeVideo):
                is_video = True
            elif isinstance(attr, DocumentAttributeAudio):
                is_audio = True
                is_voice = bool(getattr(attr, "voice", False))
            elif isinstance(attr, DocumentAttributeSticker):
                is_sticker = True
            elif isinstance(attr, DocumentAttributeAnimated):
                is_animated = True
        if is_sticker:
            kind = "sticker"
        elif is_animated:
            kind = "gif"
        elif is_voice:
            kind = "voice"
        elif is_video:
            kind = "video"
        elif is_audio:
            kind = "audio"
        else:
            kind = "document"
        return kind, file_name, size, mime

    return "other", None, None, None


def _default_filename(kind: str, message_id: int) -> str:
    return {
        "photo":   f"photo_{message_id}.jpg",
        "voice":   f"voice_{message_id}.ogg",
        "video":   f"video_{message_id}.mp4",
        "audio":   f"audio_{message_id}.mp3",
        "sticker": f"sticker_{message_id}.webp",
        "gif":     f"animation_{message_id}.mp4",
    }.get(kind, f"file_{message_id}.bin")


def _sanitize(name: str) -> str:
    return "".join(c for c in name if c not in '\\/:*?"<>|\n\r\t')[:200] or "file"


def _sender_info(msg: Message):
    sender = msg.sender
    if sender is None:
        return None, None, None
    sender_id = msg.sender_id
    sender_username = getattr(sender, "username", None)
    if isinstance(sender, User):
        parts = [getattr(sender, "first_name", None), getattr(sender, "last_name", None)]
        sender_name = " ".join(p for p in parts if p) or None
    else:
        sender_name = getattr(sender, "title", None)
    return sender_id, sender_username, sender_name


def _reply_info(msg: Message):
    """Returns (thread_id, reply_to_msg_id)."""
    rt = getattr(msg, "reply_to", None)
    if rt is None:
        return None, None
    is_topic = bool(getattr(rt, "forum_topic", False))
    top_id = getattr(rt, "reply_to_top_id", None)
    msg_id = getattr(rt, "reply_to_msg_id", None)
    if is_topic:
        return top_id, (msg_id if msg_id != top_id else None)
    return None, msg_id


def _load_whitelist() -> list[dict]:
    """Читает YAML, возвращает «сырые» entries: каждая либо {chat_id, ...}, либо {folder, ...}."""
    if not TG_WHITELIST.exists():
        sys.exit(
            f"Whitelist не найден: {TG_WHITELIST}\n"
            f"Скопируй telegram_whitelist.example.yaml → telegram_whitelist.yaml и заполни."
        )
    with open(TG_WHITELIST, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    chats = data.get("chats") or []
    chats = [c for c in chats if c and (c.get("chat_id") or c.get("folder"))]
    if not chats:
        sys.exit(f"В whitelist нет ни chat_id, ни folder: {TG_WHITELIST}")
    return chats


def _folder_title(f) -> str | None:
    """Извлекает имя папки. В новых версиях API title — TextWithEntities, в старых — str."""
    title = getattr(f, "title", None)
    if title is None:
        return None
    if hasattr(title, "text"):
        return title.text
    return str(title)


async def _get_folder_chats(client, folder_name: str) -> list[dict]:
    """Резолвит Telegram-папку (DialogFilter) по имени в список чатов."""
    result = await client(GetDialogFiltersRequest())
    raw_filters = getattr(result, "filters", None) or result  # на старых версиях возвращает список напрямую
    target = None
    available = []
    for f in raw_filters:
        name = _folder_title(f)
        if name:
            available.append(name)
        if name == folder_name:
            target = f
            break
    if target is None:
        sys.exit(f"Папка '{folder_name}' не найдена. Доступные: {available}")

    peers = list(getattr(target, "pinned_peers", None) or []) + \
            list(getattr(target, "include_peers", None) or [])
    out: list[dict] = []
    seen: set[int] = set()
    for peer in peers:
        try:
            entity = await client.get_entity(peer)
        except Exception as exc:
            print(f"  ⚠ get_entity({peer}): {exc}", flush=True)
            continue
        cid = utils.get_peer_id(peer)
        if cid in seen:
            continue
        seen.add(cid)
        title = getattr(entity, "title", None) or \
                f"{getattr(entity, 'first_name', '')} {getattr(entity, 'last_name', '')}".strip() or None
        out.append({
            "chat_id": cid,
            "title": title,
            "kind": _entity_kind(entity),
            "username": getattr(entity, "username", None),
        })
    return out


async def _resolve_whitelist(client, raw_entries: list[dict]) -> list[dict]:
    """Разворачивает folder-entries в плоский список уникальных {chat_id, title, handler}."""
    flat: list[dict] = []
    seen: set[int] = set()
    for entry in raw_entries:
        handler = entry.get("handler", "raw")
        if entry.get("folder"):
            chats = await _get_folder_chats(client, entry["folder"])
            print(f"  Папка '{entry['folder']}': {len(chats)} чатов", flush=True)
            for c in chats:
                if c["chat_id"] in seen:
                    continue
                seen.add(c["chat_id"])
                flat.append({"chat_id": c["chat_id"], "title": c["title"], "handler": handler})
        elif entry.get("chat_id"):
            cid = entry["chat_id"]
            if cid in seen:
                continue
            seen.add(cid)
            flat.append({"chat_id": cid, "title": entry.get("title"), "handler": handler})
    return flat


# ─── Сохранение в БД ─────────────────────────────────────────────────────────


async def _upsert_chat(sb, client, chat_id: int, handler: str, title_hint: str | None) -> None:
    try:
        entity = await client.get_entity(chat_id)
    except Exception as exc:
        print(f"  ⚠ get_entity({chat_id}) failed: {exc}", flush=True)
        return
    row = {
        "chat_id": chat_id,
        "title": getattr(entity, "title", None)
                 or f"{getattr(entity, 'first_name', '')} {getattr(entity, 'last_name', '')}".strip()
                 or title_hint,
        "username": getattr(entity, "username", None),
        "kind": _entity_kind(entity),
        "is_whitelisted": True,
        "handler": handler,
    }
    sb.table("tg_chats").upsert(row, on_conflict="chat_id").execute()


async def _save_message(sb, client, msg: Message, chat_id: int) -> dict | None:
    """Возвращает сохранённую строку (для классификатора) или None при дубле/ошибке."""
    kind, file_name, size, mime = _detect_media(msg)
    has_media = kind is not None
    media_rel_path = None
    final_file_name = file_name

    download_kinds = {"photo", "document", "video", "audio", "voice", "sticker", "gif"}
    if has_media and kind in download_kinds:
        dt = msg.date.astimezone(timezone.utc)
        chat_subdir = str(_abs_chat_id(chat_id))
        rel_dir = Path(TELEGRAM_STORAGE_ROOT) / f"{dt:%Y}" / f"{dt:%m}" / chat_subdir
        folder = STORAGE_DIR / rel_dir
        folder.mkdir(parents=True, exist_ok=True)
        base = file_name or _default_filename(kind, msg.id)
        full_name = f"{msg.id}_{_sanitize(base)}"
        dst = folder / full_name
        try:
            await client.download_media(msg, file=str(dst))
            media_rel_path = (rel_dir / full_name).as_posix()
            final_file_name = base
        except Exception as exc:
            print(f"  ⚠ media download {chat_id}/{msg.id}: {exc}", flush=True)

    sender_id, sender_username, sender_name = _sender_info(msg)
    thread_id, reply_to_msg_id = _reply_info(msg)

    try:
        raw_json = json.loads(msg.to_json())
    except Exception:
        raw_json = None

    row = {
        "chat_id": chat_id,
        "message_id": msg.id,
        "thread_id": thread_id,
        "reply_to_msg_id": reply_to_msg_id,
        "sender_id": sender_id,
        "sender_username": sender_username,
        "sender_name": sender_name,
        "msg_date": msg.date.isoformat(),
        "edit_date": msg.edit_date.isoformat() if msg.edit_date else None,
        "text": msg.message or None,
        "has_media": has_media,
        "media_kind": kind,
        "media_path": media_rel_path,
        "media_file_name": final_file_name,
        "media_mime": mime,
        "media_size": size,
        "raw_json": raw_json,
    }
    try:
        resp = sb.table("tg_messages").insert(row).execute()
        if not resp.data:
            return None
        # Возвращаем строку с сгенерированным БД id (uuid) — нужно классификатору
        saved = resp.data[0]
        return saved
    except Exception as exc:
        text = str(exc)
        if "23505" in text or "duplicate" in text.lower():
            return None
        print(f"  ⚠ insert {chat_id}/{msg.id}: {exc}", flush=True)
        return None


# ─── L1-классификатор в realtime ──────────────────────────────────────────────


def _is_me(sender_name: str | None) -> bool:
    if not sender_name:
        return False
    s = sender_name.lower()
    return "артем" in s and "антипов" in s or "antipov" in s


def _l1_bucket(sender_name: str, fname: str, msg_date_iso: str) -> tuple:
    """Окно дедупликации: один файл от одного автора в ±30-минутном бакете.
    Покрывает обычную рассылку одного файла в N чатов подряд."""
    dt = datetime.fromisoformat(msg_date_iso.replace("Z", "+00:00"))
    return (sender_name, fname, dt.date(), dt.hour, (dt.minute // 30) * 30)


def _evict_old_l1():
    """Простая эвикция: оставляем последние _RECENT_L1_MAX/3 записей."""
    if len(_recent_l1_events) > _RECENT_L1_MAX:
        keep = _RECENT_L1_MAX // 3
        items = list(_recent_l1_events.items())[-keep:]
        _recent_l1_events.clear()
        _recent_l1_events.update(items)


def _classify_l1_realtime(sb, saved_msg: dict, chat_to_obj: dict, chat_to_contractor: dict) -> str | None:
    """
    Создаёт preliminary event из одного только что сохранённого TG-сообщения (L1).
    Дедупликация рассылок: если рядом по времени уже было event с тем же sender+filename —
    цепляем это сообщение к нему вместо создания нового.
    Возвращает event_id или None (если сообщение не подходит под правила).
    """
    media_kind = saved_msg.get("media_kind")
    fname = saved_msg.get("media_file_name")
    sender_name = saved_msg.get("sender_name") or "unknown"

    # Фильтры L1: должен быть media с filename, нужный тип
    if not fname:
        return None
    if media_kind not in ("document", "photo", "video", "webpage"):
        return None
    # Photo без caption — слишком много шума, skip
    if media_kind == "photo" and not (saved_msg.get("text") or "").strip():
        return None

    chat_id = saved_msg["chat_id"]
    obj_id = chat_to_obj.get(chat_id)
    if not obj_id:
        return None  # чат не привязан к объекту — не классифицируем

    contractor = chat_to_contractor.get(chat_id)
    sender_role = "me" if _is_me(sender_name) else "other"
    caption = (saved_msg.get("text") or "").strip()

    # Выбор template_code и построение title
    if media_kind == "webpage":
        template_code = "material_link"
        cap_short = caption[:120] if caption else fname
        title = (f"Передана ссылка ({contractor}): {cap_short}"
                 if contractor else f"Передана ссылка: {cap_short}")
    elif sender_role == "me":
        template_code = "doc_sent"
        title = (f"Направлен документ «{fname}» подрядчику {contractor}"
                 if contractor else f"Направлен документ «{fname}»")
    else:
        template_code = "doc_received"
        title = (f"Получен документ «{fname}» от {contractor} отправитель {sender_name}"
                 if contractor else f"Получен документ «{fname}» от {sender_name}")

    bucket = _l1_bucket(sender_name, fname, saved_msg["msg_date"])

    # === Дедуп: тот же файл в другой чат за последние 5 мин ===
    existing_event_id = _recent_l1_events.get(bucket)
    if existing_event_id:
        try:
            # Линк нового сообщения к существующему event
            sb.table("event_tg_messages").insert({
                "event_id": existing_event_id,
                "tg_message_id": saved_msg["id"],
                "confidence": 85,
                "link_kind": "source",
            }).execute()

            # Дозаписываем object_id, если нет
            ev_resp = sb.table("events").select("object_ids").eq("id", existing_event_id).maybe_single().execute()
            if ev_resp and ev_resp.data:
                current_ids = ev_resp.data.get("object_ids") or []
                if obj_id not in current_ids:
                    sb.table("events").update({"object_ids": current_ids + [obj_id]}).eq("id", existing_event_id).execute()

            # Аттачим файл (если media есть)
            if saved_msg.get("media_path") and media_kind != "webpage":
                try:
                    sb.table("event_attachments").insert({
                        "event_id": existing_event_id,
                        "kind": TG_KIND_TO_EA_KIND.get(media_kind, "other"),
                        "file_name": fname,
                        "file_path": saved_msg["media_path"],
                        "file_size": saved_msg.get("media_size"),
                        "mime_type": saved_msg.get("media_mime"),
                    }).execute()
                except Exception:
                    pass  # дубль аттача — не страшно

            print(f"    ↳ ✨ присоединено к event {existing_event_id[:8]} (рассылка)", flush=True)
            return existing_event_id
        except Exception as e:
            print(f"  ⚠ realtime L1 dedup: {e}", flush=True)
            # Падаем — пробуем создать новый

    # === Новый event ===
    msg_date = datetime.fromisoformat(saved_msg["msg_date"].replace("Z", "+00:00"))
    note_lines = [
        f"Цитата: «{caption[:400]}»" if caption else f"Файл: {fname}",
        "",
        f"Источник: Telegram, {sender_name}, {msg_date:%d.%m.%Y %H:%M}",
    ]
    if contractor:
        note_lines[-1] += f" (подрядчик {contractor})"

    try:
        ev_resp = sb.table("events").insert({
            "event_type": "project_note",
            "title": title[:240],
            "note": "\n".join(note_lines),
            "date_end": msg_date.date().isoformat(),
            "object_ids": [obj_id],
            "derived_source": "tg",
            "is_preliminary": True,
            "classifier_template_code": template_code,
        }).execute()
        if not ev_resp.data:
            return None
        event_id = ev_resp.data[0]["id"]

        sb.table("event_tg_messages").insert({
            "event_id": event_id,
            "tg_message_id": saved_msg["id"],
            "confidence": 85,
            "link_kind": "source",
        }).execute()

        if saved_msg.get("media_path") and media_kind != "webpage":
            try:
                sb.table("event_attachments").insert({
                    "event_id": event_id,
                    "kind": TG_KIND_TO_EA_KIND.get(media_kind, "other"),
                    "file_name": fname,
                    "file_path": saved_msg["media_path"],
                    "file_size": saved_msg.get("media_size"),
                    "mime_type": saved_msg.get("media_mime"),
                }).execute()
            except Exception as e:
                print(f"  ⚠ attach: {e}", flush=True)

        _recent_l1_events[bucket] = event_id
        _evict_old_l1()
        print(f"    ↳ ✨ preliminary event: {title[:80]}", flush=True)
        return event_id
    except Exception as e:
        print(f"  ⚠ realtime L1 create: {e}", flush=True)
        return None


# ─── Команды ─────────────────────────────────────────────────────────────────


async def cmd_auth() -> None:
    client = _make_client()
    await client.start()
    me = await client.get_me()
    print(f"Авторизован как: {me.first_name} {me.last_name or ''} (@{me.username or '—'}, id={me.id})")
    await client.disconnect()


async def cmd_list_dialogs() -> None:
    client = _make_client()
    await client.start()

    rows: list[tuple[str, int, str, str]] = []
    async for dlg in client.iter_dialogs():
        ent = dlg.entity
        if isinstance(ent, Channel):
            kind = "канал" if ent.broadcast else "супергруппа"
        elif isinstance(ent, Chat):
            kind = "группа"
        elif isinstance(ent, User):
            kind = "ЛС"
        else:
            kind = type(ent).__name__
        username = f"@{ent.username}" if getattr(ent, "username", None) else ""
        rows.append((kind, dlg.id, dlg.name or "(без имени)", username))

    rows.sort(key=lambda r: (r[0], r[2].lower()))
    width_kind = max((len(r[0]) for r in rows), default=5)
    width_id = max((len(str(r[1])) for r in rows), default=5)
    width_name = max((len(r[2]) for r in rows), default=5)

    print(f"{'тип':<{width_kind}}  {'chat_id':>{width_id}}  {'название':<{width_name}}  username")
    print("-" * (width_kind + width_id + width_name + 12))
    for k, cid, name, uname in rows:
        print(f"{k:<{width_kind}}  {cid:>{width_id}}  {name:<{width_name}}  {uname}")

    await client.disconnect()


async def cmd_listen() -> None:
    client = _make_client()
    sb = _make_sb()
    await client.start()
    me = await client.get_me()
    print(f"Авторизован: {me.first_name} {me.last_name or ''} (@{me.username or '—'})", flush=True)

    raw_entries = _load_whitelist()
    whitelist = await _resolve_whitelist(client, raw_entries)
    if not whitelist:
        sys.exit("После резолва whitelist пуст — некого слушать.")
    for entry in whitelist:
        await _upsert_chat(sb, client, entry["chat_id"], entry.get("handler", "raw"), entry.get("title"))

    # Для L1-классификатора в realtime: чат → object_id и чат → подрядчик
    chat_to_obj: dict[int, str] = {}
    chat_to_contractor: dict[int, str | None] = {}
    chats_data = sb.table("tg_chats").select("chat_id,object_id").not_.is_("object_id", "null").execute().data or []
    objects_data = sb.table("objects").select("id,contractor").execute().data or []
    obj_to_contractor = {o["id"]: o.get("contractor") for o in objects_data}
    contractors_data = sb.table("contractors").select("code,full_name").execute().data or []
    contractor_name_by_code = {c["code"]: (c["full_name"] or c["code"]) for c in contractors_data}
    for c in chats_data:
        chat_to_obj[c["chat_id"]] = c["object_id"]
        code = obj_to_contractor.get(c["object_id"])
        chat_to_contractor[c["chat_id"]] = contractor_name_by_code.get(code) if code else None

    chat_ids = [e["chat_id"] for e in whitelist]
    print(f"Слушаю {len(chat_ids)} чатов. L1-классификатор в realtime активен.", flush=True)
    print("Ctrl+C для остановки.", flush=True)

    @client.on(events.NewMessage(chats=chat_ids))
    async def _handler(event):
        msg = event.message
        saved = await _save_message(sb, client, msg, event.chat_id)
        if not saved:
            return
        preview = ((msg.message or "")[:80]).replace("\n", " ")
        kind, *_ = _detect_media(msg)
        tag = f"[{kind}] " if kind else ""
        print(f"  + {event.chat_id} #{msg.id} {tag}{preview}", flush=True)

        # Хук: L1-классификатор сразу после сохранения. Создаёт preliminary event
        # (или присоединяет к существующему при рассылке). L2 LLM запускается batch'ем
        # отдельно через `python tg_classifier.py --apply --days 1`.
        try:
            _classify_l1_realtime(sb, saved, chat_to_obj, chat_to_contractor)
        except Exception as e:
            print(f"  ⚠ L1 realtime: {e}", flush=True)

    await client.run_until_disconnected()
    # Daemon не должен корректно завершаться. Если мы здесь — соединение оборвалось.
    # Поднимаем исключение, чтобы main вышел с non-zero exit code → Task Scheduler рестартует.
    raise RuntimeError("client.run_until_disconnected returned — соединение оборвалось")


async def cmd_backfill(days: int) -> None:
    client = _make_client()
    sb = _make_sb()
    await client.start()

    raw_entries = _load_whitelist()
    whitelist = await _resolve_whitelist(client, raw_entries)
    if not whitelist:
        sys.exit("После резолва whitelist пуст — нечего бэкфиллить.")
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    total_new = total_dup = 0
    for entry in whitelist:
        cid = entry["chat_id"]
        await _upsert_chat(sb, client, cid, entry.get("handler", "raw"), entry.get("title"))
        title = entry.get("title") or "?"
        print(f"Backfill {cid} '{title}' (последние {days} дн.)…", flush=True)
        new = dup = 0
        async for msg in client.iter_messages(cid, reverse=False):
            if msg.date.astimezone(timezone.utc) < cutoff:
                break
            saved = await _save_message(sb, client, msg, cid)
            if saved:
                new += 1
            else:
                dup += 1
        # NB: --backfill НЕ запускает L1-классификатор (это работа `tg_classifier.py --apply`).
        # Иначе массовая история создаст тонну preliminary без batch-дедупликации рассылок.
        print(f"  → {new} новых, {dup} дублей", flush=True)
        total_new += new
        total_dup += dup

    print(f"Готово: {total_new} новых, {total_dup} дублей.", flush=True)
    await client.disconnect()


# ─── CLI ─────────────────────────────────────────────────────────────────────


async def cmd_list_folders() -> None:
    """Показать все Telegram-папки (DialogFilter) по именам."""
    client = _make_client()
    await client.start()
    result = await client(GetDialogFiltersRequest())
    raw_filters = getattr(result, "filters", None) or result
    names: list[str] = []
    for f in raw_filters:
        name = _folder_title(f)
        if name:
            names.append(name)
    if not names:
        print("Telegram-папок не найдено (все чаты в общем списке).")
    else:
        print("Telegram-папки:")
        for n in names:
            print(f"  - {n}")
    await client.disconnect()


async def cmd_list_folder(folder_name: str) -> None:
    """Показать чаты внутри одной Telegram-папки."""
    client = _make_client()
    await client.start()
    chats = await _get_folder_chats(client, folder_name)
    print(f"Папка '{folder_name}': {len(chats)} чатов")
    if not chats:
        await client.disconnect()
        return
    width_kind = max((len(c["kind"]) for c in chats), default=5)
    width_id   = max((len(str(c["chat_id"])) for c in chats), default=10)
    print(f"{'тип':<{width_kind}}  {'chat_id':>{width_id}}  название")
    print("-" * (width_kind + width_id + 30))
    for c in chats:
        uname = f" @{c['username']}" if c["username"] else ""
        print(f"{c['kind']:<{width_kind}}  {c['chat_id']:>{width_id}}  {c['title']}{uname}")
    await client.disconnect()


def main() -> None:
    p = argparse.ArgumentParser(description="Telegram listener для ЗПР")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--auth", action="store_true", help="пройти авторизацию (создать .tg_session)")
    g.add_argument("--list-dialogs", action="store_true", help="вывести все диалоги с chat_id")
    g.add_argument("--list-folders", action="store_true", help="перечислить Telegram-папки (DialogFilter)")
    g.add_argument("--list-folder", metavar="NAME", help="вывести чаты внутри Telegram-папки")
    g.add_argument("--listen", action="store_true", help="слушать whitelisted чаты, писать в БД")
    g.add_argument("--backfill", type=int, metavar="DAYS", help="забрать историю whitelisted чатов за N дней")
    args = p.parse_args()

    if args.auth:
        asyncio.run(cmd_auth())
    elif args.list_dialogs:
        asyncio.run(cmd_list_dialogs())
    elif args.list_folders:
        asyncio.run(cmd_list_folders())
    elif args.list_folder:
        asyncio.run(cmd_list_folder(args.list_folder))
    elif args.listen:
        try:
            asyncio.run(cmd_listen())
        except KeyboardInterrupt:
            print("Listener: Ctrl+C, выход", flush=True)
            sys.exit(0)
        except Exception as exc:
            # Любой сбой listener'а (httpx ReadError, Telethon disconnect, etc.)
            # → non-zero exit. Task Scheduler рестартует через 1 минуту.
            print(f"Listener сбой: {type(exc).__name__}: {exc}", flush=True)
            sys.exit(1)
        # Защита от ошибок в asyncio.run без exception — тоже non-zero
        print("Listener: cmd_listen неожиданно завершился — выход для рестарта", flush=True)
        sys.exit(1)
    elif args.backfill is not None:
        asyncio.run(cmd_backfill(args.backfill))


if __name__ == "__main__":
    main()
