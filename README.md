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

## Подписи нет

Сертификатов нет, поэтому системы предупреждают о неизвестном разработчике.

* **Mac:** приложение подписано ad-hoc. После установки в «Программы» первый запуск — правой кнопкой по значку → «Открыть» →
  «Открыть». Если macOS пишет, что приложение повреждено, выполните в «Терминале»:
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
