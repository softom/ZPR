"""
tg_web_admin.py — Web-админка TG-листенера (US-сервер).

FastAPI + Jinja2. Порт 8080.
  - Дашборд: статус синхронизации, счётчики, лог.
  - Клиенты: CRUD API-клиентов с ключами.
  - Доступ: per-client чат-разрешения (read / write).
  - Client API: /api/v1/* — внешние приложения читают данные по API-ключу.

Запуск:
  python tg_web_admin.py                          # dev
  uvicorn tg_web_admin:app --host 0.0.0.0 --port 8080  # prod

Переменные (config.py или env):
  ADMIN_TOKEN  — токен доступа к админ-панели (default: changeme).
"""

import os
import secrets
import subprocess
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request, Depends, HTTPException, Query, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client as sb_create

from config import SUPABASE_URL, SUPABASE_SECRET_KEY

# ── app ──────────────────────────────────────────────────────────────
app = FastAPI(title="ZPR TG Admin", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])

BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "tg_web" / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "tg_web" / "templates")

sb = sb_create(SUPABASE_URL, SUPABASE_SECRET_KEY)

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN",
                              getattr(__import__("config"), "ADMIN_TOKEN", "changeme"))

# ── helpers ──────────────────────────────────────────────────────────
def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _service_status() -> dict:
    """Статус systemd-сервиса листенера."""
    info = {"active": "unknown", "uptime": "", "memory": ""}
    try:
        r = subprocess.run(
            ["systemctl", "show", "zpr-tg-listener",
             "--property=ActiveState,SubState,ActiveEnterTimestamp,MemoryCurrent"],
            capture_output=True, text=True, timeout=5)
        for line in r.stdout.strip().splitlines():
            k, _, v = line.partition("=")
            if k == "ActiveState":
                info["active"] = v
            elif k == "ActiveEnterTimestamp" and v:
                info["uptime"] = v
            elif k == "MemoryCurrent" and v.isdigit():
                info["memory"] = f"{int(v) / (1024*1024):.1f} MB"
    except Exception:
        pass
    return info


def _disk_info() -> Optional[dict]:
    for p in [Path("/opt/zpr/storage"), Path("/opt/zpr"), Path("/")]:
        if p.exists():
            u = shutil.disk_usage(p)
            return {"total": round(u.total / 2**30, 1),
                    "used": round(u.used / 2**30, 1),
                    "free": round(u.free / 2**30, 1),
                    "pct": round(u.used / u.total * 100)}
    return None


def _log_tail(n: int = 40) -> list[str]:
    for p in [Path("/opt/zpr/logs/listener.log"), Path("/opt/zpr/logs/backfill.log")]:
        if p.exists():
            try:
                lines = p.read_text(errors="replace").splitlines()
                if lines:
                    return lines[-n:]
            except Exception:
                pass
    return []


def _backfill_status() -> dict:
    """Статус процесса backfill."""
    info = {"running": False, "pid": None}
    try:
        r = subprocess.run(
            ["pgrep", "-f", "tg_raw_listener.py --backfill"],
            capture_output=True, text=True, timeout=5)
        pids = r.stdout.strip().splitlines()
        if pids:
            info["running"] = True
            info["pid"] = pids[0]
    except Exception:
        pass
    return info


# ── auth ─────────────────────────────────────────────────────────────
def require_admin(request: Request):
    """Проверка admin-токена: cookie или ?token=... → /login при отсутствии."""
    token = request.cookies.get("admin_token") or request.query_params.get("token")
    if not token or token != ADMIN_TOKEN:
        # Для HTML-страниц — redirect, для API — 401
        if "api/" in request.url.path:
            raise HTTPException(status_code=401, detail="Unauthorized")
        raise HTTPException(status_code=307,
                            headers={"Location": "/login"})
    return token


def require_client(request: Request):
    """Проверка API-ключа клиента: заголовок X-Api-Key или ?api_key=..."""
    api_key = request.headers.get("X-Api-Key") or request.query_params.get("api_key")
    if not api_key:
        raise HTTPException(status_code=401, detail="API key required (X-Api-Key header)")
    result = sb.table("tg_clients").select("*").eq("api_key", api_key).eq("is_active", True).execute()
    if not result.data:
        raise HTTPException(status_code=403, detail="Invalid or inactive API key")
    return result.data[0]


# ── login ────────────────────────────────────────────────────────────
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request=request, name="login.html")


@app.post("/login")
async def login_submit(request: Request, token: str = Form(...)):
    if token != ADMIN_TOKEN:
        return templates.TemplateResponse(request=request, name="login.html",
                                          context={"error": "Неверный токен"})
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie("admin_token", token, httponly=True, max_age=86400 * 7)
    return resp


@app.get("/logout")
async def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie("admin_token")
    return resp


# ── dashboard ────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, _=Depends(require_admin)):
    service = _service_status()
    backfill = _backfill_status()
    disk = _disk_info()

    # Чаты
    chats = sb.table("tg_chats").select("*").order("title").execute().data or []

    # Счётчики
    total = sb.table("tg_messages").select("id", count="exact").execute().count or 0
    today_iso = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0).isoformat()
    today_count = (sb.table("tg_messages").select("id", count="exact")
                   .gte("ingested_at", today_iso).execute().count or 0)

    # Последние сообщения
    recent = (sb.table("tg_messages")
              .select("chat_id,message_id,sender_name,msg_date,text")
              .order("msg_date", desc=True).limit(25).execute().data or [])

    # Подмешиваем название чата
    chat_map = {c["chat_id"]: c.get("title", str(c["chat_id"])) for c in chats}
    for m in recent:
        m["_chat_title"] = chat_map.get(m["chat_id"], str(m["chat_id"]))

    log_lines = _log_tail(40)

    # Клиенты (count)
    clients_count = sb.table("tg_clients").select("id", count="exact").execute().count or 0

    return templates.TemplateResponse(request=request, name="dashboard.html", context={
        "service": service,
        "backfill": backfill,
        "disk": disk,
        "chats": chats,
        "chat_count": len(chats),
        "total_messages": total,
        "today_messages": today_count,
        "clients_count": clients_count,
        "recent": recent,
        "log_lines": log_lines,
    })


# ── service controls ─────────────────────────────────────────────────
@app.post("/ctl/listener/start")
async def ctl_listener_start(_=Depends(require_admin)):
    subprocess.run(["systemctl", "start", "zpr-tg-listener"], timeout=10)
    return RedirectResponse("/", status_code=303)


@app.post("/ctl/listener/stop")
async def ctl_listener_stop(_=Depends(require_admin)):
    subprocess.run(["systemctl", "stop", "zpr-tg-listener"], timeout=10)
    return RedirectResponse("/", status_code=303)


@app.post("/ctl/backfill/start")
async def ctl_backfill_start(_=Depends(require_admin), days: int = Form(365)):
    """Запустить backfill в фоне (nice -n 19)."""
    bf = _backfill_status()
    if bf["running"]:
        return RedirectResponse("/", status_code=303)  # уже идёт
    subprocess.Popen(
        ["nice", "-n", "19", "ionice", "-c", "3",
         "/opt/zpr/venv/bin/python", "/opt/zpr/app/tg_raw_listener.py",
         "--backfill", str(days)],
        stdout=open("/opt/zpr/logs/backfill.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return RedirectResponse("/", status_code=303)


@app.post("/ctl/backfill/stop")
async def ctl_backfill_stop(_=Depends(require_admin)):
    """Остановить backfill (SIGTERM)."""
    subprocess.run(["pkill", "-f", "tg_raw_listener.py --backfill"], timeout=10)
    return RedirectResponse("/", status_code=303)


# ── clients CRUD (admin pages) ──────────────────────────────────────
@app.get("/clients", response_class=HTMLResponse)
async def clients_page(request: Request, _=Depends(require_admin)):
    clients = sb.table("tg_clients").select("*").order("created_at").execute().data or []
    return templates.TemplateResponse(request=request, name="clients.html",
                                      context={"clients": clients})


@app.post("/clients/create")
async def client_create(request: Request, _=Depends(require_admin),
                        name: str = Form(...), note: str = Form("")):
    api_key = f"zpr_{secrets.token_urlsafe(32)}"
    sb.table("tg_clients").insert({
        "name": name, "api_key": api_key, "note": note, "is_active": True,
    }).execute()
    return RedirectResponse("/clients", status_code=303)


@app.post("/clients/{cid}/toggle")
async def client_toggle(cid: str, _=Depends(require_admin)):
    cur = sb.table("tg_clients").select("is_active").eq("id", cid).single().execute().data
    sb.table("tg_clients").update({"is_active": not cur["is_active"]}).eq("id", cid).execute()
    return RedirectResponse("/clients", status_code=303)


@app.post("/clients/{cid}/delete")
async def client_delete(cid: str, _=Depends(require_admin)):
    sb.table("tg_clients").delete().eq("id", cid).execute()
    return RedirectResponse("/clients", status_code=303)


# ── client access (admin page) ──────────────────────────────────────
@app.get("/clients/{cid}/access", response_class=HTMLResponse)
async def client_access_page(cid: str, request: Request, _=Depends(require_admin)):
    client = sb.table("tg_clients").select("*").eq("id", cid).single().execute().data
    chats = sb.table("tg_chats").select("chat_id,title,kind,username").order("title").execute().data or []
    access = sb.table("tg_client_chat_access").select("*").eq("client_id", cid).execute().data or []
    access_map = {a["chat_id"]: a for a in access}
    return templates.TemplateResponse(request=request, name="client_access.html",
                                      context={"client": client, "chats": chats,
                                               "access_map": access_map})


@app.post("/clients/{cid}/access")
async def client_access_save(cid: str, request: Request, _=Depends(require_admin)):
    form = await request.form()
    # Чекбоксы приходят как "read_{chat_id}" и "write_{chat_id}"
    chats = sb.table("tg_chats").select("chat_id").execute().data or []
    rows = []
    for c in chats:
        chat_id = c["chat_id"]
        can_read = form.get(f"read_{chat_id}") == "on"
        can_write = form.get(f"write_{chat_id}") == "on"
        if can_read or can_write:
            rows.append({"client_id": cid, "chat_id": chat_id,
                         "can_read": can_read, "can_write": can_write})
    # Atomic: delete + insert
    sb.table("tg_client_chat_access").delete().eq("client_id", cid).execute()
    if rows:
        sb.table("tg_client_chat_access").insert(rows).execute()
    return RedirectResponse(f"/clients/{cid}/access", status_code=303)


# ── Client API (external apps) ──────────────────────────────────────
@app.get("/api/v1/chats")
async def api_chats(client=Depends(require_client)):
    """Список доступных клиенту чатов."""
    access = (sb.table("tg_client_chat_access")
              .select("chat_id,can_read,can_write")
              .eq("client_id", client["id"]).execute().data or [])
    readable = [a["chat_id"] for a in access if a["can_read"]]
    if not readable:
        return []
    chats = (sb.table("tg_chats")
             .select("chat_id,title,kind,username")
             .in_("chat_id", readable).execute().data or [])
    return chats


@app.get("/api/v1/messages")
async def api_messages(
    client=Depends(require_client),
    chat_id: Optional[int] = Query(None, description="Фильтр по чату"),
    since: Optional[str] = Query(None, description="ISO date, от какой даты"),
    limit: int = Query(50, le=500),
    offset: int = Query(0),
):
    """Сообщения из доступных клиенту чатов."""
    access = (sb.table("tg_client_chat_access")
              .select("chat_id").eq("client_id", client["id"])
              .eq("can_read", True).execute().data or [])
    readable = {a["chat_id"] for a in access}
    if not readable:
        return []
    if chat_id is not None:
        if chat_id not in readable:
            raise HTTPException(403, "No read access to this chat")
        q = sb.table("tg_messages").select("*").eq("chat_id", chat_id)
    else:
        q = sb.table("tg_messages").select("*").in_("chat_id", list(readable))
    if since:
        q = q.gte("msg_date", since)
    result = q.order("msg_date", desc=True).limit(limit).offset(offset).execute()
    return result.data or []


@app.get("/api/v1/status")
async def api_status(client=Depends(require_client)):
    """Общий статус синхронизации для клиента."""
    access = (sb.table("tg_client_chat_access")
              .select("chat_id").eq("client_id", client["id"])
              .eq("can_read", True).execute().data or [])
    readable = [a["chat_id"] for a in access]
    total = 0
    if readable:
        total = (sb.table("tg_messages").select("id", count="exact")
                 .in_("chat_id", readable).execute().count or 0)
    return {"chats": len(readable), "messages": total}


# ── health ───────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "ts": _now_iso()}


# ── main ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("tg_web_admin:app", host="0.0.0.0", port=8080, reload=True)
