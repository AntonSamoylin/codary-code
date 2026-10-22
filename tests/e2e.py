#!/usr/bin/env python3
"""Сквозная проверка плагина Codary на настоящем сервере OpenCode (из upstream/) с заглушками модели и Telegram.
Запуск: python3 tests/e2e.py   (нужны bun и собранный upstream/ с наложенными патчами)"""
import json, os, shutil, signal, subprocess, sys, tempfile, time, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OC = os.path.join(ROOT, 'upstream', 'packages', 'opencode')
T = tempfile.mkdtemp(prefix='codary-e2e-')
PROJ = os.path.join(T, 'proj'); os.makedirs(PROJ)
PORT, LLM, TG = 4097, 18101, 18102
SCHED = os.path.join(T, 'data', 'opencode', 'codary', 'schedules.json')
procs, failures = [], []

def sh(cmd, **kw):
    p = subprocess.Popen(cmd, start_new_session=True, **kw); procs.append(p); return p

def api(method, path, body=None, port=PORT, directory=PROJ, timeout=120):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', 'x-opencode-directory': urllib.parse.quote(directory)})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(); return json.loads(raw) if raw else None

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond: failures.append(name)

def wait(fn, timeout=60, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v: return v
        except Exception: pass
        time.sleep(step)
    return None

def say(sid, text):
    r = api('POST', f'/session/{sid}/message', {'parts': [{'type': 'text', 'text': text}]})
    return ''.join(p.get('text', '') for p in r.get('parts', []) if p.get('type') == 'text')

def tg_calls(method=None):
    c = api('GET', '/_calls', port=TG)
    return [x for x in c if not method or x['method'] == method]

def schedules():
    return json.load(open(SCHED)) if os.path.exists(SCHED) else []

def push(update_id, **kw):
    api('POST', '/_push', {'update_id': update_id, **kw}, port=TG)

def msg(uid, text):
    return {'message': {'message_id': 1, 'from': {'id': uid}, 'chat': {'id': uid, 'type': 'private'}, 'text': text}}

try:
    sh([sys.executable, os.path.join(ROOT, 'tests', 'fake_llm.py'), str(LLM)])
    sh([sys.executable, os.path.join(ROOT, 'tests', 'fake_telegram.py'), str(TG)])
    cfg = {'provider': {'fake': {'npm': '@ai-sdk/openai-compatible', 'name': 'fake', 'options': {'baseURL': f'http://127.0.0.1:{LLM}/v1', 'apiKey': 'x'},
                                 'models': {'m': {'name': 'm', 'tool_call': True, 'limit': {'context': 100000, 'output': 4000}}}}},
           'model': 'fake/m', 'small_model': 'fake/m', 'autoupdate': False, 'share': 'disabled',
           'permission': {'schedule_create': 'allow', 'schedule_run': 'allow', 'bash': 'ask'}}
    env = {**os.environ, 'XDG_DATA_HOME': T + '/data', 'XDG_CONFIG_HOME': T + '/config', 'XDG_CACHE_HOME': T + '/cache', 'XDG_STATE_HOME': T + '/state',
           'OPENCODE_CONFIG_CONTENT': json.dumps(cfg), 'CODARY_TELEGRAM_API': f'http://127.0.0.1:{TG}', 'CODARY_TELEGRAM_TOKEN': 'TESTTOKEN',
           'CODARY_TELEGRAM_ALLOWED': '111', 'CODARY_DEBUG': '1', 'OPENCODE_DISABLE_AUTOUPDATE': '1'}
    log = open(os.path.join(T, 'server.log'), 'w')
    sh(['bun', 'run', './src/index.ts', 'serve', '--port', str(PORT), '--hostname', '127.0.0.1'], cwd=OC, env=env, stdout=log, stderr=subprocess.STDOUT)
    print('Ожидаю сервер…')
    ok = wait(lambda: api('GET', '/session', timeout=5) is not None, 90)
    check('сервер запустился', ok is not None, open(os.path.join(T, 'server.log')).read()[-600:])
    if ok is None: raise SystemExit(1)

    print('1. Инструменты расписания доступны агенту')
    sid = api('POST', '/session', {'title': 't'})['id']
    out = say(sid, 'TOOL:schedule_list {}')
    check('schedule_list вернул пустой список', 'Задач по расписанию нет' in out, out[:200])

    print('2. Создание задачи (с подтверждением из конфигурации)')
    out = say(sid, 'TOOL:schedule_create ' + json.dumps({'name': 'Проверка', 'prompt': 'расскажи про проект', 'every_minutes': 5, 'notify': True}))
    check('задача создана', 'Задача создана' in out, out[:300])
    s = schedules()
    check('в файле одна задача в режиме readonly', len(s) == 1 and s[0]['mode'] == 'readonly' and s[0]['nextRun'] > time.time() * 1000, str(s)[:200])
    bad = say(sid, 'TOOL:schedule_create ' + json.dumps({'name': 'x', 'prompt': 'y', 'every_minutes': 1}))
    check('интервал меньше 5 минут отклонён', 'Минимальный интервал' in bad, bad[:200])

    print('3. Запуск по расписанию + уведомление в Telegram')
    s[0]['nextRun'] = int(time.time() * 1000) - 1000; json.dump(s, open(SCHED, 'w'))
    done = wait(lambda: (schedules()[0].get('last') or None), 60)
    check('задача выполнилась', bool(done) and done['status'] == 'ok', str(done))
    check('итог содержит ответ модели', bool(done) and 'ok-from-fake' in done['summary'], str(done))
    titles = [x.get('title', '') for x in api('GET', '/session')]
    check('создан отдельный сеанс «⏰ Проверка»', any(t.startswith('⏰ Проверка') for t in titles), str(titles))
    sent = wait(lambda: [c for c in tg_calls('sendMessage') if '✅ Задача «Проверка»' in c['body'].get('text', '')], 15)
    check('итог пришёл в Telegram разрешённому пользователю', bool(sent) and sent[0]['body']['chat_id'] == 111)
    nxt = schedules()[0]['nextRun']
    check('следующий запуск назначен в будущем', nxt > time.time() * 1000, str(nxt))

    print('4. Автоматический режим подтверждает разрешения')
    out = say(sid, 'TOOL:schedule_create ' + json.dumps({'name': 'Команда', 'prompt': 'TOOL:bash {"command":"echo codary-auto","description":"t"}', 'every_minutes': 60, 'mode': 'auto', 'notify': False}))
    s = schedules(); t2 = [x for x in s if x['name'] == 'Команда'][0]; t2['nextRun'] = int(time.time() * 1000) - 1000; json.dump(s, open(SCHED, 'w'))
    done = wait(lambda: ([x for x in schedules() if x['name'] == 'Команда'][0].get('last')), 60)
    check('задача с командой выполнилась без вопросов', bool(done) and done['status'] == 'ok' and 'codary-auto' in done['summary'], str(done))

    print('5. Telegram: доступ и обычный диалог')
    push(1, **msg(222, 'привет'))
    deny = wait(lambda: [c for c in tg_calls('sendMessage') if c['body'].get('chat_id') == 222], 15)
    check('чужому пользователю — отказ с его ID', bool(deny) and 'Ваш Telegram ID: 222' in deny[0]['body']['text'])
    check('агент чужому не отвечал', not any('ok-from-fake' in c['body'].get('text', '') for c in tg_calls('sendMessage') if c['body'].get('chat_id') == 222))
    push(2, **msg(111, '/id'))
    r = wait(lambda: [c for c in tg_calls('sendMessage') if 'Доступ открыт' in c['body'].get('text', '')], 15)
    check('/id у разрешённого пользователя', bool(r))
    push(3, **msg(111, 'привет'))
    r = wait(lambda: [c for c in tg_calls('sendMessage') if 'ok-from-fake: привет' in c['body'].get('text', '')], 60)
    check('обычное сообщение дошло до агента и ответ вернулся', bool(r))

    print('6. Telegram: запрос разрешения кнопками')
    push(4, **msg(111, 'TOOL:bash {"command":"echo codary-tg","description":"t"}'))
    kb = wait(lambda: [c for c in tg_calls('sendMessage') if c['body'].get('reply_markup')], 60)
    check('пришёл запрос разрешения с кнопками', bool(kb))
    if kb:
        data = kb[0]['body']['reply_markup']['inline_keyboard'][0][0]['callback_data']
        push(5, callback_query={'id': 'cb1', 'from': {'id': 111}, 'data': data})
        fin = wait(lambda: [c for c in tg_calls('sendMessage') if 'codary-tg' in c['body'].get('text', '') and 'tool-result' in c['body'].get('text', '')], 60)
        check('после «Разрешить» команда выполнилась и итог пришёл', bool(fin))
        check('сообщение с кнопками обновлено', bool(tg_calls('editMessageText')))

    print('7. Удаление и пауза')
    ids = [x['id'] for x in schedules()]
    out = say(sid, 'TOOL:schedule_toggle ' + json.dumps({'id': ids[0], 'enabled': False}))
    check('пауза включена', 'на паузу' in out, out[:200])
    out = say(sid, 'TOOL:schedule_delete ' + json.dumps({'id': ids[0]}))
    check('задача удалена', 'удалена' in out and len(schedules()) == 1, out[:200])
finally:
    for p in procs:
        try: os.killpg(p.pid, signal.SIGTERM)
        except Exception: pass
    print(f'\nЖурнал сервера: {T}/server.log')
    if not failures: shutil.rmtree(T, ignore_errors=True)
    print('ИТОГ:', 'всё прошло' if not failures else f'провалено: {failures}')
    sys.exit(1 if failures else 0)
