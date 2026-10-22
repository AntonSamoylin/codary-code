"""Менеджер облачных сред Codary Code (закрытая альфа).

Устройство: перед сайтом стоит nginx. На каждый запрос он спрашивает у менеджера /auth (auth_request): кто это и куда
его направить. Менеджер по cookie находит пользователя, при необходимости запускает для него контейнер с сервером OpenCode
(отдельный контейнер на человека, свои лимиты, свой диск) и отвечает адресом контейнера. Дальше nginx сам проксирует запросы
(в том числе потоки и WebSocket) напрямую в контейнер.

Вход: сайт codary.ru выдаёт подписанный токен (/enter?t=...), менеджер проверяет подпись и срок и ставит cookie. Токены
одноразовые. Кто имеет право входить, решает сайт; менеджер доверяет только подписи. Токен с признаком adm открывает панель /_admin.

Квоты: диск — у каждого пользователя свой образ файловой системы фиксированного размера (жёсткий предел); время — минуты
работы среды в сутки (по московскому времени). Учёт — таблицы usage и events в SQLite. Оповещения — на сайт (cloud-alert.php → Telegram).
"""
import asyncio
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, Form, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse

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
    "data": os.environ.get("CC_DATA", "/var/lib/codary-cloud"),
    "limits_file": os.environ.get("CC_LIMITS", "/opt/codary-cloud/limits.json"),
    "disk_gb": float(os.environ.get("CC_DISK_GB", "5")),
    "daily_minutes": float(os.environ.get("CC_DAILY_MINUTES", "480")),
    "grace_minutes": float(os.environ.get("CC_GRACE_MINUTES", "30")),   # сколько ещё дать занятому агенту после лимита времени
    "tz_hours": float(os.environ.get("CC_TZ_HOURS", "3")),               # «сутки» считаем по Москве
    "alert_url": os.environ.get("CC_ALERT_URL", ""),
    "alert_secret": os.environ.get("CC_ALERT_SECRET", ""),
    "min_avail_mb": float(os.environ.get("CC_MIN_AVAIL_MB", "600")),     # ниже — новые среды не запускаем
    "warn_avail_mb": float(os.environ.get("CC_WARN_AVAIL_MB", "900")),   # ниже — оповещение администратору
    "digest_hour_utc": int(os.environ.get("CC_DIGEST_HOUR_UTC", "6")),   # 06:00 UTC = 09:00 МСК
    "disk_warn": float(os.environ.get("CC_DISK_WARN", "0.9")),
    "disk_check_seconds": float(os.environ.get("CC_DISK_CHECK_SECONDS", "300")),
}
COOKIE = "cc_session"
CONTAINER_CONFIG = json.dumps({"disabled_providers": ["opencode", "opencode-go"], "autoupdate": False, "share": "disabled"})

state: dict[str, dict] = {}        # uid -> {"status": starting|running|stopped|failed, "ip", "last_seen", "error", "starts", "extra_until"}
locks: dict[str, asyncio.Lock] = {}
sessions_cache: dict[str, tuple[str, int, float]] = {}
alert_last: dict[str, float] = {}
peak = {"day": 0}
_limits = {"mtime": 0.0, "data": {}}


# ---------------------------------------------------------------- хранилище
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(CFG["db"], timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    os.makedirs(os.path.dirname(CFG["db"]), exist_ok=True)
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, uid TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, admin INTEGER NOT NULL DEFAULT 0)")
        cols = [r[1] for r in c.execute("PRAGMA table_info(sessions)")]
        if "admin" not in cols:
            c.execute("ALTER TABLE sessions ADD COLUMN admin INTEGER NOT NULL DEFAULT 0")
        c.execute("CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, exp REAL NOT NULL)")
        c.execute("CREATE TABLE IF NOT EXISTS usage(uid TEXT NOT NULL, started REAL NOT NULL, stopped REAL)")
        c.execute("CREATE TABLE IF NOT EXISTS events(ts REAL NOT NULL, kind TEXT NOT NULL, uid TEXT, detail TEXT)")
        c.execute("CREATE INDEX IF NOT EXISTS usage_uid ON usage(uid, started)")


def event(kind: str, uid: str | None = None, detail: str = ""):
    try:
        with db() as c:
            c.execute("INSERT INTO events(ts, kind, uid, detail) VALUES(?,?,?,?)", (time.time(), kind, uid, detail[:400]))
    except Exception as e:  # noqa: BLE001
        print("event:", e, flush=True)


def limits(uid: str) -> dict:
    """Лимиты пользователя: значения по умолчанию + переопределения из limits.json
    ({"default": {"disk_gb": 5, "daily_minutes": 480}, "users": {"3": {"disk_gb": 20, "daily_minutes": 1440, "disabled": false}}})."""
    try:
        m = os.stat(CFG["limits_file"]).st_mtime
        if m != _limits["mtime"]:
            _limits["data"] = json.load(open(CFG["limits_file"]))
            _limits["mtime"] = m
    except FileNotFoundError:
        _limits["data"] = {}
    except Exception as e:  # noqa: BLE001
        print("limits.json:", e, flush=True)
    out = {"disk_gb": CFG["disk_gb"], "daily_minutes": CFG["daily_minutes"], "disabled": False}
    out.update(_limits["data"].get("default", {}))
    out.update(_limits["data"].get("users", {}).get(uid, {}))
    return out


# ---------------------------------------------------------------- время и учёт
def day_bounds(now: float) -> tuple[float, float]:
    off = CFG["tz_hours"] * 3600
    start = ((now + off) // 86400) * 86400 - off
    return start, start + 86400


def used_seconds(uid: str, now: float | None = None) -> float:
    now = now or time.time()
    d0, d1 = day_bounds(now)
    total = 0.0
    with db() as c:
        for started, stopped in c.execute("SELECT started, stopped FROM usage WHERE uid=? AND (stopped IS NULL OR stopped>?) AND started<?", (uid, d0, d1)):
            total += max(0.0, min(stopped or now, d1) - max(started, d0))
    return total


def host_avail_mb() -> float:
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 99999.0


# ---------------------------------------------------------------- оповещения
async def alert(key: str, text: str, cooldown: float = 1800):
    """Отправляет сообщение администратору через сайт; одинаковые (по key) не чаще, чем раз в cooldown секунд."""
    now = time.time()
    event("alert", None, text[:300])
    if now - alert_last.get(key, 0) < cooldown:
        return
    alert_last[key] = now
    if not CFG["alert_url"] or not CFG["alert_secret"]:
        print("alert (адрес не задан):", text, flush=True)
        return

    def post():
        req = urllib.request.Request(CFG["alert_url"], data=json.dumps({"text": "☁ Облако Codary: " + text}).encode(),
                                     headers={"content-type": "application/json", "x-cloud-secret": CFG["alert_secret"]}, method="POST")
        urllib.request.urlopen(req, timeout=10).read()

    try:
        await asyncio.to_thread(post)
    except Exception as e:  # noqa: BLE001
        print("alert не отправлен:", e, flush=True)


# ---------------------------------------------------------------- токен входа
def b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify(token: str) -> dict | None:
    try:
        body, mac = token.split(".", 1)
        good = hmac.new(CFG["secret"].encode(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(good, b64d(mac)):
            return None
        p = json.loads(b64d(body))
        now = time.time()
        if str(p.get("uid", "")) == "" or not str(p["uid"]).isalnum():
            return None
        if p["exp"] < now or p["exp"] > now + CFG["token_max_age"]:
            return None
        return p
    except Exception:
        return None


# ---------------------------------------------------------------- команды системы и docker
async def run(*args: str, timeout: float = 60) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timeout"
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def docker(*args: str, timeout: float = 60) -> tuple[int, str]:
    return await run("docker", *args, timeout=timeout)


def cname(uid: str) -> str:
    return f"cc-u{uid}"


def img_path(uid: str) -> str:
    return f"{CFG['data']}/img/u{uid}.img"


def mnt_path(uid: str) -> str:
    return f"{CFG['data']}/mnt/u{uid}"


def is_mounted(path: str) -> bool:
    try:
        return any(line.split()[1] == path for line in open("/proc/mounts"))
    except OSError:
        return False


async def ensure_disk(uid: str) -> str:
    """Диск пользователя: образ ext4 фиксированного размера, подключённый как каталог. Размер — жёсткий предел."""
    img, mnt = img_path(uid), mnt_path(uid)
    os.makedirs(os.path.dirname(img), exist_ok=True)
    os.makedirs(mnt, exist_ok=True)
    if not os.path.exists(img):
        size_mb = int(limits(uid)["disk_gb"] * 1024)
        code, out = await run("truncate", "-s", f"{size_mb}M", img)
        if code == 0:
            code, out = await run("mkfs.ext4", "-q", "-F", "-m", "0", "-L", f"cc{uid}", img, timeout=120)
        if code != 0:
            try:
                os.remove(img)
            except OSError:
                pass
            raise RuntimeError("не удалось создать диск: " + out[-200:])
        event("disk_created", uid, f"{size_mb} МБ")
    if not is_mounted(mnt):
        code, out = await run("mount", "-o", "loop,nodev,nosuid", img, mnt)
        if code != 0 or not is_mounted(mnt):
            raise RuntimeError("не удалось подключить диск: " + out[-200:])
    for sub in ("home", "ws"):
        d = f"{mnt}/{sub}"
        os.makedirs(d, exist_ok=True)
        os.chown(d, 1000, 1000)
    return mnt


async def release_disk(uid: str):
    mnt = mnt_path(uid)
    if not is_mounted(mnt):
        return
    code, out = await run("umount", mnt)
    if code != 0:
        await run("umount", "-l", mnt)
        event("umount_lazy", uid, out[-150:])


def disk_stats(uid: str) -> tuple[int, int]:
    """(занято, размер) в байтах. Для подключённого диска — по файловой системе, для остановленного — по выделенным блокам образа."""
    mnt = mnt_path(uid)
    try:
        if is_mounted(mnt):
            st = os.statvfs(mnt)
            return (st.f_blocks - st.f_bfree) * st.f_frsize, st.f_blocks * st.f_frsize
        st = os.stat(img_path(uid))
        return st.st_blocks * 512, st.st_size
    except OSError:
        return 0, int(limits(uid)["disk_gb"] * 1024 ** 3)


async def container_ip(uid: str) -> str:
    code, out = await docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", cname(uid))
    return out.split()[0] if code == 0 and out.split() else ""


async def http_get(ip: str, path: str, extra: str = "", limit: int = 65536) -> bytes:
    r, w = await asyncio.wait_for(asyncio.open_connection(ip, 4096), 2)
    w.write(f"GET {path} HTTP/1.0\r\nHost: x\r\n{extra}\r\n".encode())
    await w.drain()
    data = await asyncio.wait_for(r.read(limit), 4)
    w.close()
    return data


async def healthy(ip: str) -> bool:
    try:
        data = await http_get(ip, "/global/health", limit=300)
        return b" 200 " in data.split(b"\r\n", 1)[0] + b" "
    except Exception:
        return False


async def is_busy(ip: str) -> bool:
    """Есть ли в контейнере работающие сеансы агента: такую среду не усыпляем, пока агент занят."""
    try:
        body = (await http_get(ip, "/session/status", "x-opencode-directory: %2Fworkspace\r\n")).split(b"\r\n\r\n", 1)[-1]
        return b'"busy"' in body or b'"retry"' in body
    except Exception:
        return False


def running_count() -> int:
    return sum(1 for s in state.values() if s["status"] in ("starting", "running"))


def admit(uid: str) -> str | None:
    """Можно ли запускать среду сейчас? Возвращает причину отказа или None."""
    lim = limits(uid)
    if lim.get("disabled"):
        return "disabled"
    if used_seconds(uid) >= lim["daily_minutes"] * 60:
        return "quota"
    if running_count() >= CFG["max_containers"]:
        return "busy"
    if host_avail_mb() < CFG["min_avail_mb"]:
        return "host"
    return None


# ---------------------------------------------------------------- жизненный цикл среды
async def start_container(uid: str):
    s = state[uid]
    try:
        mnt = await ensure_disk(uid)
        # контейнер создан из старого образа (вышла новая версия среды): удаляем его, данные лежат на диске пользователя
        have, now_img = await docker("inspect", "-f", "{{.Image}}", cname(uid)), await docker("image", "inspect", "-f", "{{.Id}}", CFG["image"])
        if have[0] == 0 and now_img[0] == 0 and have[1].strip() != now_img[1].strip():
            await docker("rm", "-f", cname(uid))
            event("recreate", uid, "новый образ среды")
        code, out = await docker("start", cname(uid))
        if code != 0:   # контейнера ещё нет — создаём
            code, out = await docker(
                "run", "-d", "--name", cname(uid), "--label", "codary.cloud=1", "--label", f"codary.uid={uid}",
                "--network", CFG["network"], "--memory", CFG["memory"], "--memory-swap", CFG["memory"], "--cpus", CFG["cpus"],
                "--pids-limit", CFG["pids"], "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
                "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m",   # exec нужен: сервер распаковывает в /tmp системную библиотеку терминала
                "-v", f"{mnt}/home:/home/coder", "-v", f"{mnt}/ws:/workspace",
                "-e", f"OPENCODE_CONFIG_CONTENT={CONTAINER_CONFIG}", "--restart", "no", CFG["image"], timeout=120,
            )
            if code != 0:
                raise RuntimeError(out[-300:])
        for _ in range(90):
            ip = await container_ip(uid)
            if ip and await healthy(ip):
                s.update(status="running", ip=ip, error="", last_seen=time.time(), starts=s.get("starts", 0) + 1, extra_until=0)
                with db() as c:
                    c.execute("INSERT INTO usage(uid, started) VALUES(?,?)", (uid, time.time()))
                event("start", uid)
                peak["day"] = max(peak["day"], running_count())
                return
            await asyncio.sleep(1)
        raise RuntimeError("сервер в контейнере не ответил за 90 секунд")
    except Exception as e:  # noqa: BLE001
        s.update(status="failed", error=str(e)[:300])
        event("start_failed", uid, str(e))
        await docker("stop", "-t", "5", cname(uid))
        await release_disk(uid)
        await alert(f"fail-{uid}", f"не удалось запустить среду пользователя {uid}: {str(e)[:200]}")


async def stop_container(uid: str, reason: str):
    s = state.get(uid)
    if not s:
        return
    await docker("stop", "-t", "15", cname(uid), timeout=60)
    await release_disk(uid)
    s.update(status="stopped", ip="")
    with db() as c:
        c.execute("UPDATE usage SET stopped=? WHERE uid=? AND stopped IS NULL", (time.time(), uid))
    event("stop", uid, reason)


async def sync_with_docker():
    """Сверка с docker: среда могла упасть или быть остановлена не нами."""
    code, out = await docker("ps", "--filter", "label=codary.cloud=1", "--format", "{{.Label \"codary.uid\"}}")
    alive = set(out.split()) if code == 0 else None
    if alive is None:
        return
    for uid, s in list(state.items()):
        if s["status"] == "running" and uid not in alive:
            s.update(status="stopped", ip="")
            with db() as c:
                c.execute("UPDATE usage SET stopped=? WHERE uid=? AND stopped IS NULL", (time.time(), uid))
            await release_disk(uid)
            event("died", uid)
            await alert(f"died-{uid}", f"среда пользователя {uid} остановилась сама (контейнер не найден среди работающих)")
    with db() as c:   # закрываем «висящие» записи учёта для сред, которых нет
        for (uid,) in c.execute("SELECT DISTINCT uid FROM usage WHERE stopped IS NULL").fetchall():
            if uid not in alive and state.get(uid, {}).get("status") != "starting":
                c.execute("UPDATE usage SET stopped=? WHERE uid=? AND stopped IS NULL", (time.time(), uid))


async def digest():
    since = time.time() - 86400
    with db() as c:
        rows = c.execute("SELECT uid, COUNT(*), SUM(COALESCE(stopped, ?) - MAX(started, ?)) FROM usage WHERE COALESCE(stopped, ?) > ? GROUP BY uid ORDER BY 3 DESC", (time.time(), since, time.time(), since)).fetchall()
        fails = c.execute("SELECT COUNT(*) FROM events WHERE kind='start_failed' AND ts>?", (since,)).fetchone()[0]
    lines = [f"Сводка за сутки: пользователей {len(rows)}, одновременно максимум {peak['day']} из {CFG['max_containers']}, ошибок запуска {fails}."]
    for uid, n, secs in rows[:10]:
        used, total = disk_stats(uid)
        lines.append(f"• {uid}: запусков {n}, работал {int((secs or 0) // 60)} мин, диск {used // 2**20}/{total // 2**20} МБ")
    lines.append(f"Память сервера свободна: {int(host_avail_mb())} МБ.")
    peak["day"] = running_count()
    await alert("digest", "\n".join(lines), cooldown=3600)


async def reaper():
    last_digest_day = -1
    disk_checked = 0.0
    while True:
        await asyncio.sleep(30)
        try:
            now = time.time()
            await sync_with_docker()
            for uid, s in list(state.items()):
                if s["status"] != "running":
                    continue
                busy = None
                if now - s["last_seen"] > CFG["idle_minutes"] * 60:
                    busy = await is_busy(s["ip"])
                    if not busy:
                        await stop_container(uid, "простой")
                        continue
                lim = limits(uid)
                if lim.get("disabled") or used_seconds(uid, now) >= lim["daily_minutes"] * 60:
                    if busy is None:
                        busy = await is_busy(s["ip"])
                    if not s.get("extra_until"):
                        s["extra_until"] = now + CFG["grace_minutes"] * 60 if busy else now
                        await alert(f"quota-{uid}", f"пользователь {uid} исчерпал лимит времени на сегодня", cooldown=43200)
                    if not busy or now >= s["extra_until"]:
                        await stop_container(uid, "лимит времени")
            if now - disk_checked > CFG["disk_check_seconds"]:
                disk_checked = now
                for uid, s in state.items():
                    if s["status"] == "running":
                        used, total = disk_stats(uid)
                        if total and used / total >= CFG["disk_warn"]:
                            await alert(f"disk-{uid}", f"диск пользователя {uid} заполнен на {int(100 * used / total)} % ({used // 2**20} из {total // 2**20} МБ)", cooldown=43200)
            avail = host_avail_mb()
            if avail < CFG["warn_avail_mb"]:
                await alert("host-mem", f"на сервере мало свободной памяти: {int(avail)} МБ, работает сред {running_count()}", cooldown=1800)
            local = time.gmtime(now)
            if local.tm_hour == CFG["digest_hour_utc"] and local.tm_yday != last_digest_day:
                last_digest_day = local.tm_yday
                await digest()
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
            state[uid] = {"status": "running", "ip": await container_ip(uid), "last_seen": time.time(), "error": "", "starts": 0, "extra_until": 0}
        else:
            state[uid] = {"status": "stopped", "ip": "", "last_seen": 0, "error": "", "starts": 0, "extra_until": 0}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not CFG["secret"] or len(CFG["secret"]) < 32:
        raise SystemExit("CC_SECRET (не короче 32 символов) не задан")
    init_db()
    await reconcile()
    task = asyncio.create_task(reaper())
    event("manager_start")
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------- вход и проверка доступа
def session_info(request: Request) -> tuple[str, int] | None:
    sid = request.cookies.get(COOKIE)
    if not sid:
        return None
    hit = sessions_cache.get(sid)
    now = time.time()
    if hit and hit[2] > now:
        return hit[0], hit[1]
    with db() as c:
        row = c.execute("SELECT uid, admin, expires FROM sessions WHERE id=?", (sid,)).fetchone()
    if not row or row[2] < now:
        sessions_cache.pop(sid, None)
        return None
    sessions_cache[sid] = (row[0], row[1], min(row[2], now + 60))
    return row[0], row[1]


def session_uid(request: Request) -> str | None:
    info = session_info(request)
    return info[0] if info else None


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
        c.execute("INSERT INTO sessions(id, uid, created, expires, admin) VALUES(?,?,?,?,?)", (sid, str(p["uid"]), now, now + CFG["session_hours"] * 3600, 1 if p.get("adm") else 0))
    event("login", str(p["uid"]), "admin" if p.get("adm") else "")
    resp = RedirectResponse("/_admin" if p.get("adm") else "/", status_code=302)
    resp.set_cookie(COOKIE, sid, max_age=int(CFG["session_hours"] * 3600), httponly=True, secure=CFG["cookie_secure"], samesite="lax", path="/")
    return resp


@app.get("/auth")
async def auth(request: Request):
    """Вызывается nginx перед каждым запросом: 200 + X-Upstream — пускаем, 401 — на вход, 403 — среда запускается или отказано (причина в X-Reason)."""
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
        why = admit(uid)
        if why:
            if why == "busy":
                await alert("capacity", f"все места заняты ({CFG['max_containers']}), пользователь {uid} ждёт", cooldown=3600)
            return Response(status_code=403, headers={"X-Reason": why})
        state[uid] = {"status": "starting", "ip": "", "last_seen": now, "error": "", "starts": (s or {}).get("starts", 0), "extra_until": 0}
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
        return HTMLResponse(PAGE.format(refresh="", title="Не удалось запустить среду", text="Что-то пошло не так. Обновите страницу, чтобы повторить; если повторяется, напишите нам."), status_code=503)
    if s.get("status") != "starting":
        why = admit(uid)
        if why == "disabled":
            return HTMLResponse(PAGE.format(refresh="", title="Доступ закрыт", text="Доступ к облачной среде для вашей учётной записи отключён. Напишите нам, если это ошибка."), status_code=403)
        if why == "quota":
            lim = limits(uid)
            return HTMLResponse(PAGE.format(refresh="", title="Лимит времени на сегодня исчерпан", text=f"В альфа-версии среда работает до {int(lim['daily_minutes'] // 60)} ч {int(lim['daily_minutes'] % 60)} мин в сутки. Лимит обновится в полночь по Москве; ваши файлы сохранены."), status_code=429)
        if why == "busy":
            return HTMLResponse(PAGE.format(refresh='<meta http-equiv="refresh" content="15">', title="Все места заняты", text="Сейчас работают все доступные среды. Страница обновится сама, как только освободится место."), status_code=503)
        if why == "host":
            return HTMLResponse(PAGE.format(refresh='<meta http-equiv="refresh" content="20">', title="Сервер перегружен", text="Сейчас не хватает памяти для новой среды. Страница обновится сама через несколько секунд."), status_code=503)
    return HTMLResponse(PAGE.format(refresh='<meta http-equiv="refresh" content="3">', title="Запускаем вашу среду…", text="Обычно это занимает несколько секунд. Страница обновится сама."), status_code=200)


# ---------------------------------------------------------------- проекты в рабочей среде
# Сервер OpenCode не умеет создавать папки, а без папки нет проекта. Поэтому окно «Открыть проект» в облаке
# обращается сюда: /_cloud/info (где рабочая папка и проект по умолчанию) и /_cloud/mkdir (создать папку).
# Всё выполняется внутри контейнера пользователя (docker exec от его же uid), а не с правами хоста.
DEFAULT_PROJECT = "my-project"
FOLDER_NAME = re.compile(r"^\w[\w .\-]{0,63}$")
MAX_FOLDERS = 200


def folder_ok(name: str) -> bool:
    return bool(FOLDER_NAME.match(name)) and ".." not in name and not name.endswith((" ", "."))


def cloud_uid(request: Request) -> str | None:
    uid = session_uid(request)
    return uid if uid and state.get(uid, {}).get("status") == "running" else None


def same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    return not origin or origin.split("://", 1)[-1] == request.headers.get("host", "")


async def in_container(uid: str, script: str, *args: str) -> tuple[int, str]:
    return await docker("exec", "-u", "1000:1000", cname(uid), "sh", "-c", script, "_", *args, timeout=20)


@app.get("/_cloud/info")
async def cloud_info(request: Request):
    uid = cloud_uid(request)
    if not uid:
        return JSONResponse({"cloud": False}, status_code=401)
    # проект по умолчанию создаём один раз на пользователя; если его потом удалили, не возвращаем
    code, _ = await in_container(
        uid,
        f'M=/home/coder/.codary-default-project; if [ ! -e "$M" ]; then mkdir -p /workspace/{DEFAULT_PROJECT} && touch "$M"; fi; [ -d /workspace/{DEFAULT_PROJECT} ]',
    )
    return JSONResponse({"cloud": True, "workspace": "/workspace", "project": f"/workspace/{DEFAULT_PROJECT}" if code == 0 else None})


@app.post("/_cloud/mkdir")
async def cloud_mkdir(request: Request):
    uid = cloud_uid(request)
    if not uid:
        return JSONResponse({"error": "auth"}, status_code=401)
    if not same_origin(request):
        return JSONResponse({"error": "origin"}, status_code=403)
    try:
        name = str((await request.json()).get("name", "")).strip()
    except Exception:  # noqa: BLE001
        name = ""
    if not folder_ok(name):
        return JSONResponse({"error": "name"}, status_code=400)
    code, out = await in_container(
        uid,
        f'[ -d "/workspace/$1" ] || [ "$(ls -A /workspace | wc -l)" -lt {MAX_FOLDERS} ] || exit 3; mkdir -p -- "/workspace/$1"',
        name,
    )
    if code == 3:
        return JSONResponse({"error": "limit"}, status_code=409)
    if code != 0:
        event("mkdir_failed", uid, out[-200:])
        return JSONResponse({"error": "mkdir"}, status_code=500)
    return JSONResponse({"path": f"/workspace/{name}"})


# ---------------------------------------------------------------- мониторинг
def local_only(request: Request) -> bool:
    return bool(request.client) and request.client.host in ("127.0.0.1", "::1")


@app.get("/status")
async def status(request: Request):
    if not local_only(request):
        return Response(status_code=404)
    return JSONResponse({"max": CFG["max_containers"], "running": running_count(), "users": {u: {k: v for k, v in s.items()} for u, s in state.items()}})


@app.get("/healthz")
async def healthz(request: Request):
    if not local_only(request):
        return Response(status_code=404)
    return JSONResponse({"ok": True, "running": running_count(), "max": CFG["max_containers"], "host_avail_mb": int(host_avail_mb())})


@app.get("/metrics")
async def metrics(request: Request):
    if not local_only(request):
        return Response(status_code=404)
    out = [f"cc_containers_running {running_count()}", f"cc_containers_max {CFG['max_containers']}", f"cc_host_mem_available_mb {int(host_avail_mb())}"]
    for uid in state:
        used, total = disk_stats(uid)
        out += [f'cc_user_disk_used_bytes{{uid="{uid}"}} {used}', f'cc_user_disk_total_bytes{{uid="{uid}"}} {total}', f'cc_user_minutes_today{{uid="{uid}"}} {used_seconds(uid) / 60:.1f}']
    return PlainTextResponse("\n".join(out) + "\n")


def admin_ok(request: Request) -> tuple[str, str] | None:
    info = session_info(request)
    if not info or not info[1]:
        return None
    sid = request.cookies.get(COOKIE, "")
    return info[0], hmac.new(CFG["secret"].encode(), b"csrf" + sid.encode(), hashlib.sha256).hexdigest()[:24]


def fmt_ts(ts: float | None) -> str:
    return time.strftime("%d.%m %H:%M", time.gmtime((ts or 0) + CFG["tz_hours"] * 3600)) if ts else "—"


@app.get("/_admin")
async def admin(request: Request):
    who = admin_ok(request)
    if not who:
        return Response(status_code=404)
    _, csrf = who
    # память контейнеров одним вызовом
    code, out = await docker("stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}", timeout=20)
    stats = {}
    for line in out.splitlines() if code == 0 else []:
        parts = line.split("|")
        if len(parts) == 3:
            stats[parts[0]] = (parts[1].split("/")[0].strip(), parts[2])
    with db() as c:
        known = {r[0] for r in c.execute("SELECT DISTINCT uid FROM usage").fetchall()}
    uids = sorted(set(state) | known, key=lambda x: (len(x), x))
    rows = []
    now = time.time()
    for uid in uids:
        s = state.get(uid, {"status": "—"})
        lim = limits(uid)
        used, total = disk_stats(uid)
        mem, cpu = stats.get(cname(uid), ("", ""))
        pct = int(100 * used / total) if total else 0
        stop = f'<form method="post" action="/_admin/stop"><input type="hidden" name="csrf" value="{csrf}"><input type="hidden" name="uid" value="{html.escape(uid)}"><button>Остановить</button></form>' if s.get("status") == "running" else ""
        rows.append(f"<tr><td>{html.escape(uid)}</td><td>{html.escape(str(s.get('status')))}</td><td>{html.escape(mem)} {html.escape(cpu)}</td>"
                    f"<td>{used // 2**20} / {total // 2**20} МБ ({pct}%)</td><td>{int(used_seconds(uid, now) // 60)} / {int(lim['daily_minutes'])} мин</td>"
                    f"<td>{s.get('starts', 0)}</td><td>{fmt_ts(s.get('last_seen')) if s.get('last_seen') else '—'}</td><td>{'отключён' if lim.get('disabled') else ''}</td><td>{stop}</td></tr>")
    with db() as c:
        ev = c.execute("SELECT ts, kind, uid, detail FROM events ORDER BY ts DESC LIMIT 40").fetchall()
    evrows = "".join(f"<tr><td>{fmt_ts(t)}</td><td>{html.escape(k)}</td><td>{html.escape(u or '')}</td><td>{html.escape(d or '')}</td></tr>" for t, k, u, d in ev)
    load = os.getloadavg()
    body = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20">
<title>Облако Codary: панель</title><style>body{{font:14px/1.45 system-ui,sans-serif;margin:20px;color:#18283a}}table{{border-collapse:collapse;margin:8px 0 24px;width:100%}}
td,th{{border:1px solid #cfd8e3;padding:5px 8px;text-align:left;vertical-align:top}}th{{background:#eef3f8}}.k{{display:inline-block;margin-right:22px}}h1{{font-size:1.2rem}}h2{{font-size:1rem;margin:18px 0 4px}}button{{cursor:pointer}}</style></head><body>
<h1>Облако Codary Code: панель администратора</h1>
<p><span class="k">Сред работает: <b>{running_count()} из {CFG['max_containers']}</b></span><span class="k">Память сервера свободна: <b>{int(host_avail_mb())} МБ</b></span>
<span class="k">Нагрузка: <b>{load[0]:.2f}</b></span><span class="k">Простой до засыпания: <b>{int(CFG['idle_minutes'])} мин</b></span><span class="k">Время — московское</span></p>
<h2>Пользователи</h2>
<table><tr><th>ID</th><th>Состояние</th><th>Память / CPU</th><th>Диск</th><th>Время сегодня</th><th>Запусков</th><th>Последний запрос</th><th>Доступ</th><th></th></tr>{''.join(rows) or '<tr><td colspan="9">Пока никого нет</td></tr>'}</table>
<h2>Последние события</h2><table><tr><th>Когда</th><th>Событие</th><th>ID</th><th>Подробности</th></tr>{evrows}</table>
<p>Лимиты (диск, минуты в сутки, отключение) задаются в <code>/opt/codary-cloud/limits.json</code> и подхватываются сразу. Страница обновляется каждые 20 секунд.</p></body></html>"""
    return HTMLResponse(body)


@app.post("/_admin/stop")
async def admin_stop(request: Request, uid: str = Form(""), csrf: str = Form("")):
    who = admin_ok(request)
    if not who or not hmac.compare_digest(who[1], csrf):
        return Response(status_code=404)
    if uid in state and state[uid]["status"] == "running":
        await stop_container(uid, f"остановлено администратором {who[0]}")
    return RedirectResponse("/_admin", status_code=303)
