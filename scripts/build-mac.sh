#!/usr/bin/env bash
# Локальная сборка для Mac: ./scripts/build-mac.sh arm64|x64 ; результат копируется в out/
set -euo pipefail
ARCH=${1:-arm64}
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export CODARY_GH_OWNER=${CODARY_GH_OWNER:-AntonSamoylin} OPENCODE_CHANNEL=prod NODE_OPTIONS=--max-old-space-size=4096
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
mkdir -p "$ROOT/out"
cp dist/codary-code-mac-$ARCH.dmg dist/codary-code-mac-$ARCH.zip "$ROOT/out/"
echo "готово: $ROOT/out"
