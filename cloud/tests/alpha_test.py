#!/usr/bin/env python3
"""Проверка возможностей закрытой альфы на сервере: жёсткий предел диска, лимит времени, учёт, панель администратора,
оповещения и сводка. Использовать на сервере без живых пользователей: python3 alpha_test.py https://домен
Временно подставляет в менеджер свои настройки (env-файл, по окончании возвращает) и приёмник оповещений, по окончании всё возвращает."""
import base64, hashlib, hmac, http.cookiejar, json, os, secrets, subprocess, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = sys.argv[1].rstrip('/')
env = dict(l.split('=', 1) for l in open('/opt/codary-cloud/env').read().split('\n') if '=' in l)
SECRET = env['CC_SECRET']
ENV_FILE = '/opt/codary-cloud/env'
ORIG_ENV = open(ENV_FILE).read()
LIMITS = '/opt/codary-cloud/limits.json'
fails, alerts = [], []

def check(name, ok, extra=''):
    print(('  ✓ ' if ok else '  ✗ ') + name + (f'  [{extra}]' if extra and not ok else ''))
    if not ok: fails.append(name)

def token(uid, adm=False):
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
    body = b(json.dumps({'uid': str(uid), 'exp': int(time.time()) + 120, 'n': secrets.token_hex(6), **({'adm': 1} if adm else {})}, separators=(',', ':')).encode())
    return body + '.' + b(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest())

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

def login(uid, adm=False):
    jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar))
    r = get(op, '/enter?t=' + token(uid, adm)); return op, jar, r

def get(op, path):
    try:
        r = op.open(urllib.request.Request(BASE + path), timeout=30); return r.status, r.read().decode(errors='replace'), r.headers
    except urllib.error.HTTPError as e: return e.code, e.read().decode(errors='replace'), e.headers

def sh(cmd): return subprocess.run(cmd, shell=True, capture_output=True, text=True)

class Recv(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        alerts.append({'secret': self.headers.get('x-cloud-secret'), 'text': body.get('text', '')}); self.send_response(200); self.end_headers(); self.wfile.write(b'ok')

def alert_with(substr, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        if any(substr in a['text'] for a in alerts): return True
        time.sleep(1)
    return False

def set_manager_env(lines):
    """Подставляет настройки в env-файл менеджера (он важнее Environment= в юните) и перезапускает его."""
    keys = {l.split('=', 1)[0] for l in lines}
    kept = [l for l in ORIG_ENV.split('\n') if l and l.split('=', 1)[0] not in keys]
    open(ENV_FILE, 'w').write('\n'.join(kept + list(lines)) + '\n')
    sh('systemctl restart codary-cloud-manager; sleep 2')

def wait_ready(op, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        code, body, _ = get(op, '/global/health')
        if 'healthy' in body: return True
        time.sleep(1)
    return False

orig_limits = open(LIMITS).read() if os.path.exists(LIMITS) else None
srv = HTTPServer(('127.0.0.1', 18200), Recv); threading.Thread(target=srv.serve_forever, daemon=True).start()
try:
    sh('docker ps -aq --filter label=codary.cloud=1 | xargs -r docker rm -f; for m in /var/lib/codary-cloud/mnt/u91*; do umount -l "$m"; done; rm -f /var/lib/codary-cloud/img/u91*.img')
    json.dump({'default': {'disk_gb': 5, 'daily_minutes': 480}, 'users': {'9101': {'disk_gb': 1, 'daily_minutes': 1}, '9103': {'disabled': True}}}, open(LIMITS, 'w'))
    now_h = time.gmtime().tm_hour
    set_manager_env([f'CC_ALERT_URL=http://127.0.0.1:18200/a', f'CC_ALERT_SECRET={env["CC_ALERT_SECRET"]}', 'CC_DISK_CHECK_SECONDS=15', f'CC_DIGEST_HOUR_UTC={now_h}', 'CC_WARN_AVAIL_MB=1'])

    print('1. Жёсткий предел диска')
    op, jar, (code, _, _) = login(9101); check('вход 9101', code == 302, code)
    get(op, '/'); check('среда с диском 1 ГБ запустилась', wait_ready(op))
    size = sh("docker exec cc-u9101 sh -c \"df -m /workspace | tail -1 | awk '{print \\$2}'\"").stdout.strip()
    check('размер диска среды около 1 ГБ', size.isdigit() and 900 <= int(size) <= 1024, size)
    host_free_before = int(sh("df -m --output=avail / | tail -1").stdout.strip())
    out = sh("docker exec cc-u9101 sh -c 'dd if=/dev/zero of=/workspace/big bs=1M count=1500 2>&1'").stdout
    check('запись сверх предела отклонена («нет места»)', 'No space left' in out, out[-150:])
    host_free_after = int(sh("df -m --output=avail / | tail -1").stdout.strip())
    check('диск сервера не пострадал (минус не больше 1,3 ГБ)', host_free_before - host_free_after < 1300, f'{host_free_before}->{host_free_after}')
    check('оповещение о заполнении диска ушло администратору', alert_with('диск пользователя 9101 заполнен', 60))

    print('2. Лимит времени (1 минута для 9101)')
    check('оповещение о лимите времени', alert_with('исчерпал лимит времени', 120))
    end = time.time() + 120
    while time.time() < end and sh('docker ps -q --filter name=cc-u9101').stdout.strip(): time.sleep(3)
    check('среда остановлена по лимиту', not sh('docker ps -q --filter name=cc-u9101').stdout.strip())
    check('диск отключён после остановки', not os.path.ismount('/var/lib/codary-cloud/mnt/u9101'))
    code, body, _ = get(op, '/'); code2, body2, _ = get(op, '/wait')
    check('повторный вход — страница про лимит времени', code2 == 429 and 'Лимит времени' in body2, f'{code}/{code2}')
    sh('sleep 1')

    print('3. Отключённый пользователь и перегруженный сервер')
    op3, _, _ = login(9103); get(op3, '/'); code, body, _ = get(op3, '/wait')
    check('отключённому — «Доступ закрыт»', code == 403 and 'Доступ закрыт' in body, code)
    set_manager_env([f'CC_ALERT_URL=http://127.0.0.1:18200/a', f'CC_ALERT_SECRET={env["CC_ALERT_SECRET"]}', 'CC_MIN_AVAIL_MB=999999', 'CC_WARN_AVAIL_MB=999999'])
    op2, _, _ = login(9102); get(op2, '/'); code, body, _ = get(op2, '/wait')
    check('при нехватке памяти новая среда не стартует', code == 503 and 'перегружен' in body, code)
    check('оповещение о нехватке памяти', alert_with('мало свободной памяти', 70))

    print('4. Панель администратора и учёт')
    set_manager_env([f'CC_ALERT_URL=http://127.0.0.1:18200/a', f'CC_ALERT_SECRET={env["CC_ALERT_SECRET"]}'])
    opa, _, (code, _, h) = login(3, adm=True); check('вход администратора ведёт в панель', code == 302 and (h.get('Location') or '').endswith('/_admin'), h.get('Location'))
    code, body, _ = get(opa, '/_admin'); check('панель открывается', code == 200 and 'панель администратора' in body, code)
    check('в панели есть пользователь 9101 с использованным временем', '9101' in body and 'мин' in body)
    opu, _, _ = login(9105); code, _, _ = get(opu, '/_admin'); check('обычному пользователю панель недоступна (404)', code == 404, code)
    code, _, _ = get(urllib.request.build_opener(NoRedirect), '/_admin'); check('без входа панель недоступна', code in (404, 302), code)
    r = sh('curl -s http://127.0.0.1:8200/metrics'); check('метрики Prometheus отдаются локально', 'cc_containers_running' in r.stdout and 'cc_user_minutes_today{uid="9101"}' in r.stdout, r.stdout[:120])
    r = sh('curl -s http://127.0.0.1:8200/healthz'); check('healthz отвечает', '"ok":true' in r.stdout.replace(' ', ''), r.stdout)
    set_manager_env([f'CC_ALERT_URL=http://127.0.0.1:18200/a', f'CC_ALERT_SECRET={env["CC_ALERT_SECRET"]}', f'CC_DIGEST_HOUR_UTC={time.gmtime().tm_hour}'])
    check('суточная сводка отправляется', alert_with('Сводка за сутки', 70))
    check('секрет оповещений передаётся заголовком', all(a['secret'] == env['CC_ALERT_SECRET'] for a in alerts) and alerts, str(alerts[:1]))
finally:
    open(ENV_FILE, 'w').write(ORIG_ENV)
    if orig_limits is not None: open(LIMITS, 'w').write(orig_limits)
    sh('docker ps -aq --filter label=codary.cloud=1 | xargs -r docker rm -f; for m in /var/lib/codary-cloud/mnt/u91*; do umount -l "$m"; done; rm -f /var/lib/codary-cloud/img/u91*.img; systemctl restart codary-cloud-manager')
    srv.shutdown()
    print('\nИТОГ:', 'всё прошло' if not fails else f'провалено: {fails}')
    sys.exit(1 if fails else 0)
