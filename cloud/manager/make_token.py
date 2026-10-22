#!/usr/bin/env python3
"""Выдаёт токен входа для проверки (то же делает сайт codary.ru). Использование: CC_SECRET=... python3 make_token.py <uid> [секунд] [--admin]"""
import base64, hashlib, hmac, json, os, secrets, sys, time
args = [a for a in sys.argv[1:] if not a.startswith('--')]
admin = '--admin' in sys.argv
uid, ttl = args[0], int(args[1]) if len(args) > 1 else 120
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
body = b64(json.dumps({'uid': uid, 'exp': int(time.time()) + ttl, 'n': secrets.token_hex(8), **({'adm': 1} if admin else {})}, separators=(',', ':')).encode())
print(body + '.' + b64(hmac.new(os.environ['CC_SECRET'].encode(), body.encode(), hashlib.sha256).digest()))
