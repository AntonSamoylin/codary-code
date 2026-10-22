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
$APP/venv/bin/pip install -q fastapi 'uvicorn[standard]' >/dev/null

# секрет входа (общий с сайтом); создаётся один раз
[ -f $APP/env ] || { printf 'CC_SECRET=%s\nCC_MAX_CONTAINERS=3\nCC_IDLE_MINUTES=20\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > $APP/env; chmod 600 $APP/env; }

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
ln -sf /etc/nginx/sites-available/codary-cloud.conf /etc/nginx/sites-enabled/codary-cloud.conf
nginx -t && systemctl reload nginx
echo "готово. HTTPS: certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m <почта> --redirect"
