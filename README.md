# Codary Code

Десктоп-приложение ИИ-агента для программирования (Mac и Windows) под брендом Codary. Подключается по API к любым
нейросетям (Claude, GPT, Gemini, DeepSeek, GLM и другим); своей модели нет. Страница продукта: https://codary.ru/code.php

Основа — открытая программа [OpenCode](https://github.com/anomalyco/opencode) (лицензия MIT). Этот репозиторий — **надстройка**:
в нём нет копии исходников OpenCode, только то, что отличает Codary Code, и процесс сборки.

## Что здесь лежит

| Что | Где |
| --- | --- |
| Версия OpenCode, на которой строимся | `upstream.json` (тег и коммит) |
| Версия Codary Code | `version.json` |
| Правки брендинга и отключений | `scripts/apply-patches.mjs` |
| Логотип, иконки, favicon | `brand/` (генератор: `scripts/make-brand.py`) |
| Сборка Mac и Windows | `.github/workflows/build.yml` |
| Лицензия и уведомление о происхождении кода | `brand/LICENSE-opencode.txt`, `NOTICE.txt` |

Что меняют патчи: название и идентификатор приложения (`ru.codary.code`), иконки и логотипы интерфейса, ссылки справки и
обратной связи (ведут на codary.ru), схема ссылок `codary-code://`, а также отключены рекламные провайдеры OpenCode
(Zen и Go), автообновление CLI и публикация сессий на opencode.ai. Хранилище данных остаётся общим с OpenCode
(`~/.local/share/opencode`), поэтому настройки провайдеров из мастера на странице работают как есть.

## Возможности сверх OpenCode

Встроенный плагин `plugins/codary/` (подключается как внутренний плагин сервера, код копируется в `upstream/` скриптом патчей).

* **Задачи по расписанию.** Агент получает инструменты `schedule_create`, `schedule_list`, `schedule_delete`, `schedule_toggle`,
  `schedule_run_now`. Задачи хранятся в `~/.local/share/opencode/codary/schedules.json`, выполняются, пока приложение запущено
  (пропущенный запуск выполняется при старте), каждая — в отдельном сеансе «⏰ название». Режим по умолчанию `readonly`
  (агент «план», без правок); `auto` подтверждает разрешения сам, кроме выхода за пределы проекта. Создание и запуск подтверждает пользователь.
* **Управление из Telegram.** Свой бот из BotFather. Настройки — файл `codary.json` в папке настроек OpenCode
  (`~/.config/opencode/` на Mac, `%USERPROFILE%\.config\opencode\` на Windows):
  ```json
  { "telegram": { "token": "123456:ABC…", "allowed": [123456789] } }
  ```
  `allowed` — Telegram ID, которым разрешено управлять агентом (свой ID бот присылает по команде `/id`; чужим отвечает только их ID).
  Работает только в личных чатах. Команды: `/new`, `/stop`, `/projects`, `/use N`, `/schedules`, `/status`. Запросы разрешений приходят кнопками.
  Для проверок можно вместо файла задать `CODARY_TELEGRAM_TOKEN` и `CODARY_TELEGRAM_ALLOWED`.
* **Провайдер «Codary AI-шлюз»** (`https://api.codary.ru/v1`) — за флагом `brand/features.json` → `gatewayProvider` (по умолчанию `false`,
  пока шлюз закрыт). Тестовая сборка: `CODARY_GATEWAY=1 ./scripts/build-mac.sh arm64`. Нюанс: провайдер из конфигурации считается
  подключённым и без ключа, поэтому при включённом флаге он будет моделью по умолчанию, пока пользователь не подключит другого.

### Проверки

* `python3 tests/e2e.py` — 22 проверки плагина на настоящем сервере OpenCode из `upstream/` (заглушки модели и Telegram, `tests/fake_*.py`).
* `python3 tests/app_smoke.py "<путь к Codary Code.app>"` — те же основные сценарии внутри собранного приложения на Mac.

## Память (формат Obsidian)

Агент ведёт долгую память инструментом `memory` (код: `plugins/codary/memory-store.ts`, `memory.ts`, `tools.ts`). Заметки — обычные markdown-файлы с шапкой (`title`, `type`, `tags`, `summary`, даты), `[[ссылками]]` и `#тегами`:
`<проект>/.codary/` (проектная память) и `~/.codary/` (личная память пользователя). Папку можно открыть в Obsidian как хранилище (`/vault`) и править руками.
В каждый чат подгружаются только оглавления `index.md` (автоматический блок между метками, ваш текст вне меток сохраняется), остальное агент ищет (`search`) и открывает (`read`).
Действия: `save` (по умолчанию дополняет; `replace` оставляет копию в `.trash/`), `read` (с обратными ссылками), `search`, `daily` (журнал дня), `check` (битые ссылки с подсказкой, дубликаты, опечатки в тегах, устаревшее, секреты), `open`.
Пароли, ключи и токены не сохраняются. Команды: `/remember`, `/handoff`, `/memory-check`, `/vault`, `/memory-auto on|off`.
**Фоновое подведение итогов** (`plugins/codary/curator.ts`): когда чат затих на 45 с и в нём не меньше двух реплик, дочерний сеанс «🧠 Память» на самой дешёвой подходящей модели аккаунта читает разговор (секреты скрыты) и сам сохраняет важное инструментом `memory`; не больше 20 разборов в сутки, повторно — только после новых реплик, сеанс архивируется и в списке чатов не виден. Выключатель: `/memory-auto off` или `CODARY_MEMORY_AUTO=0`. Проверка логики: `bun test tests/memory.test.ts`, на настоящем сервере — `tests/service.py`.

## Сборка

В GitHub: **Actions → build → Run workflow** (флажок «release» создаёт релиз с установщиками). Либо опубликуйте тег
`v<версия из version.json>`. Собираются три установщика: Mac Apple (arm64), Mac Intel (x64), Windows (x64).

Локально (нужны Node 24, [Bun](https://bun.sh), Pillow только для `make-brand.py`):

```bash
./scripts/fetch-upstream.sh                 # чистый checkout OpenCode в upstream/
node scripts/apply-patches.mjs              # наложить брендинг
cd upstream && bun install --frozen-lockfile
cd packages/desktop
export OPENCODE_CHANNEL=prod NODE_OPTIONS=--max-old-space-size=4096
bun ./scripts/prebuild.ts && bun run build
npx electron-builder --mac --arm64 --publish never --config electron-builder.config.ts   # на Mac; для Windows: --win
```

## Сборка без GitHub Actions (если Actions недоступны)

* Mac: `./scripts/build-mac.sh arm64` и `./scripts/build-mac.sh x64` на Mac (x64 собирается кросс-сборкой на Apple-чипе); результат в `out/`.
* Всё сразу: `WIN_SSH='ssh user@host' ./scripts/release-local.sh` — проверка сервера приложения, Mac (оба чипа), Windows на сервере с докачкой и сверкой sha512; результат в `out/v<версия>/` с `SHA256SUMS.txt`. Ничего не публикует; без `WIN_SSH` Windows пропускается. Работает только с закоммиченным и отправленным кодом.
* Windows: `./scripts/build-win-docker.sh` на Linux-сервере с Docker (образ `electronuserland/builder:wine`, Node 24 и Wine внутри). Памяти нужно около 4–5 ГБ.
  Если сборка падает на «Could not resolve …» после прерванной установки — удалите том кэша: `docker volume rm codary-bun-cache`.

## Подписи нет

Сертификатов нет, поэтому системы предупреждают о неизвестном разработчике.

* **Mac:** приложение подписано ad-hoc. После установки в «Программы» macOS может заблокировать запуск: откройте
  «Системные настройки → Конфиденциальность и безопасность» и нажмите «Всё равно открыть» (на старых версиях macOS — правая
  кнопка по значку → «Открыть»). Если пишет, что приложение повреждено, выполните в «Терминале»:
  `xattr -dr com.apple.quarantine "/Applications/Codary Code.app"`. Автообновление на Mac отключено: новую версию скачивают со страницы.
* **Windows:** SmartScreen покажет «Windows защитила ваш компьютер» → «Подробнее» → «Выполнить в любом случае». Автообновление работает.

## Обновление до новой версии OpenCode

1. В `upstream.json` укажите новый тег и его коммит (`git ls-remote --tags https://github.com/anomalyco/opencode.git 'v1.*'`).
2. Запустите `./scripts/fetch-upstream.sh && node scripts/apply-patches.mjs`. Если OpenCode изменил файл, который мы правим,
   скрипт скажет, какую правку поправить, и остановится — молча ничего не пропускается.
3. Поднимите `version.json`, соберите и проверьте приложение, опубликуйте тег.

## Правила

* Не использовать название «OpenCode» для продвижения этого продукта; в приложении и в уведомлении сохраняется
  указание на происхождение кода и лицензия MIT.
* Ключи пользователей Codary Code не получает: приложение работает напрямую с выбранным провайдером.
