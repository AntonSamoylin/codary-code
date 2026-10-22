// Задачи по расписанию: пока приложение запущено, раз в 20 секунд проверяем, не пора ли что-то выполнить.
import { loadSchedules, updateSchedules, type Schedule } from "./store"
import { fmt, nextRunAfter } from "./time"
import { clientFor, emit, log, runSession, shared, type BusEvent } from "./shared"

const TICK_MS = 20_000
const TASK_TIMEOUT_MS = 30 * 60_000
const running = new Set<string>()
const queue: string[] = []
let draining = false

/** Рассылка итога (подключается из telegram.ts, чтобы модули не зависели друг от друга) */
export const hooks: { notify?: (text: string) => Promise<void> } = {}

export function startScheduler() {
  setInterval(() => void tick(), TICK_MS).unref?.()
  void tick()
  // разрешения для автоматических задач подтверждаем сами, кроме выхода за пределы проекта
  shared.listeners.add(async (event: BusEvent) => {
    if (event.type !== "permission.asked") return
    const p = event.properties
    if (!shared.autoApprove.has(p?.sessionID)) return
    const dir = shared.sessionDirs.get(p.sessionID)
    if (!dir) return
    const risky = p.permission === "external_directory" || p.permission === "doom_loop"
    try {
      const client = await clientFor(dir)
      await client.permission.reply({ requestID: p.id, reply: risky ? "reject" : "once", directory: dir } as any)
    } catch (e) {
      log("auto reply failed", e)
    }
  })
}

async function tick() {
  try {
    const now = Date.now()
    for (const s of await loadSchedules()) {
      if (s.enabled && s.nextRun <= now && !running.has(s.id) && !queue.includes(s.id)) queue.push(s.id)
    }
    void drain()
  } catch (e) {
    log("tick failed", e)
  }
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const id = queue.shift()!
      const s = (await loadSchedules()).find((x) => x.id === id)
      if (s) await run(s)
    }
  } finally {
    draining = false
  }
}

/** Поставить задачу в очередь сейчас (используется кнопкой «выполнить сейчас») */
export function enqueue(id: string) {
  if (!running.has(id) && !queue.includes(id)) queue.push(id)
  void drain()
}

async function run(s: Schedule) {
  running.add(s.id)
  const startedAt = Date.now()
  let sessionID: string | undefined
  let status: "ok" | "error" | "timeout" = "error"
  let summary = ""
  try {
    const client = await clientFor(s.directory)
    const created: any = await client.session.create({ directory: s.directory, title: `⏰ ${s.name} — ${fmt(startedAt)}` } as any)
    sessionID = created?.data?.id
    if (!sessionID) throw new Error("не удалось создать сеанс: " + JSON.stringify(created?.error ?? "").slice(0, 200))
    shared.sessionDirs.set(sessionID, s.directory)
    if (s.mode === "auto") shared.autoApprove.add(sessionID)
    const res = await runSession({ directory: s.directory, sessionID, text: s.prompt, agent: s.mode === "readonly" ? "plan" : "build", timeoutMs: TASK_TIMEOUT_MS })
    status = res.status
    summary = res.text
  } catch (e) {
    status = "error"
    summary = e instanceof Error ? e.message : String(e)
  } finally {
    if (sessionID) shared.autoApprove.delete(sessionID)
    running.delete(s.id)
  }
  const finishedAt = Date.now()
  await updateSchedules((list) => {
    const cur = list.find((x) => x.id === s.id)
    if (!cur) return
    cur.last = { at: finishedAt, sessionID, status, summary: summary.slice(0, 1500) }
    cur.nextRun = nextRunAfter(cur, finishedAt)
  })
  emit({ type: "codary.schedule.finished", properties: { id: s.id, status } })
  if (s.notify && hooks.notify) {
    const head = status === "ok" ? "✅" : status === "timeout" ? "⏱" : "❌"
    const title = status === "ok" ? "выполнена" : status === "timeout" ? "остановлена по времени (30 мин)" : "завершилась ошибкой"
    await hooks.notify(`${head} Задача «${s.name}» ${title}\n\n${summary || "(без текста)"}`).catch((e) => log("notify failed", e))
  }
}

