#!/usr/bin/env python3
"""Проверка облачных сред на сервере (запускать на нём: python3 smoke.py https://домен). Создаёт тестовых пользователей 9001–9004.
Проверяет: защиту входа, лимит сред, изоляцию, WebSocket терминала, замеры памяти."""
import http.client, http.cookiejar, json, os, re, subprocess, sys, time, urllib.parse, urllib.request, base64, hashlib, hmac, secrets, ssl

BASE = sys.argv[1].rstrip('/'); HOST = urllib.parse.urlparse(BASE).netloc
env = dict(l.split('=', 1) for l in open('/opt/codary-cloud/env').read().split('\n') if '=' in l)
SECRET = env['CC_SECRET']; fails = []

def token(uid, ttl=120, secret=SECRET, nonce=None):
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
    body = b(json.dumps({'uid': str(uid), 'exp': int(time.time()) + ttl, 'n': nonce or secrets.token_hex(6)}, separators=(',', ':')).encode())
    return body + '.' + b(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None

def opener(jar=None):
    return urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar or http.cookiejar.CookieJar()))

def get(op, path, headers=None):
    try:
        r = op.open(urllib.request.Request(BASE + path, headers=headers or {}), timeout=30); return r.status, r.read().decode(errors='replace'), r.headers
    except urllib.error.HTTPError as e: return e.code, e.read().decode(errors='replace'), e.headers

def check(name, ok, extra=''):
    print(('  ✓ ' if ok else '  ✗ ') + name + (f'  [{extra}]' if extra and not ok else '')); 
    if not ok: fails.append(name)

def login(uid):
    jar = http.cookiejar.CookieJar(); op = opener(jar)
    code, _, h = get(op, '/enter?t=' + token(uid)); return op, jar, code, h

def docker(*a): return subprocess.run(['docker', *a], capture_output=True, text=True).stdout.strip()

print('1. Защита входа')
code, _, _ = get(opener(), '/enter?t=abc'); check('мусорный токен отклонён', code == 403, code)
code, _, _ = get(opener(), '/enter?t=' + token(9001, secret='x' * 40)); check('токен с чужой подписью отклонён', code == 403, code)
code, _, _ = get(opener(), '/enter?t=' + token(9001, ttl=-10)); check('просроченный токен отклонён', code == 403, code)
code, _, _ = get(opener(), '/enter?t=' + token(9001, ttl=100000)); check('токен со слишком долгим сроком отклонён', code == 403, code)
t = token(9001); op = opener(); c1, _, _ = get(op, '/enter?t=' + t); c2, _, _ = get(opener(), '/enter?t=' + t)
check('токен работает один раз', c1 == 302 and c2 == 403, f'{c1}/{c2}')
code, _, h = get(opener(), '/'); check('без входа — перенаправление на сайт', code == 302 and 'codary.ru' in (h.get('Location') or ''), f'{code} {h.get("Location")}')
code, _, _ = get(opener(), '/session', {'Cookie': 'cc_session=forged-cookie-value'}); check('поддельный cookie не пускает', code in (302, 401), code)

print('2. Запуск сред и лимит (максимум 3)')
users = {}
for uid in (9001, 9002, 9003, 9004):
    op, jar, code, h = login(uid); users[uid] = op; check(f'вход пользователя {uid}', code == 302, code)
for uid in (9001, 9002, 9003): get(users[uid], '/')   # запускает среду
ready = {}
end = time.time() + 120
while time.time() < end and len(ready) < 3:
    for uid in (9001, 9002, 9003):
        code, body, _ = get(users[uid], '/')
        if code == 200 and uid not in ready and '<title>Codary' in body: ready[uid] = True
    time.sleep(2)
check('три среды запустились и отдают интерфейс', len(ready) == 3, str(ready))
code, body, _ = get(users[9004], '/'); code2, body2, _ = get(users[9004], '/wait')
check('четвёртому пользователю — «места заняты»', code == 403 and code2 == 503 and 'Все места заняты' in body2, f'{code}/{code2}')

print('3. Память и лимиты (три среды)')
print('   ', docker('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} CPU {{.CPUPerc}}', *[f'cc-u{u}' for u in (9001, 9002, 9003)]).replace('\n', '\n    '))
print('   ', subprocess.run(['free', '-m'], capture_output=True, text=True).stdout.split('\n')[1])

print('4. Изоляция пользователей друг от друга')
ip3 = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'cc-u9003')
out = subprocess.run(['docker', 'exec', 'cc-u9002', 'sh', '-c', f'curl -s -m 4 -o /dev/null -w "%{{http_code}}" http://{ip3}:4096/global/health || echo недоступно'], capture_output=True, text=True).stdout
check('контейнер одного пользователя не видит контейнер другого', out.strip() in ('000недоступно', 'недоступно', '000'), out)
home2 = docker('exec', 'cc-u9002', 'sh', '-c', 'ls /workspace /home/coder 2>&1 | head -3 >/dev/null; touch /workspace/mark-2 && echo ok')
mark3 = docker('exec', 'cc-u9003', 'sh', '-c', 'ls /workspace/mark-2 2>&1 | head -1')
check('файлы пользователя 2 недоступны пользователю 3', 'No such file' in mark3, mark3)

print('5. WebSocket (терминал) через nginx')
op = users[9001]
req = urllib.request.Request(BASE + '/pty', data=json.dumps({'command': '/bin/bash'}).encode(), headers={'content-type': 'application/json', 'x-opencode-directory': urllib.parse.quote('/workspace')}, method='POST')
try:
    pty = json.loads(op.open(req, timeout=30).read()); pid = pty['id']
    cookie = '; '.join(f'{c.name}={c.value}' for c in [c for c in op.handlers[-1].cookiejar])
    ctx = ssl.create_default_context(); conn = http.client.HTTPSConnection(HOST, context=ctx, timeout=15)
    conn.request('GET', f'/pty/{pid}/connect', headers={'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': base64.b64encode(os.urandom(16)).decode(), 'Cookie': cookie, 'x-opencode-directory': urllib.parse.quote('/workspace')})
    r = conn.getresponse(); check('WebSocket терминала: 101 Switching Protocols', r.status == 101, r.status)
except Exception as e: check('WebSocket терминала', False, repr(e)[:200])
print('ИТОГ:', 'всё прошло' if not fails else f'провалено: {fails}')
sys.exit(1 if fails else 0)
