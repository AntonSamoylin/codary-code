#!/usr/bin/env python3
"""Заглушка Telegram Bot API: getUpdates с очередью, запись всех вызовов. Управление: POST /_push (update), GET /_calls."""
import json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

queue, calls, lock, counter = [], [], threading.Lock(), [100]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, obj, code=200):
        data = json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path.startswith('/_calls'):
            with lock: return self.reply(list(calls))
        self.reply({'ok': False}, 404)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        if self.path == '/_push':
            with lock: queue.append(body)
            return self.reply({'ok': True})
        method = self.path.rsplit('/', 1)[-1]
        if method == 'getUpdates':
            deadline = time.time() + min(body.get('timeout', 1), 2)
            while time.time() < deadline:
                with lock:
                    out = [u for u in queue if u['update_id'] >= body.get('offset', 0)]
                    if out: return self.reply({'ok': True, 'result': out})
                time.sleep(0.1)
            return self.reply({'ok': True, 'result': []})
        with lock: calls.append({'method': method, 'body': body})
        if method == 'getMe': return self.reply({'ok': True, 'result': {'id': 1, 'username': 'codary_test_bot'}})
        if method == 'sendMessage':
            counter[0] += 1; return self.reply({'ok': True, 'result': {'message_id': counter[0]}})
        self.reply({'ok': True, 'result': True})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
