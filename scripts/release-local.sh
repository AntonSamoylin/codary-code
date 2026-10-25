#!/usr/bin/env bash
# Сборка установщиков всех платформ и проверка. Результат — out/v<версия>/ с SHA256SUMS.txt. НИЧЕГО НЕ ПУБЛИКУЕТ (релиз на GitHub — отдельным шагом вручную).
# Mac (чип Apple и Intel) собираются на этом Mac. Windows собирается на Linux-сервере с Docker (scripts/build-win-docker.sh):
#   WIN_SSH='ssh user@host'  — команда доступа к серверу (как в fetch-remote.sh), WIN_DIR=/путь/к/репозиторию/на/сервере (по умолчанию /opt/codary-build/codary-code)
# Без WIN_SSH Windows пропускается. SKIP_TESTS=1 пропускает проверку сервера приложения (~3 минуты).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./version.json').version")
OUT="out/v$VER"
WIN_DIR=${WIN_DIR:-/opt/codary-build/codary-code}
[ -z "$(git status --porcelain -- brand plugins scripts version.json upstream.json)" ] || { echo "Есть незакоммиченные правки в brand/plugins/scripts — сначала закоммитьте и запушьте (сервер Windows берёт код из git)." >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "Локальные коммиты не отправлены (git push), Windows соберётся из старого кода." >&2; exit 1; }

[ -n "${SKIP_TESTS:-}" ] || { echo "▶ проверка сервера приложения"; python3 tests/service.py; }
echo "▶ Mac, чип Apple"; ./scripts/build-mac.sh arm64
echo "▶ Mac, Intel";      ./scripts/build-mac.sh x64
mkdir -p "$OUT"
cp out/codary-code-mac-arm64.{dmg,zip} out/codary-code-mac-x64.{dmg,zip} "$OUT/"

if [ -n "${WIN_SSH:-}" ]; then
  echo "▶ Windows (на сервере)"
  $WIN_SSH "cd '$WIN_DIR' && git pull -q --ff-only origin main && ./scripts/build-win-docker.sh > /tmp/win-build.log 2>&1; tail -3 /tmp/win-build.log"
  for f in codary-code-win-x64.exe codary-code-win-x64.exe.blockmap latest.yml; do
    REMOTE_SH="$WIN_SSH" ./scripts/fetch-remote.sh "$WIN_DIR/out/$f" "$OUT/$f"
  done
  want=$(awk '/^sha512:/ {print $2; exit}' "$OUT/latest.yml")
  got=$(openssl dgst -sha512 -binary "$OUT/codary-code-win-x64.exe" | base64)
  [ "$want" = "$got" ] || { echo "sha512 установщика Windows не совпал с latest.yml" >&2; exit 1; }
  echo "  sha512 Windows совпал"
else
  echo "▶ Windows пропущен (не задан WIN_SSH)"
fi

(cd "$OUT" && shasum -a 256 *.dmg *.zip *.exe 2>/dev/null > SHA256SUMS.txt; cat SHA256SUMS.txt | cut -c1-16,65-)
echo "Готово: $OUT (версия $VER). Не опубликовано."
