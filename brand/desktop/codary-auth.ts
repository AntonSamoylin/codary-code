// Вход в Codary Code через сайт и токен устройства (патч Codary).
// Приложение держит секрет (verifier), на сайт отдаёт только его хэш (challenge); клиент входит на codary.ru и подтверждает устройство;
// приложение меняет секрет на токен устройства у шлюза (/v1/app/exchange). Токен хранится зашифрованным (safeStorage) и передаётся
// встроенному серверу как ключ провайдера «codary». Своих провайдеров пользователь не подключает: единственный источник моделей — аккаунт Codary.
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron"

import type { CodaryAuthState } from "../preload/types"
import { write as writeLog } from "./logging"

// Окно входа закрывает интерфейс, пока нет аккаунта. Включается при сборке (brand/features.json: requireLogin) или переменной CODARY_LOGIN=1.
const BUILD_REQUIRES_LOGIN: boolean = /*REQUIRE_LOGIN*/ false
const ENABLED = process.env.CODARY_LOGIN ? process.env.CODARY_LOGIN === "1" : BUILD_REQUIRES_LOGIN
const API = (process.env.CODARY_API_URL ?? "https://api.codary.ru").replace(/\/+$/, "")
const SITE = (process.env.CODARY_SITE_URL ?? "https://codary.ru").replace(/\/+$/, "")
const PROVIDER_ID = "codary"
const FLOW_TTL = 14 * 60_000
const POLL_MS = 2_000
const ACCOUNT_REFRESH_MS = 5 * 60_000

type Flow = { verifier: string; code: string; url: string; deadline: number; timer: NodeJS.Timeout; busy: boolean }
type ServerInfo = { url: string; username: string; password: string }

let token: string | null = null
let flow: Flow | null = null
let message: string | undefined
let account: CodaryAuthState["account"]
let server: ServerInfo | null = null
let refreshTimer: NodeJS.Timeout | undefined

const platformName = () => (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux")
const clientHeaders = () => ({ "X-Codary-Platform": platformName(), "X-Codary-Version": app.getVersion() })
const tokenFile = () => join(app.getPath("userData"), "codary-auth.bin")
const log = (text: string, meta?: Record<string, unknown>, level: "info" | "warn" | "error" = "info") => writeLog("codary-auth", text, meta, level)

function readToken(): string | null {
  try {
    const file = tokenFile()
    if (!existsSync(file)) return null
    const raw = readFileSync(file)
    if (raw.subarray(0, 6).toString() === "plain:") return raw.subarray(6).toString("utf8") || null
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : null
  } catch (error) {
    log("не удалось прочитать токен", { error: String(error) }, "warn")
    return null
  }
}

function saveToken(value: string) {
  const file = tokenFile()
  // Без связки ключей ОС (бывает на Linux) шифровать нечем: файл остаётся с правами только для владельца
  writeFileSync(file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from("plain:" + value))
  try {
    chmodSync(file, 0o600)
  } catch {}
}

export function codaryAuthSnapshot(): CodaryAuthState {
  return {
    enabled: ENABLED,
    state: token ? "in" : flow ? "waiting" : "out",
    code: flow?.code,
    message,
    account,
  }
}

function broadcast() {
  const snapshot = codaryAuthSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("codary-auth:changed", snapshot)
  }
}

async function serverCall(method: "PUT" | "DELETE") {
  if (!server) return
  const headers: Record<string, string> = {
    Authorization: "Basic " + Buffer.from(`${server.username}:${server.password}`).toString("base64"),
    "Content-Type": "application/json",
  }
  try {
    const response = await fetch(`${server.url}/auth/${PROVIDER_ID}`, {
      method,
      headers,
      body: method === "PUT" ? JSON.stringify({ type: "api", key: token }) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) log("сервер не принял токен", { method, status: response.status }, "warn")
  } catch (error) {
    log("не удалось передать токен серверу", { method, error: String(error) }, "warn")
  }
}

function startRefreshing() {
  clearInterval(refreshTimer)
  refreshTimer = setInterval(() => void refreshAccount(), ACCOUNT_REFRESH_MS)
  refreshTimer.unref()
  void refreshAccount()
}

/** Состояние аккаунта у шлюза: включён ли, баланс. 401 значит, что устройство отключено (в кабинете или администратором). */
export async function refreshAccount() {
  if (!token) return
  try {
    const response = await fetch(`${API}/v1/me`, { headers: { Authorization: `Bearer ${token}`, ...clientHeaders() }, signal: AbortSignal.timeout(15_000) })
    if (response.status === 401) return void (await clearLocal("Это устройство отключено. Войдите снова."))
    if (!response.ok) return
    const data = (await response.json()) as { status?: string; balance_rub?: number }
    account = { status: String(data.status ?? "active"), balanceRub: Number(data.balance_rub ?? 0) }
    broadcast()
  } catch {
    // нет сети: оставляем прежнее состояние
  }
}

async function clearLocal(reason?: string) {
  token = null
  account = undefined
  message = reason
  clearInterval(refreshTimer)
  rmSync(tokenFile(), { force: true })
  await serverCall("DELETE")
  broadcast()
}

function stopFlow(reason?: string) {
  if (flow) clearInterval(flow.timer)
  flow = null
  message = reason
  broadcast()
}

async function poll() {
  const current = flow
  if (!current || current.busy) return
  if (Date.now() > current.deadline) return stopFlow("Время входа истекло. Нажмите «Войти» ещё раз.")
  current.busy = true
  try {
    const response = await fetch(`${API}/v1/app/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clientHeaders() },
      body: JSON.stringify({ verifier: current.verifier }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await response.json()) as { status?: string; token?: string; account?: { status: string; balance_rub: number } }
    if (flow !== current) return
    if (data.status === "ok" && data.token) {
      token = data.token
      saveToken(token)
      stopFlow()
      message = undefined
      account = data.account ? { status: data.account.status, balanceRub: data.account.balance_rub } : undefined
      await serverCall("PUT")
      startRefreshing()
      broadcast()
      log("вход выполнен")
    } else if (data.status === "denied") stopFlow("Вход отменён на сайте.")
    else if (data.status === "expired") stopFlow("Время входа истекло. Нажмите «Войти» ещё раз.")
    else if (data.status === "used") stopFlow("Эта ссылка входа уже использована. Нажмите «Войти» ещё раз.")
  } catch {
    // нет сети или шлюз недоступен: пробуем на следующем шаге
  } finally {
    current.busy = false
  }
}

/** Начать вход (или заново открыть страницу входа, если он уже идёт). Возвращает состояние с кодом устройства. */
export function codaryLogin(): CodaryAuthState {
  if (token) return codaryAuthSnapshot()
  if (!flow) {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("hex")
    const query = new URLSearchParams({ c: challenge, p: platformName(), v: app.getVersion(), n: hostname().slice(0, 60) })
    flow = {
      verifier,
      code: challenge.slice(0, 4).toUpperCase(),
      url: `${SITE}/code-login.php?${query}`,
      deadline: Date.now() + FLOW_TTL,
      timer: setInterval(() => void poll(), POLL_MS),
      busy: false,
    }
    message = undefined
    log("открыта страница входа", { url: flow.url })   // в ссылке только хэш секрета, не сам секрет
  }
  void shell.openExternal(flow.url)
  broadcast()
  return codaryAuthSnapshot()
}

export function codaryCancel(): CodaryAuthState {
  stopFlow()
  return codaryAuthSnapshot()
}

export async function codaryLogout(): Promise<CodaryAuthState> {
  const old = token
  stopFlow()
  if (old) {
    await fetch(`${API}/v1/app/logout`, { method: "POST", headers: { Authorization: `Bearer ${old}`, ...clientHeaders() }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  }
  await clearLocal()
  return codaryAuthSnapshot()
}

/** Ссылка codary-code://auth от страницы подтверждения: проверяем вход сразу, не дожидаясь очередного опроса. */
export function codaryAuthPoke() {
  void poll()
}

/** Встроенный сервер готов: передаём ему токен (он хранит его как ключ провайдера «codary»). */
export function codarySetServer(info: ServerInfo) {
  server = info
  if (token) void serverCall("PUT")
}

export function registerCodaryAuth() {
  token = readToken()
  if (token) startRefreshing()
  ipcMain.handle("codary-auth:status", () => codaryAuthSnapshot())
  ipcMain.handle("codary-auth:login", () => codaryLogin())
  ipcMain.handle("codary-auth:cancel", () => codaryCancel())
  ipcMain.handle("codary-auth:logout", () => codaryLogout())
  ipcMain.handle("codary-auth:devices", () => void shell.openExternal(`${SITE}/code-login.php`))
  app.once("will-quit", () => {
    clearInterval(refreshTimer)
    if (flow) clearInterval(flow.timer)
  })
}
