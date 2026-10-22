#!/usr/bin/env python3
"""Выдаёт токен входа для проверки (то же делает сайт codary.ru). Использование: CC_SECRET=... python3 make_token.py <uid> [секунд]"""
import base64, hashlib, hmac, json, os, secrets, sys, time
uid, ttl = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 120
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
body = b64(json.dumps({'uid': uid, 'exp': int(time.time()) + ttl, 'n': secrets.token_hex(8)}, separators=(',', ':')).encode())
print(body + '.' + b64(hmac.new(os.environ['CC_SECRET'].encode(), body.encode(), hashlib.sha256).digest()))
