#!/usr/bin/env python3
"""Заглушка шлюза Codary для проверки приложения: /v1/models (по токену), /v1/chat/completions (поток), /_calls и /_models для теста."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = 'sk-cdr-test-token'
state = {'calls': [], 'models': [
    {'id': 'glm-5.3', 'object': 'model', 'owned_by': 'zai', 'name': 'GLM 5.3', 'vision': False, 'context_length': 128000, 'max_output': 16384, 'pricing': {'prompt': 149.18, 'completion': 468.86}},
    {'id': 'openrouter/anthropic/claude-sonnet-4.5', 'object': 'model', 'owned_by': 'openrouter', 'name': 'Claude Sonnet 4.5', 'vision': True, 'pricing': {'prompt': 0, 'completion': 0}, 'context_length': 200000, 'max_output': 16000},
    {'id': 'glm-image', 'object': 'model', 'owned_by': 'zai', 'type': 'image'}]}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        raw = json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def authed(self): return self.headers.get('authorization', '') == 'Bearer ' + TOKEN
    def do_GET(self):
        if self.path == '/_calls': return self.send(200, state['calls'])
        if self.path == '/v1/models':
            state['calls'].append({'path': '/v1/models', 'auth': self.headers.get('authorization'), 'platform': self.headers.get('x-codary-platform'), 'version': self.headers.get('x-codary-version')})
            if not self.authed(): return self.send(401, {'error': {'message': 'Неверный токен'}})
            return self.send(200, {'object': 'list', 'data': state['models']})
        self.send(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        if self.path == '/_models': state['models'] = body; return self.send(200, {})
        if self.path == '/_error': state['error'] = body or None; return self.send(200, {})      # {"status": 424, "code": "x"} — отвечать ошибкой; {} — снять
        if self.path == '/v1/chat/completions':
            state['calls'].append({'path': self.path, 'auth': self.headers.get('authorization'), 'tools': [(t.get('function', {}).get('name'), len(json.dumps(t, ensure_ascii=False))) for t in (body.get('tools') or [])], 'msg_chars': sum(len(json.dumps(m.get('content'), ensure_ascii=False)) for m in body.get('messages', []) if m.get('role') != 'system'), 'model': body.get('model'), 'system': ' '.join(m.get('content') if isinstance(m.get('content'), str) else '' for m in body.get('messages', []) if m.get('role') == 'system'), 'platform': self.headers.get('x-codary-platform')})
            if not self.authed(): return self.send(401, {'error': {'message': 'Неверный токен'}})
            if state.get('error'): return self.send(state['error']['status'], {'error': {'message': 'Тестовая ошибка шлюза', 'code': state['error'].get('code', 'x'), 'type': 'api_error'}})
            self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
            base = {'id': 'c1', 'object': 'chat.completion.chunk', 'model': body.get('model')}
            for o in ({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'ok-from-codary'}}]},
                      {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 5, 'completion_tokens': 2, 'total_tokens': 7}}):
                self.wfile.write(('data: ' + json.dumps(o) + '\n\n').encode()); self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush(); return
        self.send(404, {})

if __name__ == '__main__': ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
