#!/usr/bin/env bash
# Режим «только Codary» в облаке: менеджер получает секрет выдачи токенов (тот же, что GW_CLOUD_SECRET у шлюза) и адрес шлюза.
# Секрет читается из stdin и в историю команд и журналы не попадает:  ssh шлюз 'sudo grep ^GW_CLOUD_SECRET= …' | cut -d= -f2- | ssh облако ./enable-codary-only.sh
# Выключить (вернуть свои провайдеры): ./enable-codary-only.sh off — контейнеры, созданные в режиме, пересоздаются при следующем запуске.
set -euo pipefail
ENV=/opt/codary-cloud/env
cp -p "$ENV" "$ENV.bak-$(date +%s)"
grep -v '^CC_GATEWAY_CLOUD_SECRET=' "$ENV" > "$ENV.tmp" || true
if [ "${1:-}" != "off" ]; then
  read -r SECRET
  [ "${#SECRET}" -ge 32 ] || { echo "секрет короче 32 знаков" >&2; rm -f "$ENV.tmp"; exit 1; }
  echo "CC_GATEWAY_CLOUD_SECRET=$SECRET" >> "$ENV.tmp"
  grep -q '^CC_GATEWAY_URL=' "$ENV.tmp" || echo "CC_GATEWAY_URL=https://api.codary.ru" >> "$ENV.tmp"
fi
install -m 600 "$ENV.tmp" "$ENV"; rm -f "$ENV.tmp"
systemctl restart codary-cloud-manager; sleep 3; systemctl is-active codary-cloud-manager
