#!/usr/bin/env python3
"""Из мастер-картинок brand/icon-master.png и brand/logo-master.png собирает наборы значков и логотипов.
Нужен Pillow. icon.icns/icon.ico лежат готовыми (icns собирается только на macOS: iconutil)."""
import base64, io, os
from PIL import Image
B = os.path.join(os.path.dirname(__file__), '..', 'brand')
icon = Image.open(os.path.join(B, 'icon-master.png')).convert('RGBA')
logo = Image.open(os.path.join(B, 'logo-master.png')).convert('RGBA')
def save(img, size, name, folder='icons'):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(B, folder, name), optimize=True)
for n in (32, 64, 128): save(icon, n, f'{n}x{n}.png')
save(icon, 256, '128x128@2x.png'); save(icon, 256, 'dock.png'); save(icon, 512, 'icon.png'); save(icon, 50, 'StoreLogo.png')
for n in (30, 44, 71, 89, 107, 142, 150, 284, 310): save(icon, n, f'Square{n}x{n}Logo.png')
# для встроенного в интерфейс логотипа (data-URI) и для favicon / web-иконок
os.makedirs(os.path.join(B, 'web'), exist_ok=True)
save(logo, 160, 'logo-160.png', 'web')
for n, name in ((96, 'favicon-96x96.png'), (180, 'apple-touch-icon.png'), (192, 'web-app-manifest-192x192.png'), (512, 'web-app-manifest-512x512.png')): save(icon, n, name, 'web')
icon.resize((48, 48), Image.LANCZOS).save(os.path.join(B, 'web', 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
png = io.BytesIO(); icon.resize((128, 128), Image.LANCZOS).save(png, 'PNG')
open(os.path.join(B, 'web', 'favicon.svg'), 'w').write(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128"><image width="128" height="128" xlink:href="data:image/png;base64,' + base64.b64encode(png.getvalue()).decode() + '"/></svg>')
print('ok')
