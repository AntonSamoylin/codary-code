#!/usr/bin/env python3
"""Проверка плагина Codary внутри СОБРАННОГО приложения (Mac): запускает приложение с изолированными папками настроек,
заглушками модели и Telegram и смотрит, что планировщик и бот работают. Использование: python3 tests/app_smoke.py "<путь к .app>" """
import json, os, subprocess, sys, tempfile, time, urllib.request, signal

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
APP = sys.argv[1]
T = tempfile.mkdtemp(prefix='codary-app-')
LLM, TG = 18101, 18102
procs = []

def sh(cmd):
    p = subprocess.Popen(cmd, start_new_session=True); procs.append(p); return p

def tg(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{TG}{path}', method='POST' if body is not None else 'GET', data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())

def wait(fn, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v: return v
        except Exception: pass
        time.sleep(1)

sh([sys.executable, os.path.join(ROOT, 'tests', 'fake_llm.py'), str(LLM)])
sh([sys.executable, os.path.join(ROOT, 'tests', 'fake_telegram.py'), str(TG)])
os.makedirs(f'{T}/config/opencode'); os.makedirs(f'{T}/data/opencode/codary'); proj = f'{T}/proj'; os.makedirs(proj)
json.dump({'$schema': 'https://opencode.ai/config.json', 'model': 'fake/m', 'small_model': 'fake/m',
           'provider': {'fake': {'npm': '@ai-sdk/openai-compatible', 'name': 'Заглушка', 'options': {'baseURL': f'http://127.0.0.1:{LLM}/v1', 'apiKey': 'x'},
                                 'models': {'m': {'name': 'm', 'tool_call': True, 'limit': {'context': 100000, 'output': 4000}}}}}}, open(f'{T}/config/opencode/opencode.json', 'w'))
now = int(time.time() * 1000)
json.dump([{'id': 's_smoke', 'name': 'Дымовая', 'prompt': 'расскажи про проект', 'directory': proj, 'everyMinutes': 60, 'mode': 'readonly', 'enabled': True, 'notify': True, 'createdAt': now, 'nextRun': now - 5000}],
          open(f'{T}/data/opencode/codary/schedules.json', 'w'))
envs = {'XDG_DATA_HOME': f'{T}/data', 'XDG_CONFIG_HOME': f'{T}/config', 'XDG_CACHE_HOME': f'{T}/cache', 'XDG_STATE_HOME': f'{T}/state',
        'CODARY_TELEGRAM_API': f'http://127.0.0.1:{TG}', 'CODARY_TELEGRAM_TOKEN': 'TESTTOKEN', 'CODARY_TELEGRAM_ALLOWED': '111', 'CODARY_DEBUG': '1'}
subprocess.check_call(['open', '-n'] + [x for k, v in envs.items() for x in ('--env', f'{k}={v}')] + [APP])
print('Приложение запущено, папка теста:', T)
ok = True
def check(name, cond):
    global ok; ok &= bool(cond); print(('  ✓ ' if cond else '  ✗ ') + name)
calls = wait(lambda: [c for c in tg('/_calls') if c['method'] in ('getMe', 'deleteWebhook')], 120)
check('бот подключился к Telegram (getMe)', bool(calls))
sched = wait(lambda: (json.load(open(f'{T}/data/opencode/codary/schedules.json'))[0].get('last')), 120)
check('задача по расписанию выполнилась в приложении', bool(sched) and sched['status'] == 'ok' and 'ok-from-fake' in sched['summary'])
n = wait(lambda: [c for c in tg('/_calls') if c['method'] == 'sendMessage' and '✅ Задача «Дымовая»' in c['body'].get('text', '')], 30)
check('итог задачи пришёл в Telegram', bool(n))
tg('/_push', {'update_id': 1, 'message': {'message_id': 1, 'from': {'id': 111}, 'chat': {'id': 111, 'type': 'private'}, 'text': 'привет из теста'}})
r = wait(lambda: [c for c in tg('/_calls') if 'ok-from-fake: привет из теста' in c['body'].get('text', '')], 60)
check('сообщение из Telegram дошло до агента в приложении и ответ вернулся', bool(r))
print('Папка теста:', T)
print('ИТОГ:', 'всё прошло' if ok else 'есть провалы')
for p in procs:
    try: os.killpg(p.pid, signal.SIGTERM)
    except Exception: pass
sys.exit(0 if ok else 1)
