// Единственный провайдер Codary Code — «codary» (аккаунт Codary). Работает, когда включён CODARY_RESTRICT_PROVIDERS=1 (приложение со входом, облако):
//  * модели берутся из шлюза (GET /v1/models с токеном устройства из auth.json), а не из каталога: добавил модель в админке — появилась у всех;
//  * свои провайдеры отключены: enabled_providers = ["codary"], провайдеры из пользовательской конфигурации отбрасываются.
// Хук config выполняется при каждой загрузке конфигурации сервера (старт, вход, выход), поэтому список обновляется сам.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Global } from "@opencode-ai/core/global"

const PROVIDER_ID = "codary"
const CACHE_MS = 60_000

type Card = {
  id?: string
  name?: string
  type?: string
  vision?: boolean
  context_length?: number | null
  max_output?: number | null
}
let cache: { token: string; at: number; models: Record<string, unknown>; first?: string } | undefined

const apiBase = () => (process.env.CODARY_API_URL ?? "https://api.codary.ru").replace(/\/+$/, "")
const platform = () => process.env.CODARY_APP_PLATFORM ?? (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux")
const clientHeaders = (): Record<string, string> => ({
  "X-Codary-Platform": platform(),
  ...(process.env.CODARY_APP_VERSION ? { "X-Codary-Version": process.env.CODARY_APP_VERSION } : {}),
})

async function readToken(): Promise<string | undefined> {
  try {
    const auth = JSON.parse(await readFile(join(Global.Path.data, "auth.json"), "utf8"))?.[PROVIDER_ID]
    return auth?.type === "api" && typeof auth.key === "string" && auth.key ? auth.key : undefined
  } catch {
    return undefined
  }
}

function toModel(card: Card) {
  const vision = !!card.vision
  return {
    name: card.name ?? card.id,
    tool_call: true,
    temperature: true,
    attachment: vision,
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: card.context_length ?? 128000, output: card.max_output ?? 16384 },
  }
}

/** Список моделей аккаунта у шлюза. При сбое сети остаётся последний удачный. */
async function loadModels(token: string) {
  if (cache && cache.token === token && Date.now() - cache.at < CACHE_MS) return cache
  try {
    const response = await fetch(`${apiBase()}/v1/models`, {
      headers: { Authorization: `Bearer ${token}`, ...clientHeaders() },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return cache?.token === token ? cache : undefined
    const data = (await response.json()) as { data?: Card[] }
    const models: Record<string, unknown> = {}
    let first: string | undefined
    for (const card of data.data ?? []) {
      if (!card.id || card.type === "image") continue // картинки — не модели чата
      models[card.id] = toModel(card)
      first ??= card.id
    }
    cache = { token, at: Date.now(), models, first }
    return cache
  } catch {
    return cache?.token === token ? cache : undefined
  }
}

export async function codaryConfig(config: any) {
  if (process.env.CODARY_RESTRICT_PROVIDERS !== "1") return
  config.enabled_providers = [PROVIDER_ID]
  const token = await readToken()
  const loaded = token ? await loadModels(token) : undefined
  config.provider = {
    [PROVIDER_ID]: {
      name: "Codary",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${apiBase()}/v1`, headers: clientHeaders() },
      models: loaded?.models ?? {},
    },
  }
  // Модель по умолчанию — первая в списке администратора, если в конфигурации нет модели Codary (своя модель чужого провайдера не работает)
  const current = typeof config.model === "string" ? config.model : ""
  const valid = current.startsWith(`${PROVIDER_ID}/`) && !!loaded?.models[current.slice(PROVIDER_ID.length + 1)]
  if (!valid) config.model = loaded?.first ? `${PROVIDER_ID}/${loaded.first}` : undefined
  if (typeof config.small_model === "string" && !config.small_model.startsWith(`${PROVIDER_ID}/`)) config.small_model = undefined
}
