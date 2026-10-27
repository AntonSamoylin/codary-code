#!/usr/bin/env bash
# Локальная сборка для Mac: ./scripts/build-mac.sh arm64|x64 ; результат копируется в out/
# С подписью Apple Developer ID и нотаризацией: CODARY_SIGN=1 ./scripts/build-mac.sh arm64 (сначала ./scripts/sign-check.sh)
set -euo pipefail
ARCH=${1:-arm64}
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export CODARY_GH_OWNER=${CODARY_GH_OWNER:-AntonSamoylin} OPENCODE_CHANNEL=prod NODE_OPTIONS=--max-old-space-size=4096
export CODARY_TARGET_OS=darwin CODARY_TARGET_ARCH=$ARCH   # целевая платформа node-pty (важно при кросс-сборке x64 на Apple-чипе)
./scripts/fetch-upstream.sh
node scripts/apply-patches.mjs
cd upstream
if [ "$ARCH" = "x64" ]; then bun install --frozen-lockfile --os=darwin --cpu=x64; else bun install --frozen-lockfile --os=darwin --cpu=arm64; fi
cd packages/desktop
bun ./scripts/prebuild.ts
bun run build
rm -rf dist
npx electron-builder --mac --$ARCH --publish never --config electron-builder.config.ts
APP=$(ls -d dist/mac*/*.app | head -1)
codesign --verify --deep --strict "$APP"
if [ "${CODARY_SIGN:-}" = "1" ]; then
  # подписанная сборка: проверяем то, что проверит Gatekeeper на чужом Mac, и нотаризуем сам dmg (приложение внутри нотаризовал хук после подписи)
  echo "▶ проверка подписи и нотаризации"
  codesign -dvv "$APP" 2>&1 | grep -E "Authority=Developer ID Application|flags=.*runtime|TeamIdentifier" || { echo "нет подписи Developer ID с hardened runtime" >&2; exit 1; }
  xcrun stapler validate "$APP"
  spctl -a -vv -t exec "$APP" 2>&1 | tee /dev/stderr | grep -q "source=Notarized Developer ID" || { echo "Gatekeeper не считает приложение нотаризованным" >&2; exit 1; }
  DMG="dist/codary-code-mac-$ARCH.dmg"
  xcrun notarytool submit "$DMG" --keychain-profile "${CODARY_NOTARY_PROFILE:-codary-notary}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi
mkdir -p "$ROOT/out"
cp dist/codary-code-mac-$ARCH.dmg dist/codary-code-mac-$ARCH.zip "$ROOT/out/"
echo "готово: $ROOT/out"
