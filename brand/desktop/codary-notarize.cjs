// Хук afterSign для electron-builder: нотаризация приложения в Apple (notarytool) и «подшивание» билета (stapler).
// Подключается скриптом apply-patches.mjs только при CODARY_SIGN=1. Учётные данные берутся из профиля связки ключей (`xcrun notarytool store-credentials`),
// в окружение и в аргументы команд пароль не попадает. Имя профиля: CODARY_NOTARY_PROFILE (по умолчанию codary-notary).
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")

function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … завершилась с кодом ${r.status}\n${r.stderr || r.stdout}`)
  return r
}

exports.default = async function notarizeHook(context) {
  if (context.electronPlatformName !== "darwin" || process.env.CODARY_SIGN !== "1") return
  const profile = process.env.CODARY_NOTARY_PROFILE || "codary-notary"
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // 1) без подписи Developer ID и hardened runtime Apple нотаризацию не примет: говорим об этом сразу и понятно, а не через 10 минут
  const sig = run("codesign", ["-dvv", app], { allowFail: true })
  const text = `${sig.stderr}${sig.stdout}`
  if (!/Authority=Developer ID Application:/.test(text)) {
    throw new Error(`Приложение не подписано сертификатом «Developer ID Application» (подпись: ${/Signature=adhoc/.test(text) ? "ad-hoc" : "нет или другая"}). Запустите scripts/sign-check.sh и установите сертификат.`)
  }
  if (!/flags=0x[0-9a-f]+\(.*runtime.*\)/.test(text)) throw new Error("В подписи нет hardened runtime (flags=…runtime): нотаризация не пройдёт. Проверьте hardenedRuntime в electron-builder.config.ts.")

  // 2) отправка и ожидание результата
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codary-notary-")), "app.zip")
  run("ditto", ["-c", "-k", "--keepParent", app, zip])
  console.log(`  • нотаризация: отправляю в Apple (профиль «${profile}»), обычно 2–15 минут…`)
  const submit = run("xcrun", ["notarytool", "submit", zip, "--keychain-profile", profile, "--wait", "--output-format", "json"], { allowFail: true })
  let result = {}
  try {
    result = JSON.parse(submit.stdout)
  } catch {}
  if (result.status !== "Accepted") {
    const log = result.id ? run("xcrun", ["notarytool", "log", result.id, "--keychain-profile", profile], { allowFail: true }).stdout : ""
    throw new Error(`Нотаризация не принята (статус: ${result.status ?? "неизвестен"}).\n${submit.stderr}\n${log}`.trim())
  }
  fs.rmSync(path.dirname(zip), { recursive: true, force: true })

  // 3) билет внутрь приложения: тогда оно открывается и без сети
  run("xcrun", ["stapler", "staple", app])
  run("xcrun", ["stapler", "validate", app])
  console.log("  • нотаризация принята, билет подшит")
}
