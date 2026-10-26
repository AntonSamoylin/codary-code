// Общее состояние плагина Codary: плагин создаётся заново для каждой открытой папки проекта, а планировщик и Telegram
// должны быть одни на весь сервер, поэтому всё общее живёт на уровне модуля.
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { ServerAuth } from "@/server/auth"

export type BusEvent = { type: string; properties: any; directory?: string }

export const shared = {
  started: false,
  /** Папка первого открытого проекта: запасной вариант, если у чата в Telegram не выбрана своя */
  defaultDirectory: "",
  sessionDirs: new Map<string, string>(),
  autoApprove: new Set<string>(),
  listeners: new Set<(event: BusEvent) => void>(),
}

export function log(...args: unknown[]) {
  if (process.env.CODARY_DEBUG) console.error("[codary]", ...args)
}

export async function clientFor(directory: string): Promise<OpencodeClient> {
  const { Server } = await import("@/server/server")
  const serverUrl = Server.url
  return createOpencodeClient({
    baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
    directory,
    headers: ServerAuth.headers(),
    ...(serverUrl ? {} : { fetch: async (req: Request) => Server.Default().app.fetch(req) }),
  } as any)
}

export function emit(event: BusEvent) {
  for (const fn of shared.listeners) {
    try {
      fn(event)
    } catch (e) {
      log("listener failed", e)
    }
  }
}

// таймеры «неудерживающие»: если больше ничего не работает (например, разовый запуск из консоли), процесс спокойно завершается
export const sleep = (ms: number) => new Promise<void>((r) => void setTimeout(r, ms).unref?.())

export function textOf(parts: any[] | undefined): string {
  return (parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
    .trim()
}

export type RunResult = { status: "ok" | "error" | "timeout"; text: string }

/**
 * Отправляет сообщение в сеанс, ждёт, пока агент закончит, и возвращает его последний ответ.
 * Работает через события, а не через долгий запрос: так не мешают тайм-ауты соединений.
 */
export async function runSession(input: {
  directory: string
  sessionID: string
  text: string
  agent: string
  timeoutMs: number
  model?: { providerID: string; modelID: string }
}): Promise<RunResult> {
  const client = await clientFor(input.directory)
  shared.sessionDirs.set(input.sessionID, input.directory)

  let busySeen = false
  let finish!: (r: { status: "ok" | "error" | "timeout"; error?: string }) => void
  const done = new Promise<{ status: "ok" | "error" | "timeout"; error?: string }>((r) => (finish = r))
  const listener = (event: BusEvent) => {
    const p = event.properties
    if (p?.sessionID !== input.sessionID) return
    if (event.type === "session.status") {
      if (p.status?.type === "busy") busySeen = true
      else if (p.status?.type === "idle" && busySeen) finish({ status: "ok" })
    } else if (event.type === "session.error") {
      const msg = p.error?.data?.message ?? p.error?.message ?? "ошибка агента"
      finish({ status: "error", error: String(msg) })
    }
  }
  shared.listeners.add(listener)
  const started = Date.now()
  // запасной путь: раз в 10 секунд сверяемся со списком состояний, вдруг событие пропущено
  const poll = setInterval(async () => {
    try {
      const res: any = await client.session.status({ directory: input.directory })
      const st = res?.data?.[input.sessionID]
      if (st?.type === "busy") busySeen = true
      if ((!st || st.type === "idle") && (busySeen || Date.now() - started > 25_000)) finish({ status: "ok" })
    } catch {}
  }, 10_000)
  const timer = setTimeout(() => finish({ status: "timeout" }), input.timeoutMs)

  try {
    const sent: any = await client.session.promptAsync({
      sessionID: input.sessionID,
      directory: input.directory,
      agent: input.agent,
      ...(input.model ? { model: input.model } : {}),
      parts: [{ type: "text", text: input.text }],
    })
    if (sent?.error) return { status: "error", text: `Не удалось отправить запрос: ${JSON.stringify(sent.error).slice(0, 300)}` }
    const outcome = await done
    if (outcome.status === "timeout") await client.session.abort({ sessionID: input.sessionID, directory: input.directory }).catch(() => {})
    let text = ""
    try {
      const msgs: any = await client.session.messages({ sessionID: input.sessionID, directory: input.directory })
      const list: any[] = msgs?.data ?? []
      for (let i = list.length - 1; i >= 0 && !text; i--) if (list[i]?.info?.role === "assistant") text = textOf(list[i].parts)
      const err = [...list].reverse().find((m) => m?.info?.role === "assistant" && m.info.error)?.info?.error
      if (!text && err) return { status: "error", text: String(err?.data?.message ?? err?.name ?? "ошибка модели") }
    } catch (e) {
      log("messages failed", e)
    }
    if (outcome.status === "error") return { status: "error", text: outcome.error ?? text }
    return { status: outcome.status, text }
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    shared.listeners.delete(listener)
  }
}
