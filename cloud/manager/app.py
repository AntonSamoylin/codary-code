"""Менеджер облачных сред Codary Code.

Устройство: перед сайтом стоит nginx. На каждый запрос он спрашивает у менеджера /auth (auth_request): кто это и куда
его направить. Менеджер по cookie находит пользователя, при необходимости запускает для него контейнер с сервером OpenCode
(отдельный контейнер на человека, свои лимиты и свои тома) и отвечает адресом контейнера. Дальше nginx сам проксирует
запросы (в том числе потоки и WebSocket) напрямую в контейнер.

Вход: сайт codary.ru выдаёт подписанный токен (/enter?t=...), менеджер проверяет подпись и срок и ставит cookie.
Токены одноразовые. Кто имеет право входить — решает сайт; менеджер доверяет только подписи.
"""
import asyncio
import base64
import hashlib
import hmac
import html
import json
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

CFG = {
    "secret": os.environ.get("CC_SECRET", ""),
    "db": os.environ.get("CC_DB", "/opt/codary-cloud/state.db"),
    "image": os.environ.get("CC_IMAGE", "codary-cloud/workspace:dev"),
    "network": os.environ.get("CC_NETWORK", "codary-cloud"),
    "max_containers": int(os.environ.get("CC_MAX_CONTAINERS", "3")),
    "idle_minutes": float(os.environ.get("CC_IDLE_MINUTES", "20")),
    "session_hours": float(os.environ.get("CC_SESSION_HOURS", "12")),
    "memory": os.environ.get("CC_MEMORY", "1g"),
    "cpus": os.environ.get("CC_CPUS", "1.0"),
    "pids": os.environ.get("CC_PIDS", "512"),
    "cookie_secure": os.environ.get("CC_COOKIE_SECURE", "1") == "1",
    "token_max_age": int(os.environ.get("CC_TOKEN_MAX_AGE", "300")),
}
COOKIE = "cc_session"
CONTAINER_CONFIG = json.dumps({"disabled_providers": ["opencode", "opencode-go"], "autoupdate": False, "share": "disabled"})

state: dict[str, dict] = {}        # uid -> {"status": starting|running|stopped|failed, "ip": str, "last_seen": float, "error": str}
locks: dict[str, asyncio.Lock] = {}
sessions_cache: dict[str, tuple[str, float]] = {}


# ---------------------------------------------------------------- хранилище
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(CFG["db"], timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    os.makedirs(os.path.dirname(CFG["db"]), exist_ok=True)
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, uid TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL)")
        c.execute("CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, exp REAL NOT NULL)")
        c.execute("CREATE TABLE IF NOT EXISTS usage(uid TEXT NOT NULL, started REAL NOT NULL, stopped REAL)")


# ---------------------------------------------------------------- токен входа
def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(payload: dict) -> str:
    body = b64e(json.dumps(payload, separators=(",", ":")).encode())
    mac = hmac.new(CFG["secret"].encode(), body.encode(), hashlib.sha256).digest()
    return body + "." + b64e(mac)


def verify(token: str) -> dict | None:
    try:
        body, mac = token.split(".", 1)
        good = hmac.new(CFG["secret"].encode(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(good, b64d(mac)):
            return None
        p = json.loads(b64d(body))
        now = time.time()
        if not isinstance(p.get("uid"), (str, int)) or str(p["uid"]) == "" or not str(p["uid"]).isalnum():
            return None
        if p["exp"] < now or p["exp"] > now + CFG["token_max_age"]:
            return None
        return p
    except Exception:
        return None


# ---------------------------------------------------------------- docker
async def docker(*args: str, timeout: float = 60) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec("docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timeout"
    return proc.returncode or 0, out.decode(errors="replace").strip()


def cname(uid: str) -> str:
    return f"cc-u{uid}"


async def container_ip(uid: str) -> str:
    code, out = await docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", cname(uid))
    return out.split()[0] if code == 0 and out.split() else ""


async def healthy(ip: str) -> bool:
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(ip, 4096), 2)
        w.write(b"GET /global/health HTTP/1.0\r\nHost: x\r\n\r\n")
        await w.drain()
        data = await asyncio.wait_for(r.read(200), 3)
        w.close()
        return b" 200 " in data.split(b"\r\n", 1)[0] + b" "
    except Exception:
        return False


def running_count() -> int:
    return sum(1 for s in state.values() if s["status"] in ("starting", "running"))


async def start_container(uid: str):
    """Запускает (или поднимает остановленный) контейнер пользователя и ждёт готовности сервера."""
    s = state[uid]
    try:
        code, out = await docker("start", cname(uid))
        if code != 0:   # контейнера ещё нет — создаём
            code, out = await docker(
                "run", "-d", "--name", cname(uid), "--label", "codary.cloud=1", "--label", f"codary.uid={uid}",
                "--network", CFG["network"], "--memory", CFG["memory"], "--memory-swap", CFG["memory"], "--cpus", CFG["cpus"],
                "--pids-limit", CFG["pids"], "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
                "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m",   # exec нужен: сервер распаковывает в /tmp системную библиотеку терминала
                 "-v", f"cc-home-{uid}:/home/coder", "-v", f"cc-ws-{uid}:/workspace",
                "-e", f"OPENCODE_CONFIG_CONTENT={CONTAINER_CONFIG}", "--restart", "no", CFG["image"], timeout=120,
            )
            if code != 0:
                raise RuntimeError(out[-300:])
        ip = ""
        for _ in range(90):
            ip = await container_ip(uid)
            if ip and await healthy(ip):
                s.update(status="running", ip=ip, error="", last_seen=time.time())
                with db() as c:
                    c.execute("INSERT INTO usage(uid, started) VALUES(?,?)", (uid, time.time()))
                return
            await asyncio.sleep(1)
        raise RuntimeError("сервер в контейнере не ответил за 90 секунд")
    except Exception as e:
        s.update(status="failed", error=str(e)[:300])
        await docker("stop", "-t", "5", cname(uid))


async def stop_container(uid: str, reason: str):
    s = state.get(uid)
    if not s:
        return
    await docker("stop", "-t", "15", cname(uid), timeout=60)
    s.update(status="stopped", ip="")
    with db() as c:
        c.execute("UPDATE usage SET stopped=? WHERE uid=? AND stopped IS NULL", (time.time(), uid))


async def is_busy(ip: str) -> bool:
    """Есть ли в контейнере работающие сеансы агента: такую среду не усыпляем, пока агент занят."""
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(ip, 4096), 2)
        w.write(b"GET /session/status HTTP/1.0\r\nHost: x\r\nx-opencode-directory: %2Fworkspace\r\n\r\n")
        await w.drain()
        data = await asyncio.wait_for(r.read(65536), 4)
        w.close()
        body = data.split(b"\r\n\r\n", 1)[-1]
        return b'"busy"' in body or b'"retry"' in body
    except Exception:
        return False


async def reaper():
    while True:
        await asyncio.sleep(60)
        try:
            now = time.time()
            for uid, s in list(state.items()):
                if s["status"] != "running":
                    continue
                if now - s["last_seen"] > CFG["idle_minutes"] * 60 and not await is_busy(s["ip"]):
                    await stop_container(uid, "простой")
        except Exception as e:  # noqa: BLE001
            print("reaper:", e, flush=True)


async def reconcile():
    """После перезапуска менеджера подхватываем уже работающие контейнеры."""
    code, out = await docker("ps", "-a", "--filter", "label=codary.cloud=1", "--format", "{{.Label \"codary.uid\"}} {{.State}}")
    for line in out.splitlines():
        uid, _, st = line.partition(" ")
        if not uid:
            continue
        if st == "running":
            ip = await container_ip(uid)
            state[uid] = {"status": "running", "ip": ip, "last_seen": time.time(), "error": ""}
        else:
            state[uid] = {"status": "stopped", "ip": "", "last_seen": 0, "error": ""}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not CFG["secret"] or len(CFG["secret"]) < 32:
        raise SystemExit("CC_SECRET (не короче 32 символов) не задан")
    init_db()
    await reconcile()
    task = asyncio.create_task(reaper())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------- вход и проверка доступа
def session_uid(request: Request) -> str | None:
    sid = request.cookies.get(COOKIE)
    if not sid:
        return None
    hit = sessions_cache.get(sid)
    now = time.time()
    if hit and hit[1] > now:
        return hit[0]
    with db() as c:
        row = c.execute("SELECT uid, expires FROM sessions WHERE id=?", (sid,)).fetchone()
    if not row or row[1] < now:
        sessions_cache.pop(sid, None)
        return None
    sessions_cache[sid] = (row[0], min(row[1], now + 60))
    return row[0]


@app.get("/enter")
async def enter(t: str = ""):
    p = verify(t)
    if not p:
        return HTMLResponse("<h3>Ссылка входа недействительна или устарела.</h3><p>Вернитесь на codary.ru и откройте облачную среду заново.</p>", status_code=403)
    now = time.time()
    with db() as c:
        c.execute("DELETE FROM nonces WHERE exp < ?", (now,))
        try:
            c.execute("INSERT INTO nonces(nonce, exp) VALUES(?,?)", (str(p.get("n", "")) or secrets.token_hex(4), p["exp"] + 60))
        except sqlite3.IntegrityError:
            return HTMLResponse("<h3>Эта ссылка уже использована.</h3><p>Откройте облачную среду заново на codary.ru.</p>", status_code=403)
        sid = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions(id, uid, created, expires) VALUES(?,?,?,?)", (sid, str(p["uid"]), now, now + CFG["session_hours"] * 3600))
    resp = RedirectResponse("/", status_code=302)
    resp.set_cookie(COOKIE, sid, max_age=int(CFG["session_hours"] * 3600), httponly=True, secure=CFG["cookie_secure"], samesite="lax", path="/")
    return resp


@app.get("/auth")
async def auth(request: Request):
    """Вызывается nginx перед каждым запросом: 200 + X-Upstream — пускаем, 401 — на вход, 403 — среда запускается или мест нет."""
    uid = session_uid(request)
    if not uid:
        return Response(status_code=401)
    s = state.get(uid)
    now = time.time()
    if s and s["status"] == "running":
        if now - s["last_seen"] > 5:
            s["last_seen"] = now
        return Response(status_code=200, headers={"X-Upstream": f"{s['ip']}:4096", "X-Cc-Uid": uid})
    lock = locks.setdefault(uid, asyncio.Lock())
    async with lock:
        s = state.get(uid)
        if s and s["status"] == "starting":
            return Response(status_code=403, headers={"X-Reason": "starting"})
        if running_count() >= CFG["max_containers"]:
            return Response(status_code=403, headers={"X-Reason": "busy"})
        state[uid] = {"status": "starting", "ip": "", "last_seen": now, "error": ""}
        asyncio.create_task(start_container(uid))
    return Response(status_code=403, headers={"X-Reason": "starting"})


PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codary Code в облаке</title>{refresh}<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 20px;color:#18283a}}
h1{{font-size:1.4rem}}.s{{color:#556}}</style></head><body><h1>{title}</h1><p class="s">{text}</p></body></html>"""


@app.get("/wait")
async def wait(request: Request):
    uid = session_uid(request)
    if not uid:
        return RedirectResponse("https://codary.ru/code.php", status_code=302)
    s = state.get(uid, {})
    if s.get("status") == "running":
        return RedirectResponse("/", status_code=302)
    if s.get("status") == "failed":
        state.pop(uid, None)
        return HTMLResponse(PAGE.format(refresh="", title="Не удалось запустить среду", text=html.escape("Что-то пошло не так. Обновите страницу, чтобы повторить; если повторяется, напишите нам.")), status_code=503)
    if running_count() >= CFG["max_containers"] and s.get("status") != "starting":
        return HTMLResponse(PAGE.format(refresh='<meta http-equiv="refresh" content="15">', title="Все места заняты", text="Сейчас работают все доступные среды. Страница обновится сама, как только освободится место."), status_code=503)
    return HTMLResponse(PAGE.format(refresh='<meta http-equiv="refresh" content="3">', title="Запускаем вашу среду…", text="Обычно это занимает 10–20 секунд. Страница обновится сама."), status_code=200)


@app.get("/status")
async def status(request: Request):
    if request.client and request.client.host not in ("127.0.0.1", "::1"):
        return Response(status_code=404)
    return JSONResponse({"max": CFG["max_containers"], "running": running_count(), "users": {u: {k: v for k, v in s.items()} for u, s in state.items()}})
