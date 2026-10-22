// Управление агентом из Telegram. Бот — ваш собственный (токен из BotFather лежит у вас на компьютере в codary.json),
// запросы идут напрямую с компьютера в Telegram, наших серверов в цепочке нет. Работает, пока запущено приложение.
// Доступ только у Telegram ID из списка allowed; чужим бот отвечает лишь их ID.
import { fmt } from "./time"
import { loadSchedules, loadTelegram, type TelegramConfig } from "./store"
import { clientFor, log, runSession, shared, sleep, type BusEvent } from "./shared"
import { hooks } from "./scheduler"

const API_BASE = () => process.env.CODARY_TELEGRAM_API ?? "https://api.telegram.org"
const PROMPT_TIMEOUT_MS = 60 * 60_000
const PERMISSION_TIMEOUT_MS = 10 * 60_000

type Chat = { directory?: string; sessionID?: string; busy: boolean; queue: string[]; projects: string[]; deniedAt?: number }
type Pending = { sessionID: string; directory: string; chatId: number; messageId?: number; timer: ReturnType<typeof setTimeout> }

const chats = new Map<number, Chat>()
const chatBySession = new Map<string, number>()
const pending = new Map<string, Pending>()
let cfg: TelegramConfig | undefined

const chatOf = (id: number): Chat => {
  let c = chats.get(id)
  if (!c) chats.set(id, (c = { busy: false, queue: [], projects: [] }))
  return c
}

async function api(method: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
  if (!cfg) throw new Error("Telegram не настроен")
  const res = await fetch(`${API_BASE()}/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`)
  return json.result
}

async function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  const chunks: string[] = []
  for (let rest = text || "(пусто)"; rest.length; ) {
    chunks.push(rest.slice(0, 3900))
    rest = rest.slice(3900)
  }
  let last: any
  for (const [i, chunk] of chunks.entries()) last = await api("sendMessage", { chat_id: chatId, text: chunk, ...(i === chunks.length - 1 ? extra : {}) })
  return last
}

const HELP = [
  "Codary Code на связи. Просто напишите задачу, и агент выполнит её на компьютере.",
  "",
  "/new — начать новый разговор",
  "/stop — остановить текущую задачу",
  "/projects — выбрать проект, /use N — переключиться",
  "/schedules — задачи по расписанию",
  "/status — где работает агент",
  "/id — ваш Telegram ID",
].join("\n")

export function startTelegram() {
  shared.listeners.add((event) => void onEvent(event))
  hooks.notify = async (text) => {
    cfg = (await loadTelegram()) ?? cfg
    if (!cfg?.allowed.length) return
    for (const id of cfg.allowed) await send(id, text).catch((e) => log("notify send failed", e))
  }
  void loop()
}

async function loop() {
  let offset = 0
  let token = ""
  let backoff = 0
  for (;;) {
    cfg = await loadTelegram()
    if (!cfg) {
      token = ""
      await sleep(15_000)
      continue
    }
    if (cfg.token !== token) {
      token = cfg.token
      offset = 0
      try {
        await api("deleteWebhook")
        log("telegram bot ready", (await api("getMe")).username)
      } catch (e) {
        log("telegram init failed", e)
        token = ""
        await sleep(30_000)
        continue
      }
    }
    try {
      const updates: any[] = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 45_000)
      backoff = 0
      for (const u of updates) {
        offset = u.update_id + 1
        void handle(u).catch((e) => log("telegram handler failed", e))
      }
    } catch (e) {
      backoff = Math.min(60_000, (backoff || 2_000) * 2)
      log("telegram poll failed", e)
      await sleep(backoff)
    }
  }
}

async function handle(u: any) {
  if (u.callback_query) return handleCallback(u.callback_query)
  const m = u.message
  if (!m?.text || m.chat?.type !== "private") return
  const chatId: number = m.chat.id
  const userId: number = m.from?.id
  const text: string = m.text.trim()
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : ""
  const allowed = !!cfg?.allowed.includes(userId)

  if (cmd === "/id" || cmd === "/start" || !allowed) {
    if (allowed && cmd === "/start") return void (await send(chatId, HELP))
    const chat = chatOf(chatId)
    if (!allowed && cmd !== "/id" && cmd !== "/start" && chat.deniedAt && Date.now() - chat.deniedAt < 10 * 60_000) return
    chat.deniedAt = Date.now()
    return void (await send(
      chatId,
      allowed
        ? `Ваш Telegram ID: ${userId}. Доступ открыт.`
        : `Ваш Telegram ID: ${userId}.\nЧтобы управлять агентом, добавьте его в файл codary.json на компьютере (поле telegram.allowed) и повторите сообщение.`,
    ))
  }

  const chat = chatOf(chatId)
  switch (cmd) {
    case "/help":
      return void (await send(chatId, HELP))
    case "/new":
      chat.sessionID = undefined
      return void (await send(chatId, "Новый разговор начат."))
    case "/stop": {
      if (!chat.sessionID || !chat.busy) return void (await send(chatId, "Сейчас ничего не выполняется."))
      const dir = shared.sessionDirs.get(chat.sessionID) ?? shared.defaultDirectory
      await (await clientFor(dir)).session.abort({ sessionID: chat.sessionID, directory: dir } as any)
      chat.queue.length = 0
      return void (await send(chatId, "Останавливаю задачу."))
    }
    case "/projects": {
      const client = await clientFor(shared.defaultDirectory)
      const res: any = await client.project.list({ directory: shared.defaultDirectory } as any)
      const dirs: string[] = (res?.data ?? []).map((p: any) => p.worktree).filter((w: string) => w && w !== "/").slice(0, 10)
      chat.projects = dirs
      return void (await send(chatId, dirs.length ? "Проекты:\n" + dirs.map((d, i) => `${i + 1}. ${d}`).join("\n") + "\n\nПереключиться: /use N" : "Проектов пока нет: откройте папку в приложении."))
    }
    case "/use": {
      const n = Number(text.split(/\s+/)[1])
      const dir = chat.projects[n - 1]
      if (!dir) return void (await send(chatId, "Сначала /projects, затем /use N с номером из списка."))
      chat.directory = dir
      chat.sessionID = undefined
      return void (await send(chatId, `Работаю в папке: ${dir}`))
    }
    case "/schedules": {
      const list = await loadSchedules()
      return void (await send(chatId, list.length ? list.map((s) => `${s.enabled ? "▶" : "⏸"} ${s.name} — следующий запуск ${fmt(s.nextRun)}`).join("\n") : "Задач по расписанию нет. Попросите агента создать: «каждый день в 9:00 проверяй тесты»."))
    }
    case "/status":
      return void (await send(chatId, `Папка: ${chat.directory ?? shared.defaultDirectory}\nСеанс: ${chat.sessionID ?? "новый"}\n${chat.busy ? "Агент работает." : "Агент свободен."}`))
    default:
      if (cmd) return void (await send(chatId, "Не знаю такой команды.\n\n" + HELP))
      return void (await ask(chatId, text))
  }
}

async function ask(chatId: number, text: string) {
  const chat = chatOf(chatId)
  if (chat.busy) {
    chat.queue.push(text)
    return void (await send(chatId, "⏳ Предыдущая задача ещё выполняется, ваш запрос стоит в очереди."))
  }
  chat.busy = true
  try {
    for (let next: string | undefined = text; next !== undefined; next = chat.queue.shift()) await runOne(chatId, chat, next)
  } finally {
    chat.busy = false
  }
}

async function runOne(chatId: number, chat: Chat, text: string) {
  const directory = chat.directory ?? shared.defaultDirectory
  const typing = setInterval(() => void api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4_000)
  try {
    const client = await clientFor(directory)
    if (!chat.sessionID) {
      const created: any = await client.session.create({ directory, title: `📱 Telegram — ${fmt(Date.now())}` } as any)
      chat.sessionID = created?.data?.id
      if (!chat.sessionID) throw new Error("не удалось создать сеанс")
    }
    chatBySession.set(chat.sessionID, chatId)
    const res = await runSession({ directory, sessionID: chat.sessionID, text, agent: "build", timeoutMs: PROMPT_TIMEOUT_MS })
    const prefix = res.status === "timeout" ? "⏱ Остановлено по времени.\n\n" : res.status === "error" ? "❌ " : ""
    await send(chatId, prefix + (res.text || "(агент закончил без текстового ответа)"))
  } catch (e) {
    await send(chatId, "❌ " + (e instanceof Error ? e.message : String(e))).catch(() => {})
  } finally {
    clearInterval(typing)
  }
}

async function onEvent(event: BusEvent) {
  if (event.type !== "permission.asked") return
  const p = event.properties
  const chatId = chatBySession.get(p?.sessionID)
  if (!chatId || !cfg) return
  const dir = shared.sessionDirs.get(p.sessionID) ?? shared.defaultDirectory
  const what = [p.permission, ...(Array.isArray(p.patterns) ? p.patterns : [])].filter(Boolean).join(" ")
  try {
    const msg = await send(chatId, `🔐 Агент просит разрешение:\n${what.slice(0, 1500)}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Разрешить", callback_data: `p|${p.id}|o` },
          { text: "♾ Всегда", callback_data: `p|${p.id}|a` },
          { text: "⛔ Отклонить", callback_data: `p|${p.id}|r` },
        ]],
      },
    })
    const timer = setTimeout(() => void decide(p.id, "reject", "⌛ Время вышло, отклонено."), PERMISSION_TIMEOUT_MS)
    pending.set(p.id, { sessionID: p.sessionID, directory: dir, chatId, messageId: msg?.message_id, timer })
  } catch (e) {
    log("permission notify failed", e)
  }
}

async function decide(requestID: string, reply: "once" | "always" | "reject", note: string) {
  const entry = pending.get(requestID)
  if (!entry) return false
  pending.delete(requestID)
  clearTimeout(entry.timer)
  try {
    await (await clientFor(entry.directory)).permission.reply({ requestID, reply, directory: entry.directory } as any)
  } catch (e) {
    log("permission reply failed", e)
  }
  if (entry.messageId) await api("editMessageText", { chat_id: entry.chatId, message_id: entry.messageId, text: note }).catch(() => {})
  return true
}

async function handleCallback(q: any) {
  const answer = (text: string) => api("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {})
  if (!cfg?.allowed.includes(q.from?.id)) return void (await answer("Нет доступа"))
  const [kind, id, choice] = String(q.data ?? "").split("|")
  if (kind !== "p") return
  const reply = choice === "o" ? "once" : choice === "a" ? "always" : "reject"
  const note = reply === "reject" ? "⛔ Отклонено." : reply === "always" ? "♾ Разрешено всегда." : "✅ Разрешено."
  if (await decide(id, reply, note)) await answer(note)
  else await answer("Запрос уже закрыт")
}
