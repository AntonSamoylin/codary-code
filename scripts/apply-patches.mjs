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
// сервер внутри приложения: без рекламных провайдеров OpenCode (Zen/Go), автообновления CLI и публикации сессий на opencode.ai
edit('packages/desktop/src/main/server.ts', [[
  '    OPENCODE_CLIENT: "desktop",\n',
  '    OPENCODE_CLIENT: "desktop",\n    OPENCODE_DISABLE_AUTOUPDATE: "true",\n' +
  '    OPENCODE_CONFIG_CONTENT: JSON.stringify({ disabled_providers: ["opencode", "opencode-go"], autoupdate: false, share: "disabled" }),\n',
]])

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
