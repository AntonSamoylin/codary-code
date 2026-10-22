#!/usr/bin/env python3
"""Заглушка OpenAI-совместимой модели для проверки плагина. Сообщение вида «TOOL:имя {json}» превращается в вызов инструмента,
ответ на результат инструмента — «tool-result: …», остальное — «ok-from-fake: <текст>»."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def text_of(m):
    c = m.get('content')
    if isinstance(c, list): return ''.join(p.get('text', '') for p in c if isinstance(p, dict))
    return c or ''

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        msgs = body.get('messages', [])
        last = msgs[-1] if msgs else {}
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
        def ev(o): self.wfile.write(('data: ' + json.dumps(o) + '\n\n').encode()); self.wfile.flush()
        base = {'id': 'c1', 'object': 'chat.completion.chunk', 'model': body.get('model')}
        usage = {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}
        user = text_of(last) if last.get('role') == 'user' else ''
        if last.get('role') == 'tool':
            ev({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'tool-result: ' + text_of(last)[:300]}}]})
            ev({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': usage})
        elif user.startswith('TOOL:') and body.get('tools'):
            name, _, args = user[5:].partition(' ')
            ev({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function', 'function': {'name': name, 'arguments': args or '{}'}}]}}]})
            ev({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}], 'usage': usage})
        else:
            ev({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'ok-from-fake: ' + (user or 'title')}}]})
            ev({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': usage})
        self.wfile.write(b'data: [DONE]\n\n')

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
