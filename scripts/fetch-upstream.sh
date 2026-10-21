#!/usr/bin/env bash
# Чистый checkout OpenCode на версии из upstream.json в каталог upstream/ (без истории). Все прежние правки сбрасываются.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(node -p "require('./upstream.json').repo")
COMMIT=$(node -p "require('./upstream.json').commit")
mkdir -p upstream
cd upstream
[ -d .git ] || { git init -q; git remote add origin "$REPO"; }
git fetch --depth 1 origin "$COMMIT"
git checkout -q -f FETCH_HEAD
git clean -fdq          # убираем наши прежние новые файлы; node_modules и сборки (в .gitignore) остаются
echo "upstream: $(git log -1 --format='%h %s')"
