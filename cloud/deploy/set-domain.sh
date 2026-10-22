#!/usr/bin/env bash
# Подключает домен к сайту облачных сред и выпускает общий сертификат (старый адрес sslip.io остаётся рабочим).
# Использование на сервере: ./deploy/set-domain.sh cloud.codary.ru   (DNS-запись должна уже указывать на этот сервер)
set -euo pipefail
DOMAIN=${1:?укажите домен}
OLD=${2:-cloud-159-195-232-233.sslip.io}
CONF=/etc/nginx/sites-available/codary-cloud.conf
IP=$(curl -s -4 https://api.ipify.org || true)
RES=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
[ -n "$RES" ] || { echo "DNS для $DOMAIN пока не отвечает"; exit 1; }
[ -z "$IP" ] || [ "$RES" = "$IP" ] || { echo "$DOMAIN указывает на $RES, а сервер — $IP"; exit 1; }
grep -q "$DOMAIN" "$CONF" || sed -i -E "s/^(\s*server_name )([^;]*);/\1\2 $DOMAIN;/" "$CONF"
nginx -t && systemctl reload nginx
certbot --nginx --expand -d "$OLD" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w "https://$DOMAIN/enter -> %{http_code}\n" "https://$DOMAIN/enter"
