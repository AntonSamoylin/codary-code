#!/usr/bin/env node
// Накладывает брендинг Codary Code на чистый checkout OpenCode (каталог upstream/).
// Каждая правка проверяет, что исходный текст на месте: если OpenCode изменил файл, скрипт падает с понятным сообщением,
// а не молча пропускает правку. После смены UPSTREAM-версии прогоните скрипт и поправьте упавшие правки.
//
// Переменные: CODARY_GH_OWNER (владелец GitHub-репозитория для автообновлений), CODARY_VERSION (версия приложения).
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UP = join(ROOT, 'upstream')
const BRAND = join(ROOT, 'brand')
const OWNER = process.env.CODARY_GH_OWNER || 'codary-ru'
const REPO = 'codary-code'
const VERSION = process.env.CODARY_VERSION || JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8')).version
const SITE = 'https://codary.ru'
const NAME = 'Codary Code'
let failed = 0

const p = (...a) => join(UP, ...a)
function edit(file, pairs) {
  const path = p(file)
  let text = readFileSync(path, 'utf8')
  for (const [from, to, opts = {}] of pairs) {
    const count = text.split(from).length - 1
    if (count === 0 || (!opts.all && count !== 1)) {
      console.error(`✗ ${file}: ожидалось ${opts.all ? '≥1' : '1'} вхождение, найдено ${count}: ${JSON.stringify(from.slice(0, 80))}`)
      failed++
      continue
    }
    text = text.split(from).join(to)
  }
  writeFileSync(path, text)
  console.log(`✓ ${file}`)
}
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(src)) {
    const s = join(src, f)
    statSync(s).isDirectory() ? copyDir(s, join(dest, f)) : copyFileSync(s, join(dest, f))
  }
}

// ---------------------------------------------------------------- сборка (electron-builder)
edit('packages/desktop/electron-builder.config.ts', [
  ['artifactName: "opencode-desktop-${os}-${arch}.${ext}"', 'artifactName: "codary-code-${os}-${arch}.${ext}"'],
  ['prod: "ai.opencode.desktop",', 'prod: "ru.codary.code",'],
  ['productName: "OpenCode",', `productName: "${NAME}",`],
  // схема ссылок: opencode:// -> codary-code://, чтобы не спорить с установленным OpenCode
  ['protocols: {\n    name: "OpenCode",\n    schemes: ["opencode"],\n  },', `protocols: {\n    name: "${NAME}",\n    schemes: ["codary-code"],\n  },`],
  ['protocols: { name: "OpenCode", schemes: ["opencode"] },', `protocols: { name: "${NAME}", schemes: ["codary-code"] },`],
  ['publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },', `publish: { provider: "github", owner: "${OWNER}", repo: "${REPO}", channel: "latest" },`],
  // подписи и нотаризация нам недоступны (нет сертификатов): Mac подписывается ad-hoc, Windows — без подписи
  ['notarize: true,', 'notarize: false,'],
  ['dmg: {\n    sign: true,\n  },', 'dmg: {\n    sign: false,\n  },'],
  ['async function signWindows(configuration: { path: string }) {\n', 'async function signWindows(configuration: { path: string }) {\n  return // без сертификата: подпись Windows отключена\n'],
  ['category: "public.app-category.developer-tools",', 'category: "public.app-category.developer-tools",\n    identity: null,'],
  // без идентификатора разработчика собираем ad-hoc подпись сами: иначе macOS считает скачанный пакет «повреждённым»
  ['  mac: {\n    category:', '  afterPack: async (context) => {\n    if (context.electronPlatformName !== "darwin") return\n    const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)\n    await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", bundle])\n  },\n  mac: {\n    category:'],
  // тексты лицензии и уведомление о происхождении кода — рядом с приложением
  ['{\n      from: "native/",', '{\n      from: "resources/legal/",\n      to: "legal/",\n    },\n    {\n      from: "native/",'],
])
edit('packages/desktop/package.json', [
  ['"homepage": "https://opencode.ai",', `"homepage": "${SITE}/code.php",`],
  ['"name": "OpenCode",\n    "email": "hello@opencode.ai"', `"name": "Codary",\n    "email": "info@codary.ru"`],
])
{
  const f = p('packages/desktop/package.json'); const j = JSON.parse(readFileSync(f, 'utf8')); j.version = VERSION
  writeFileSync(f, JSON.stringify(j, null, 2) + '\n'); console.log(`✓ packages/desktop/package.json версия ${VERSION}`)
}
mkdirSync(p('packages/desktop/resources/legal'), { recursive: true })
copyFileSync(join(BRAND, 'LICENSE-opencode.txt'), p('packages/desktop/resources/legal/LICENSE-opencode.txt'))
copyFileSync(join(ROOT, 'NOTICE.txt'), p('packages/desktop/resources/legal/NOTICE.txt'))

// кросс-сборка (Windows на Linux): целевая платформа node-pty берётся из CODARY_TARGET_OS/ARCH, а не из машины, где идёт сборка
edit('packages/desktop/electron.vite.config.ts', [
  ['const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`', 'const nodePtyPkg = `@lydell/node-pty-${process.env.CODARY_TARGET_OS ?? process.platform}-${process.env.CODARY_TARGET_ARCH ?? process.arch}`'],
])

// ---------------------------------------------------------------- имя, окна, ссылки (main-процесс)
edit('packages/desktop/src/main/index.ts', [
  ['  prod: "OpenCode",\n', `  prod: "${NAME}",\n`],
  ['  prod: "ai.opencode.desktop",\n', '  prod: "ru.codary.code",\n'],
  ['arg.startsWith("opencode://")', 'arg.startsWith("codary-code://")'],
  ['app.setAsDefaultProtocolClient("opencode")', 'app.setAsDefaultProtocolClient("codary-code")'],
])
edit('packages/desktop/src/main/windows.ts', [['title: "OpenCode",', `title: "${NAME}",`]])
edit('packages/app/src/pages/layout/deep-links.ts', [['input.startsWith("opencode://")', 'input.startsWith("codary-code://")']])
// автообновление через electron-updater на macOS требует подписи — без неё не включаем (обновление вручную со страницы загрузки)
edit('packages/desktop/src/main/constants.ts', [['app.isPackaged && CHANNEL !== "dev"', 'app.isPackaged && CHANNEL !== "dev" && process.platform !== "darwin"']])
// сервер внутри приложения: без рекламных провайдеров OpenCode (Zen/Go), автообновления CLI и публикации сессий на opencode.ai;
// провайдер «Codary AI-шлюз» добавляем только когда включён флаг (brand/features.json или CODARY_GATEWAY=1): шлюз пока закрыт
const features = JSON.parse(readFileSync(join(BRAND, 'features.json'), 'utf8'))
const loginOn = process.env.CODARY_REQUIRE_LOGIN ? process.env.CODARY_REQUIRE_LOGIN === '1' : !!features.requireLogin
const gatewayOn = process.env.CODARY_GATEWAY ? process.env.CODARY_GATEWAY === '1' : !!features.gatewayProvider
const GATEWAY_MODELS = ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5', 'glm-4.7', 'glm-4.5-air']
const inlineConfig = { disabled_providers: ['opencode', 'opencode-go'], autoupdate: false, share: 'disabled' }
if (gatewayOn) {
  inlineConfig.provider = {
    codary: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Codary AI-шлюз',
      options: { baseURL: 'https://api.codary.ru/v1' },
      models: Object.fromEntries(GATEWAY_MODELS.map((m) => [m, { name: m, limit: { context: 128000, output: 16384 } }])),
    },
  }
}
console.log(`✓ провайдер шлюза Codary: ${gatewayOn ? 'ВКЛЮЧЁН' : 'выключен'}`)
edit('packages/desktop/src/main/server.ts', [[
  '    OPENCODE_CLIENT: "desktop",\n',
  '    OPENCODE_CLIENT: "desktop",\n    OPENCODE_DISABLE_AUTOUPDATE: "true",\n' +
  '    CODARY_APP_VERSION: app.getVersion(),\n    CODARY_APP_PLATFORM: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux",\n' +
  `    CODARY_RESTRICT_PROVIDERS: ${loginOn ? '"1"' : '""'},\n` +
  `    OPENCODE_CONFIG_CONTENT: JSON.stringify(${JSON.stringify(inlineConfig)}),\n`,
]])

// режим «только аккаунт Codary» (CODARY_RESTRICT_PROVIDERS=1): сервер не принимает ключи других провайдеров
edit('packages/opencode/src/server/routes/instance/httpapi/handlers/control.ts', [
  ['      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)\n      return true',
   '      if (process.env.CODARY_RESTRICT_PROVIDERS === "1" && ctx.params.providerID !== "codary") return false\n      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)\n      return true'],
  ['      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)\n      return true',
   '      if (process.env.CODARY_RESTRICT_PROVIDERS === "1" && ctx.params.providerID !== "codary") return false\n      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)\n      return true'],
])

// встроенный плагин Codary: задачи по расписанию и управление из Telegram (plugins/codary -> packages/opencode/src/plugin/codary)
copyDir(join(ROOT, 'plugins', 'codary'), p('packages/opencode/src/plugin/codary'))
edit('packages/opencode/src/plugin/index.ts', [
  ['import { CerebrasPlugin } from "./cerebras"\n', 'import { CerebrasPlugin } from "./cerebras"\nimport { CodaryPlugin } from "./codary"\n'],
  ['    CerebrasPlugin,\n  ]', '    CerebrasPlugin,\n    CodaryPlugin,\n  ]'],
])

// ---------------------------------------------------------------- интерфейс
edit('packages/desktop/src/renderer/index.html', [['<title>OpenCode</title>', `<title>${NAME}</title>`]])
edit('packages/app/index.html', [['<title>OpenCode</title>', `<title>${NAME}</title>`]])
edit('packages/app/public/site.webmanifest', [['"name": "OpenCode",\n  "short_name": "OpenCode",', `"name": "${NAME}",\n  "short_name": "${NAME}",`]])
edit('packages/app/src/desktop-menu.ts', [
  ['href: "https://opencode.ai/docs" }', `href: "${SITE}/code.php" }`],
  ['href: "https://discord.com/invite/opencode"', 'href: "https://t.me/codary_ru"'],
  ['href: "https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml"', `href: "${SITE}/code.php#contact"`],
  ['href: "https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml"', `href: "${SITE}/code.php#contact"`],
])
edit('packages/app/src/entry.tsx', [['icon: "https://opencode.ai/favicon-96x96-v3.png"', `icon: "${SITE}/images/codary-code-logo.png"`]])
edit('packages/desktop/src/renderer/index.tsx', [['icon: "https://opencode.ai/favicon-96x96-v3.png"', `icon: "${SITE}/images/codary-code-logo.png"`]])
edit('packages/app/src/context/highlights.tsx', [['https://opencode.ai/changelog.json', `${SITE}/code-changelog.json`]])
edit('packages/app/src/pages/layout.tsx', [['https://opencode.ai/desktop-feedback', `${SITE}/code.php#contact`]])
edit('packages/app/src/pages/error.tsx', [['https://opencode.ai/desktop-feedback', `${SITE}/code.php#contact`]])
edit('packages/app/src/pages/home/home-projects-controller.tsx', [['https://opencode.ai/desktop-feedback', `${SITE}/code.php#contact`]])
edit('packages/app/src/hooks/use-providers.ts', [['  "opencode",\n  "opencode-go",\n', '']])

// логотипы интерфейса (знак, заставка, «слово») — наша картинка вместо пиксельного значка OpenCode
{
  const b64 = readFileSync(join(BRAND, 'web', 'logo-160.png')).toString('base64')
  writeFileSync(p('packages/ui/src/components/logo.tsx'), `import { type ComponentProps } from "solid-js"

// Логотип Codary Code (патч Codary: вместо пиксельных знаков OpenCode)
const SRC = "data:image/png;base64,${b64}"

export const Mark = (props: { class?: string }) => {
  return (
    <img data-component="logo-mark" src={SRC} alt="${NAME}" draggable={false} style={{ "object-fit": "contain" }} classList={{ [props.class ?? ""]: !!props.class }} />
  )
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img ref={props.ref} data-component="logo-splash" src={SRC} alt="${NAME}" draggable={false} style={{ "object-fit": "contain" }} classList={{ [props.class ?? ""]: !!props.class }} />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <div
      classList={{ [props.class ?? ""]: !!props.class }}
      style={{ display: "flex", "align-items": "center", gap: "0.6em", "font-weight": "700", "font-size": "28px", "white-space": "nowrap", color: "var(--icon-strong-base)" }}
    >
      <img src={SRC} alt="" draggable={false} style={{ height: "1.8em", width: "1.8em", "object-fit": "contain" }} />
      <span>${NAME}</span>
    </div>
  )
}
`)
  console.log('✓ packages/ui/src/components/logo.tsx')
  // большая бледная надпись на пустом экране новой сессии
  writeFileSync(p('packages/ui/src/v2/components/wordmark-v2.tsx'), `import { type ComponentProps } from "solid-js"

// Заставка нового сеанса: логотип и название Codary Code (патч Codary: вместо пиксельной надписи OpenCode)
const SRC = "data:image/png;base64,${b64}"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 129" fill="none" classList={{ [props.class ?? ""]: !!props.class }}>
      <image href={SRC} x="0" y="0" width="129" height="129" opacity="0.9" />
      <text x="150" y="94" font-size="80" font-weight="800" fill="currentColor" opacity="0.22" font-family="Inter, system-ui, sans-serif">${NAME}</text>
    </svg>
  )
}
`)
  console.log('✓ packages/ui/src/v2/components/wordmark-v2.tsx')
}

// заголовок «бесплатные модели от OpenCode» не показываем, когда таких моделей нет (а у нас их нет: провайдер opencode отключён)
edit('packages/app/src/components/dialog-select-model-unpaid-v2.tsx', [
  ['<div data-section="free-models" class="flex w-full flex-col items-start pb-3">', '<div data-section="free-models" class="flex w-full flex-col items-start pb-3" style={{ display: freeModels().length ? undefined : "none" }}>'],
])
edit('packages/app/src/components/dialog-select-model-unpaid.tsx', [
  ['<div class="text-14-medium text-text-base px-2.5">{language.t("dialog.model.unpaid.freeModels.title")}</div>', '<div class="text-14-medium text-text-base px-2.5" style={{ display: model.list().length ? undefined : "none" }}>{language.t("dialog.model.unpaid.freeModels.title")}</div>'],
])

// ---------------------------------------------------------------- облако: проект по умолчанию и создание папки
// В облаке (cloud.codary.ru) менеджер среды отвечает на /_cloud/info и /_cloud/mkdir (cloud/manager/app.py). Вне облака этих адресов нет
// и окно «Открыть проект» остаётся обычным. Сервер OpenCode сам папки не создаёт, поэтому без менеджера создать новый проект нельзя.
mkdirSync(p('packages/app/src/utils'), { recursive: true })
copyFileSync(join(BRAND, 'cloud', 'codary-cloud.ts'), p('packages/app/src/utils/codary-cloud.ts'))
console.log('✓ packages/app/src/utils/codary-cloud.ts')
edit('packages/app/src/components/dialog-select-directory.tsx', [
  ['import type { Path } from "@opencode-ai/sdk/v2/client"\n', 'import type { Path } from "@opencode-ai/sdk/v2/client"\nimport { cloudFolderOk, cloudInfo, cloudMkdir } from "@/utils/codary-cloud"\nimport { showToast } from "@/utils/toast"\n'],
  ['const RECENT_PROJECT_LIMIT = 5\n', 'const RECENT_PROJECT_LIMIT = 5\nconst GROUP_RANK: Record<string, number> = { recent: 0, folders: 1, create: 2 }\n'],
  ['  group: "recent" | "folders"\n}', '  group: "recent" | "folders" | "create"\n  create?: boolean\n}'],
  ['  const directories = createDirectorySearch({\n    sdk,\n    home,\n    base: start,\n  })',
    '  // облако: список начинается с рабочей папки /workspace, а не с домашней (там только служебные .cache и .config)\n  let workspace: string | undefined\n  const [cloud] = createResource(cloudInfo)\n\n  const directories = createDirectorySearch({\n    sdk,\n    home,\n    base: () => workspace ?? start(),\n  })'],
  ['  const items = async (value: string) => {\n    const results = await directories(value)',
    '  const items = async (value: string) => {\n    workspace = (await cloudInfo())?.workspace\n    const results = await directories(value)'],
  ['    return uniqueRows([...visible, ...directoryRows])\n',
    '    const rows = uniqueRows([...visible, ...directoryRows])\n    // облако: имя, которого ещё нет, можно создать прямо здесь\n    const name = value.trim()\n    if (!workspace || !cloudFolderOk(name)) return rows\n    const taken = rows.some((row) => row.absolute.startsWith(workspace + "/") && getFilename(row.absolute).toLowerCase() === name.toLowerCase())\n    if (taken) return rows\n    return [...rows, { absolute: `${workspace}/${name}`, search: name, group: "create", create: true } as Row]\n'],
  ['search={{ placeholder: language.t("dialog.directory.search.placeholder"), autofocus: true }}',
    'search={{ placeholder: cloud() ? language.t("dialog.directory.search.cloud") : language.t("dialog.directory.search.placeholder"), autofocus: true }}'],
  ['        sortGroupsBy={(a, b) => {\n          if (a.category === b.category) return 0\n          return a.category === "recent" ? -1 : 1\n        }}\n        groupHeader={(group) =>\n          group.category === "recent" ? language.t("home.recentProjects") : language.t("command.project.open")\n        }',
    '        sortGroupsBy={(a, b) => (GROUP_RANK[a.category] ?? 1) - (GROUP_RANK[b.category] ?? 1)}\n        groupHeader={(group) =>\n          group.category === "recent"\n            ? language.t("home.recentProjects")\n            : group.category === "create"\n              ? language.t("dialog.directory.create.group")\n              : language.t("command.project.open")\n        }'],
  ['          if (!path) return\n          resolve(path.absolute)\n',
    '          if (!path) return\n          if (!path.create) return resolve(path.absolute)\n          void cloudMkdir(getFilename(path.absolute)).then((made) => {\n            if (made.path) return resolve(made.path)\n            showToast({\n              title: language.t("dialog.directory.create.error"),\n              description: made.error === "limit" ? language.t("dialog.directory.create.limit") : undefined,\n            })\n          })\n'],
  ['        {(item) => {\n          const path = displayPickerPath(item.absolute, filter(), home())\n',
    '        {(item) => {\n          if (item.create) {\n            return (\n              <div data-directory-path={item.absolute} class="w-full flex items-center gap-x-3 rounded-md">\n                <FileIcon node={{ path: item.absolute, type: "directory" }} class="shrink-0 size-4" />\n                <span class="text-14-regular text-text-strong truncate">\n                  {language.t("dialog.directory.create", { name: getFilename(item.absolute) })}\n                </span>\n              </div>\n            )\n          }\n          const path = displayPickerPath(item.absolute, filter(), home())\n'],
])
edit('packages/app/src/i18n/en.ts', [
  ['  "dialog.directory.empty": "No folders found",\n',
    '  "dialog.directory.empty": "No folders found",\n  "dialog.directory.search.cloud": "Search folders or type a name for a new one",\n  "dialog.directory.create": "Create folder “{{name}}”",\n  "dialog.directory.create.group": "New folder",\n  "dialog.directory.create.error": "Could not create the folder",\n  "dialog.directory.create.limit": "Too many folders in the workspace",\n'],
])
edit('packages/app/src/i18n/ru.ts', [
  ['  "dialog.directory.empty": "Папки не найдены",\n',
    '  "dialog.directory.empty": "Папки не найдены",\n  "dialog.directory.search.cloud": "Найдите папку или введите имя новой",\n  "dialog.directory.create": "Создать папку «{{name}}»",\n  "dialog.directory.create.group": "Новая папка",\n  "dialog.directory.create.error": "Не удалось создать папку",\n  "dialog.directory.create.limit": "В рабочей папке слишком много папок",\n'],
])
// проект по умолчанию: пока список проектов пуст, открываем его сами, чтобы можно было сразу начать работу
edit('packages/app/src/pages/home/home-controller.ts', [
  ['import { createEffect, createMemo } from "solid-js"\n', 'import { cloudInfo } from "@/utils/codary-cloud"\nimport { createEffect, createMemo } from "solid-js"\n'],
  ['  return {\n    selection: {\n      value: selection,', '  const controller = {\n    selection: {\n      value: selection,'],
  ['      openProjectNewSession,\n    },\n  }\n}\n\nexport type HomeController',
    '      openProjectNewSession,\n    },\n  }\n\n  void cloudInfo().then((info) => {\n    const conn = focusedServer()\n    if (!info?.project || !conn || projects().length > 0) return\n    try {\n      if (localStorage.getItem("codary.cloud.default-project")) return\n      localStorage.setItem("codary.cloud.default-project", "1")\n    } catch {}\n    controller.project.add(conn, [info.project])\n  })\n\n  return controller\n}\n\nexport type HomeController'],
])

// ---------------------------------------------------------------- вход в приложение через сайт (brand/desktop): аккаунт Codary и токен устройства
// Окно входа закрывает интерфейс, пока нет аккаунта; включается флагом requireLogin (brand/features.json) или CODARY_REQUIRE_LOGIN=1 при сборке.
{
  const authSrc = readFileSync(join(BRAND, 'desktop', 'codary-auth.ts'), 'utf8')
  if (!authSrc.includes('/*REQUIRE_LOGIN*/ false')) { console.error('✗ codary-auth.ts: нет метки REQUIRE_LOGIN'); failed++ }
  writeFileSync(p('packages/desktop/src/main/codary-auth.ts'), authSrc.replace('/*REQUIRE_LOGIN*/ false', String(loginOn)))
  copyFileSync(join(BRAND, 'desktop', 'codary-login.tsx'), p('packages/desktop/src/renderer/codary-login.tsx'))
  console.log(`✓ вход через сайт: ${loginOn ? 'ВКЛЮЧЁН (экран входа закрывает интерфейс)' : 'выключен'}`)
}
edit('packages/desktop/src/preload/types.ts', [
  ['export type ServerReadyData = {', `export type CodaryAuthState = {
  enabled: boolean
  state: "out" | "waiting" | "in"
  code?: string
  message?: string
  account?: { status: string; balanceRub: number; todayRub?: number; avgRub?: number; left?: number | null; dailyLimitRub?: number | null; todayRequests?: number; todayTokensIn?: number; todayTokensCached?: number; todayTokensOut?: number }
}

export type ServerReadyData = {`],
  ['  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>\n}', `  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
  codaryAuth: {
    status: () => Promise<CodaryAuthState>
    login: () => Promise<CodaryAuthState>
    cancel: () => Promise<CodaryAuthState>
    logout: () => Promise<CodaryAuthState>
    devices: () => Promise<void>
    cloud: () => Promise<void>
    setLimit: (limitRub: number | null) => Promise<{ ok: boolean; error?: string }>
    pay: (amountRub: number) => Promise<{ ok: boolean; error?: string }>
    refresh: () => Promise<CodaryAuthState>
    onChange: (cb: (state: CodaryAuthState) => void) => () => void
  }
}`],
])
edit('packages/desktop/src/preload/index.ts', [
  ['  setNativeTranslations: (bundle) => ipcRenderer.invoke("set-native-translations", bundle),\n}', `  setNativeTranslations: (bundle) => ipcRenderer.invoke("set-native-translations", bundle),
  codaryAuth: {
    status: () => ipcRenderer.invoke("codary-auth:status"),
    login: () => ipcRenderer.invoke("codary-auth:login"),
    cancel: () => ipcRenderer.invoke("codary-auth:cancel"),
    logout: () => ipcRenderer.invoke("codary-auth:logout"),
    devices: () => ipcRenderer.invoke("codary-auth:devices"),
    cloud: () => ipcRenderer.invoke("codary-auth:cloud"),
    setLimit: (limitRub) => ipcRenderer.invoke("codary-auth:setLimit", limitRub),
    pay: (amount) => ipcRenderer.invoke("codary-auth:pay", amount),
    refresh: () => ipcRenderer.invoke("codary-auth:refresh"),
    onChange: (cb) => {
      const handler = (_: unknown, state: Parameters<typeof cb>[0]) => cb(state)
      ipcRenderer.on("codary-auth:changed", handler)
      return () => ipcRenderer.removeListener("codary-auth:changed", handler)
    },
  },
}`],
])
edit('packages/desktop/src/main/index.ts', [
  ['import { checkAppExists, resolveAppPath } from "./apps"\n', 'import { checkAppExists, resolveAppPath } from "./apps"\nimport { codaryAuthPoke, codarySetServer, registerCodaryAuth } from "./codary-auth"\n'],
  ['function emitDeepLinks(urls: string[]) {\n  if (urls.length === 0) return\n', 'function emitDeepLinks(urls: string[]) {\n  if (urls.length === 0) return\n  if (urls.some((url) => url.startsWith("codary-code://auth"))) codaryAuthPoke()\n'],
  ['  registerWslIpcHandlers(wslServers)\n', '  registerWslIpcHandlers(wslServers)\n  registerCodaryAuth()\n'],
  ['    server = listener\n    yield* Deferred.succeed(serverReady, {\n      url,\n      username: "opencode",\n      password,\n    })\n', '    server = listener\n    codarySetServer({ url, username: "opencode", password })\n    yield* Deferred.succeed(serverReady, {\n      url,\n      username: "opencode",\n      password,\n    })\n'],
])
edit('packages/desktop/src/renderer/index.tsx', [
  ['import { initializationData } from "./initialization"\n', 'import { initializationData } from "./initialization"\nimport { CodaryLoginGate } from "./codary-login"\n'],
  ['            <AppInterface\n              defaultServer={key}', '            <CodaryLoginGate>\n            <AppInterface\n              defaultServer={key}'],
  ['              <Inner />\n            </AppInterface>', '              <Inner />\n            </AppInterface>\n            </CodaryLoginGate>'],
])

// ---------------------------------------------------------------- свои провайдеры отключены (приложение со входом: аккаунт Codary — единственный источник моделей)
// Сервер и так отдаёт только провайдера codary (плагин plugins/codary/account.ts); здесь убираем из интерфейса всё, что предлагает подключить свой.
const NO_OWN_PROVIDERS = 'Модели подключены через ваш аккаунт Codary и обновляются сами. Свои провайдеры и ключи в Codary Code подключить нельзя.'
edit('packages/app/src/components/dialog-connect-provider.tsx', [
  ['export const DialogConnectProvider: Component<{', 'export const DialogConnectProviderOriginal: Component<{'],
])
{
  const f = p('packages/app/src/components/dialog-connect-provider.tsx')
  writeFileSync(f, readFileSync(f, 'utf8') + `
// Патч Codary: подключение своих провайдеров отключено, вместо окна подключения — пояснение
export const DialogConnectProvider: Component<{
  directory?: Accessor<string | undefined>
  controller?: ReturnType<typeof useProviderConnectController>
}> = () => {
  const dialog = useDialog()
  return (
    <Dialog title="Codary Code">
      <div class="flex flex-col gap-4 px-6 pb-6">
        <div class="text-14-regular text-text-base">${NO_OWN_PROVIDERS}</div>
        <Button onClick={() => dialog.close()}>Понятно</Button>
      </div>
    </Dialog>
  )
}
`)
}
edit('packages/app/src/components/dialog-custom-provider.tsx', [
  ['export function DialogCustomProvider(props: Props) {', 'export function DialogCustomProviderOriginal(props: Props) {'],
])
{
  const f = p('packages/app/src/components/dialog-custom-provider.tsx')
  writeFileSync(f, readFileSync(f, 'utf8') + `
// Патч Codary: свой провайдер добавить нельзя
export function DialogCustomProvider(props: Props) {
  return (
    <Dialog title="Codary Code">
      <div class="flex flex-col gap-4 px-6 pb-6">
        <div class="text-14-regular text-text-base">${NO_OWN_PROVIDERS}</div>
        <Button onClick={props.onBack}>Понятно</Button>
      </div>
    </Dialog>
  )
}
`)
}
edit('packages/app/src/components/settings-providers.tsx', [
  ['export const SettingsProviders: Component<{ onBack?: () => void }> = (props) => {', 'export const SettingsProvidersOriginal: Component<{ onBack?: () => void }> = (props) => {'],
])
edit('packages/app/src/components/settings-v2/providers.tsx', [
  ['export const SettingsProvidersV2: Component<{\n  directory: Accessor<string | undefined>\n  onBack?: () => void\n}> = (props) => {', 'export const SettingsProvidersV2Original: Component<{\n  directory: Accessor<string | undefined>\n  onBack?: () => void\n}> = (props) => {'],
])
for (const [file, name, props] of [
  ['packages/app/src/components/settings-providers.tsx', 'SettingsProviders', '{ onBack?: () => void }'],
  ['packages/app/src/components/settings-v2/providers.tsx', 'SettingsProvidersV2', '{ directory: Accessor<string | undefined>; onBack?: () => void }'],
]) {
  const f = p(file)
  writeFileSync(f, readFileSync(f, 'utf8') + `
// Патч Codary: вместо списка провайдеров — пояснение
export const ${name}: Component<${props}> = () => (
  <div class="flex flex-col gap-3 p-6">
    <div class="text-16-medium text-text-strong">Модели Codary</div>
    <div class="text-14-regular text-text-base">${NO_OWN_PROVIDERS}</div>
  </div>
)
`)
}
edit('packages/app/src/pages/layout.tsx', [
  ['      {\n        id: "provider.connect",\n        title: language.t("command.provider.connect"),\n        category: language.t("command.category.provider"),\n        onSelect: () => connectProvider(),\n      },\n', ''],
])
edit('packages/app/src/components/dialog-select-model.tsx', [
  ['                <Tooltip placement="top" value={language.t("command.provider.connect")}>\n                  <IconButton\n                    icon="plus-small"\n                    variant="ghost"\n                    iconSize="normal"\n                    class="size-6"\n                    aria-label={language.t("command.provider.connect")}\n                    onClick={handleConnectProvider}\n                  />\n                </Tooltip>\n', ''],
  ['      action={\n        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>\n          {language.t("command.provider.connect")}\n        </Button>\n      }\n', ''],
])
edit('packages/app/src/components/dialog-manage-models.tsx', [
  ['      action={\n        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={handleConnectProvider}>\n          {language.t("command.provider.connect")}\n        </Button>\n      }\n', ''],
  ['        <ButtonV2 variant="neutral" icon="plus" onClick={handleConnectProvider}>\n          {language.t("command.provider.connect")}\n        </ButtonV2>\n', ''],
])

// ---------------------------------------------------------------- стартовые подсказки на пустом экране нового сеанса, уведомления об ошибках по умолчанию
copyFileSync(join(BRAND, 'desktop', 'codary-starters.tsx'), p('packages/app/src/components/codary-starters.tsx'))
edit('packages/app/src/pages/new-session/new-session-view.tsx', [
  ['import { PromptInputV2Composer } from "@/components/prompt-input-v2"\n', 'import { PromptInputV2Composer } from "@/components/prompt-input-v2"\nimport { CodaryStarters } from "@/components/codary-starters"\n'],
  ['              <PromptInputV2Composer controller={props.input} />\n', '              <PromptInputV2Composer controller={props.input} />\n              <CodaryStarters onDone={props.input.restoreFocus} />\n'],
])
edit('packages/app/src/context/settings.tsx', [['    permissions: true,\n    errors: false,\n  },', '    permissions: true,\n    errors: true,\n  },']])

// ---------------------------------------------------------------- группы чатов на главном экране (brand/desktop/codary-groups.tsx)
copyFileSync(join(BRAND, 'desktop', 'codary-groups.tsx'), p('packages/app/src/components/codary-groups.tsx'))
edit('packages/app/src/pages/home/home-sessions-view.tsx', [
  ['import { type Accessor, createMemo, For, Show, Suspense } from "solid-js"\n',
   'import { type Accessor, createEffect, createMemo, For, Show, Suspense } from "solid-js"\nimport { CodaryEmptyGroup, CodaryGroupBar, CodaryRowBadge, CodaryRowMenu, codaryFilter, codaryNoteCreate, codaryTrack } from "@/components/codary-groups"\n'],
  ['export function HomeSessionsView(props: HomeSessionsViewProps) {\n  return (\n',
   'export function HomeSessionsView(props: HomeSessionsViewProps) {\n  const shown = createMemo(() => codaryFilter(props.groups()))\n  createEffect(() => codaryTrack(props.groups()))\n  return (\n'],
  ['                onClick={props.onCreateSession}\n              >\n                {props.language.t("command.session.new")}',
   '                onClick={() => {\n                  codaryNoteCreate(props.groups())\n                  props.onCreateSession()\n                }}\n              >\n                {props.language.t("command.session.new")}'],
  ['      <div class="-mr-3 min-h-[calc(100cqh-72px)] lg:min-h-[calc(100cqh-96px)]">\n        <Suspense\n',
   '      <div class="-mr-3 min-h-[calc(100cqh-72px)] lg:min-h-[calc(100cqh-96px)]">\n        <CodaryGroupBar />\n        <Suspense\n'],
  ['            <div ref={props.onSetContent} class="flex flex-col pt-3 pr-3 pb-16">\n              <For each={props.groups()}>',
   '            <div ref={props.onSetContent} class="flex flex-col pt-3 pr-3 pb-16">\n              <Show when={shown().length === 0}>\n                <CodaryEmptyGroup />\n              </Show>\n              <For each={shown()}>'],
  ['index() === props.groups().length - 1 ? "" : "mb-6"', 'index() === shown().length - 1 ? "" : "mb-6"'],
  ['        <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} />\n',
   '        <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} />\n        <CodaryRowBadge sessionID={props.record.session.id} />\n'],
  ['      <Show when={SHOW_HOME_SESSION_ARCHIVE}>\n        <div\n          class={`\n            hover-reveal absolute right-1.5',
   '      <CodaryRowMenu sessionID={props.record.session.id} />\n      <Show when={SHOW_HOME_SESSION_ARCHIVE}>\n        <div\n          class={`\n            hover-reveal absolute right-1.5'],
])

// ---------------------------------------------------------------- переводы: «OpenCode» -> «Codary Code» (только в словарях строк)
{
  const dirs = ['packages/app/src/i18n', 'packages/ui/src/i18n', 'packages/desktop/src/renderer/i18n']
  const files = dirs.flatMap((d) => (existsSync(p(d)) ? readdirSync(p(d)).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => join(d, f)) : []))
  files.push('packages/desktop/src/main/native-translations.ts')
  const re = /(?<![A-Za-z0-9_\/.@-])OpenCode(?![A-Za-z0-9_])/g
  let n = 0
  for (const f of files) {
    const t = readFileSync(p(f), 'utf8'); const out = t.replace(re, () => (n++, NAME))
    if (out !== t) writeFileSync(p(f), out)
  }
  console.log(`✓ переводы: ${files.length} файлов, заменено ${n}`)
  if (n < 100) { console.error('✗ слишком мало замен в переводах — структура i18n изменилась?'); failed++ }
}

// ---------------------------------------------------------------- значки и картинки
{
  const dest = p('packages/desktop/icons/prod')
  rmSync(dest, { recursive: true, force: true })
  copyDir(join(BRAND, 'icons'), dest)
  for (const f of ['apple-touch-icon.png', 'favicon-96x96.png', 'favicon.ico', 'favicon.svg', 'web-app-manifest-192x192.png', 'web-app-manifest-512x512.png']) {
    copyFileSync(join(BRAND, 'web', f), p('packages/app/public', f))
    const v3 = f.replace(/(\.\w+)$/, '-v3$1')   // файлы с суффиксом -v3 тоже подключены из index.html
    if (existsSync(p('packages/app/public', v3))) copyFileSync(join(BRAND, 'web', f), p('packages/app/public', v3))
  }
  console.log('✓ значки и favicon')
}

if (failed) { console.error(`\n${failed} правок не применилось`); process.exit(1) }
console.log('\nВсе правки применены.')
