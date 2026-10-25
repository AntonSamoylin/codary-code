#!/usr/bin/env bash
# Докачка большого файла с сервера порциями по 16 МБ с повтором при обрыве (один поток ssh через несколько узлов иногда зависает).
# Использование: REMOTE_SH='ssh user@host' ./scripts/fetch-remote.sh /путь/на/сервере/файл ./локальный-файл
# REMOTE_SH — команда, которая выполняет переданную ей строку в оболочке сервера (для проверок подойдёт REMOTE_SH='bash -c').
set -euo pipefail
SRC=$1; DST=$2; CHUNK=16777216
: "${REMOTE_SH:?задайте REMOTE_SH, например 'ssh user@host'}"
TOTAL=$($REMOTE_SH "stat -c %s '$SRC'")
touch "$DST"; tries=0
while true; do
  size=$(wc -c < "$DST" | tr -d ' ')
  [ "$size" -ge "$TOTAL" ] && break
  $REMOTE_SH "tail -c +$((size + 1)) '$SRC' | head -c $CHUNK" >> "$DST" || true
  new=$(wc -c < "$DST" | tr -d ' ')
  if [ "$new" -le "$size" ]; then
    tries=$((tries + 1)); [ "$tries" -ge 8 ] && { echo "нет прогресса, остановился на $new из $TOTAL" >&2; exit 1; }; sleep 5
  else tries=0; fi
  echo "  $new / $TOTAL"
done
[ "$(wc -c < "$DST" | tr -d ' ')" -eq "$TOTAL" ] || { echo "размер не совпал" >&2; exit 1; }
