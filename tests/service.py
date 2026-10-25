#!/usr/bin/env python3
"""Режим «только аккаунт Codary» на настоящем сервере OpenCode (из upstream/): модели из шлюза, чужие провайдеры отключены, ключи других провайдеров не принимаются.
Запуск: python3 tests/service.py   (нужны bun и upstream/ с наложенными патчами)"""
import json, os, signal, subprocess, sys, tempfile, time, urllib.parse, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OC = os.path.join(ROOT, 'upstream', 'packages', 'opencode')
T = tempfile.mkdtemp(prefix='codary-service-'); PROJ = os.path.join(T, 'proj'); os.makedirs(PROJ)
PORT, GW = 4098, 18103
procs, failures = [], []

def sh(cmd, **kw):
    p = subprocess.Popen(cmd, start_new_session=True, **kw); procs.append(p); return p

def api(method, path, body=None, port=PORT, timeout=60):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', 'x-opencode-directory': urllib.parse.quote(PROJ)})
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

def providers():
    d = api('GET', '/provider'); return {p['id']: p for p in d['all']}, d

try:
    sh([sys.executable, os.path.join(ROOT, 'tests', 'fake_gateway.py'), str(GW)])
    os.makedirs(T + '/data/opencode'); os.makedirs(T + '/config/opencode')
    json.dump({'codary': {'type': 'api', 'key': 'sk-cdr-test-token'}}, open(T + '/data/opencode/auth.json', 'w'))
    user_cfg = {'provider': {'fake': {'npm': '@ai-sdk/openai-compatible', 'name': 'fake', 'options': {'baseURL': 'http://127.0.0.1:1/v1', 'apiKey': 'x'}, 'models': {'m': {'name': 'm'}}}},
                'model': 'fake/m', 'autoupdate': False, 'share': 'disabled'}
    json.dump(user_cfg, open(T + '/config/opencode/opencode.json', 'w'))        # «свой» провайдер в конфигурации пользователя
    env = {**os.environ, 'XDG_DATA_HOME': T + '/data', 'XDG_CONFIG_HOME': T + '/config', 'XDG_CACHE_HOME': T + '/cache', 'XDG_STATE_HOME': T + '/state',
           'CODARY_RESTRICT_PROVIDERS': '1', 'CODARY_API_URL': f'http://127.0.0.1:{GW}', 'CODARY_APP_VERSION': '1.2.0', 'CODARY_APP_PLATFORM': 'mac',
           'OPENCODE_DISABLE_AUTOUPDATE': '1', 'OPENAI_API_KEY': 'sk-env-openai', 'ANTHROPIC_API_KEY': 'sk-env-anthropic'}      # ключи из окружения тоже не должны работать
    log = open(os.path.join(T, 'server.log'), 'w')
    sh(['bun', 'run', './src/index.ts', 'serve', '--port', str(PORT), '--hostname', '127.0.0.1'], cwd=OC, env=env, stdout=log, stderr=subprocess.STDOUT)
    ok = wait(lambda: api('GET', '/session', timeout=5) is not None, 90)
    check('сервер запустился', ok is not None, open(os.path.join(T, 'server.log')).read()[-600:])
    if ok is None: raise SystemExit(1)

    print('1. Список провайдеров и моделей')
    allp, raw = providers()
    check('в списке только провайдер codary', list(allp) == ['codary'], str(list(allp))[:200])
    check('он подключён', raw['connected'] == ['codary'], str(raw['connected']))
    models = allp.get('codary', {}).get('models', {})
    check('модели взяты из шлюза (картинки не включены)', sorted(models) == ['glm-5.3', 'openrouter/anthropic/claude-sonnet-4.5'], str(sorted(models)))
    claude = models.get('openrouter/anthropic/claude-sonnet-4.5', {})
    check('у модели контекст и понимание картинок из шлюза', claude.get('limit', {}).get('context') == 200000 and claude.get('capabilities', {}).get('input', {}).get('image') is True, str(claude)[:300])
    check('цена в названии модели (вход/выход, ₽ за 1 млн)', models.get('glm-5.3', {}).get('name') == 'GLM 5.3 · 149/469 ₽', str(models.get('glm-5.3', {}).get('name')))
    check('у модели без цены (подписка) в названии цены нет', claude.get('name') == 'Claude Sonnet 4.5', str(claude.get('name')))
    cmds = {c['name']: c for c in api('GET', '/command')}
    check('в меню «/» есть /fix /tests /explain /commit /agents /chisle /remember и встроенные /review /init', all(n in cmds for n in ('fix', 'tests', 'explain', 'commit', 'agents', 'chisle', 'remember', 'review', 'init')), str(sorted(cmds)))
    check('описание команды по-русски', 'тест' in cmds.get('fix', {}).get('description', ''), str(cmds.get('fix')))
    cfg = api('GET', '/config')
    check('модель по умолчанию — первая из списка шлюза (своя fake/m не применена)', cfg.get('model') == 'codary/glm-5.3', str(cfg.get('model')))
    check('enabled_providers = [codary]', cfg.get('enabled_providers') == ['codary'], str(cfg.get('enabled_providers')))

    print('2. Запрос идёт через шлюз с токеном и сведениями об устройстве')
    os.makedirs(PROJ + '/.codary', exist_ok=True); open(PROJ + '/.codary/index.md', 'w').write('- notes/x.md — МАРКЕР-ПАМЯТИ-42\n')
    sid = api('POST', '/session', {'title': 't'})['id']
    r = api('POST', f'/session/{sid}/message', {'model': {'providerID': 'codary', 'modelID': 'glm-5.3'}, 'parts': [{'type': 'text', 'text': 'привет'}]}, timeout=90)
    text = ''.join(p.get('text', '') for p in r.get('parts', []) if p.get('type') == 'text')
    check('ответ модели получен', 'ok-from-codary' in text, text[:200])
    calls = api('GET', '/_calls', port=GW)
    chat = [c for c in calls if c['path'] == '/v1/chat/completions']
    check('шлюз получил токен устройства и имя модели', bool(chat) and chat[-1]['auth'] == 'Bearer sk-cdr-test-token' and chat[-1]['model'] == 'glm-5.3', str(chat)[-300:])
    check('индекс памяти проекта .codary/index.md и правила ведения папки доходят до модели', bool(chat) and 'МАРКЕР-ПАМЯТИ-42' in chat[-1].get('system', '') and 'Память проекта (.codary/)' in chat[-1].get('system', ''), chat[-1].get('system', '')[-200:] if chat else '')
    check('правила chisle (краткий режим) доходят до модели в системной подсказке', bool(chat) and 'Chisle: максимум смысла' in chat[-1].get('system', ''), chat[-1].get('system', '')[:120] if chat else '')
    listing = [c for c in calls if c['path'] == '/v1/models']
    check('запрос списка моделей сообщил платформу и версию', bool(listing) and listing[0]['platform'] == 'mac' and listing[0]['version'] == '1.2.0', str(listing)[:200])

    flag = os.path.join(T, 'data', 'opencode', 'codary', 'chisle-off')
    os.makedirs(os.path.dirname(flag), exist_ok=True); open(flag, 'w').write('off\n')
    sid2 = api('POST', '/session', {'title': 't2'})['id']
    api('POST', f'/session/{sid2}/message', {'model': {'providerID': 'codary', 'modelID': 'glm-5.3'}, 'parts': [{'type': 'text', 'text': 'ещё'}]}, timeout=90)
    chat2 = [c for c in api('GET', '/_calls', port=GW) if c['path'] == '/v1/chat/completions']
    check('флаг chisle-off отключает правила (в следующем запросе их нет)', len(chat2) > len(chat) and 'Chisle: максимум смысла' not in chat2[-1].get('system', ''), chat2[-1].get('system', '')[:100])
    os.remove(flag)

    print('3. Чужие ключи не принимаются')
    r = api('PUT', '/auth/openai', {'type': 'api', 'key': 'sk-user-key'})
    auth = json.load(open(T + '/data/opencode/auth.json'))
    check('PUT /auth/openai отклонён и в auth.json не записан', r is False and 'openai' not in auth, str(r) + str(list(auth)))
    check('ключи из окружения (OPENAI_API_KEY, ANTHROPIC_API_KEY) не подключают провайдеров', list(providers()[0]) == ['codary'])
    check('PUT /auth/codary принят', api('PUT', '/auth/codary', {'type': 'api', 'key': 'sk-cdr-test-token'}) is True)

    print('4. Новая модель в админке появляется после перезагрузки конфигурации')
    api('POST', '/_models', [{'id': 'glm-5.3', 'name': 'GLM 5.3'}, {'id': 'deepseek/deepseek-chat', 'name': 'DeepSeek'}], port=GW)
    time.sleep(61)          # список у плагина кэшируется на минуту
    api('POST', '/global/dispose')
    got = wait(lambda: 'deepseek/deepseek-chat' in providers()[0].get('codary', {}).get('models', {}), 30)
    check('после перезагрузки конфигурации новая модель в списке', bool(got), str(sorted(providers()[0].get('codary', {}).get('models', {}))))

    print('5. Без токена моделей нет')
    api('DELETE', '/auth/codary'); api('POST', '/global/dispose')
    empty = wait(lambda: not providers()[0].get('codary', {}).get('models'), 30)
    check('после выхода моделей нет (провайдер без токена пуст)', bool(empty), str(providers()[0].get('codary', {}).get('models')))
finally:
    for p in procs:
        try: os.killpg(p.pid, signal.SIGTERM)
        except Exception: pass
print('Папка теста:', T)
print('ИТОГ:', 'всё прошло' if not failures else f'провалов: {len(failures)}')
sys.exit(1 if failures else 0)
