#!/usr/bin/env bash
# Установка менеджера облачных сред на сервер (идемпотентно). Запускать от root из каталога cloud/:
#   ./deploy/install.sh <домен>      например: ./deploy/install.sh cloud-159-195-232-233.sslip.io
set -euo pipefail
DOMAIN=${1:?укажите домен}
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/codary-cloud
mkdir -p $APP
cp "$HERE/manager/app.py" "$HERE/manager/make_token.py" $APP/
cp "$HERE/deploy/firewall.sh" $APP/ && chmod +x $APP/firewall.sh

# окружение Python
[ -d $APP/venv ] || python3 -m venv $APP/venv
$APP/venv/bin/pip install -q fastapi 'uvicorn[standard]' python-multipart >/dev/null

# секрет входа (общий с сайтом); создаётся один раз
[ -f $APP/env ] || { printf 'CC_SECRET=%s\nCC_MAX_CONTAINERS=3\nCC_IDLE_MINUTES=20\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > $APP/env; chmod 600 $APP/env; }

# диски пользователей (образы ext4 фиксированного размера) и лимиты по умолчанию
command -v mkfs.ext4 >/dev/null || apt-get install -y -qq e2fsprogs >/dev/null
mkdir -p /var/lib/codary-cloud/img /var/lib/codary-cloud/mnt
[ -f $APP/limits.json ] || echo '{"default": {"disk_gb": 5, "daily_minutes": 480}, "users": {}}' > $APP/limits.json
# адрес и секрет оповещений на сайт (секрет создаётся один раз; тот же кладётся в .config/cloud.php на сайте)
grep -q '^CC_ALERT_SECRET=' $APP/env || echo "CC_ALERT_SECRET=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')" >> $APP/env
grep -q '^CC_ALERT_URL=' $APP/env || echo "CC_ALERT_URL=https://codary.ru/cloud-alert.php" >> $APP/env

# сеть для сред: свой мост, без связи между контейнерами
docker network inspect codary-cloud >/dev/null 2>&1 || docker network create --driver bridge --subnet 172.30.0.0/24 \
  -o com.docker.network.bridge.name=br-codary -o com.docker.network.bridge.enable_icc=false codary-cloud >/dev/null
$APP/firewall.sh br-codary

cat > /etc/systemd/system/codary-cloud-fw.service <<UNIT
[Unit]
Description=Правила сети облачных сред Codary
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$APP/firewall.sh br-codary
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/codary-cloud-manager.service <<UNIT
[Unit]
Description=Менеджер облачных сред Codary Code
After=docker.service codary-cloud-fw.service
Requires=docker.service
[Service]
EnvironmentFile=$APP/env
WorkingDirectory=$APP
ExecStart=$APP/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8200 --log-level warning
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now codary-cloud-fw.service codary-cloud-manager.service
systemctl restart codary-cloud-manager.service

# nginx: сначала только порт 80, затем certbot добавляет HTTPS
# конфиг пишем только в первый раз: после `certbot --nginx` в нём лежат настройки HTTPS, затирать их нельзя
CONF=/etc/nginx/sites-available/codary-cloud.conf
[ -f "$CONF" ] || sed "s/@DOMAIN@/$DOMAIN/g" "$HERE/deploy/nginx-cloud.conf" > "$CONF"
# панель администратора: добавляем в уже настроенный конфиг, если её там ещё нет
grep -q '_admin' "$CONF" || python3 - "$CONF" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
loc = "    location ^~ /_admin { proxy_pass http://127.0.0.1:8200; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }\n"
s = s.replace("    location = /wait ", loc + "    location = /wait ", 1)
open(p, "w").write(s)
PY
ln -sf /etc/nginx/sites-available/codary-cloud.conf /etc/nginx/sites-enabled/codary-cloud.conf
nginx -t && systemctl reload nginx
echo "готово. HTTPS: certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m <почта> --redirect"
