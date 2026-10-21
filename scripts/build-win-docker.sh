#!/usr/bin/env bash
# Сборка установщика Windows на Linux-сервере: Docker + Wine. Результат — в out/ рядом со скриптом.
# Ограничения по памяти и процессору, чтобы не мешать другим службам на сервере.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm --memory=4500m --memory-swap=8g --cpus=3 \
  -v "$PWD":/project \
  -v codary-bun-cache:/root/.bun -v codary-electron-cache:/root/.cache/electron -v codary-eb-cache:/root/.cache/electron-builder \
  -w /project electronuserland/builder:wine bash scripts/_win-inside.sh
