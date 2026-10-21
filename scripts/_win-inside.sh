#!/usr/bin/env bash
# Выполняется ВНУТРИ контейнера electronuserland/builder:wine (см. build-win-docker.sh): собирает установщик Windows x64.
set -euo pipefail
cd /project
export CODARY_GH_OWNER=${CODARY_GH_OWNER:-AntonSamoylin} OPENCODE_CHANNEL=prod NODE_OPTIONS=--max-old-space-size=3072 CI=true
git config --global --add safe.directory '*'
node -v; wine --version || true
BUNV=1.4.2
npm i -g "bun@${BUNV}" node-gyp >/dev/null 2>&1; bun --version
python3 -m pip install setuptools >/dev/null 2>&1 || pip install setuptools >/dev/null 2>&1 || true   # node-gyp: tree-sitter-powershell собирается при установке
./scripts/fetch-upstream.sh
node scripts/apply-patches.mjs
cd upstream
bun install --frozen-lockfile                      # зависимости для запуска сборки (Linux)
cd packages/desktop
export CODARY_TARGET_OS=win32 CODARY_TARGET_ARCH=x64
bun ./scripts/prebuild.ts
bun run build
cd ../..
bun install --frozen-lockfile --os=win32 --cpu=x64 --ignore-scripts   # родные модули Windows для упаковки
cd packages/desktop
rm -rf dist
npx electron-builder --win --x64 --publish never --config electron-builder.config.ts
mkdir -p /project/out
cp dist/codary-code-win-x64.exe dist/*.blockmap dist/latest.yml /project/out/ 2>/dev/null || true
ls -la /project/out
