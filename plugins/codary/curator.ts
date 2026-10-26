// Фоновое подведение итогов чата: когда чат затих, отдельная короткая сеанс-«куратор» на дешёвой модели читает разговор и сама сохраняет в память (инструмент memory)
// решения, ловушки, договорённости и предпочтения пользователя. Включено по умолчанию; выключатель: /memory-auto off (флаг в папке данных) или CODARY_MEMORY_AUTO=0.
// Защита от лишних трат: ждём, пока чат затихнет (45 с), короткие чаты пропускаем, одну и ту же беседу повторно разбираем только после новых реплик,
// не больше 20 разборов в сутки, один куратор за раз, после сбоя модели пауза 10 минут. Сеанс куратора — дочерний (его не видно в списке чатов, уведомлений он не шлёт)
// и после работы архивируется. В разговоре секреты скрываются до отправки.
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { cheapModel } from "./account"
import { buildTranscript, rootOf } from "./memory-store"
import { clientFor, log, runSession, shared, textOf, type BusEvent } from "./shared"

const num = (name: string, fallback: number) => (Number.isFinite(Number(process.env[name])) && process.env[name] ? Number(process.env[name]) : fallback)
const DEBOUNCE_MS = () => num("CODARY_CURATOR_DEBOUNCE_MS", 45_000)
const MIN_CHARS = () => num("CODARY_CURATOR_MIN_CHARS", 1200)
const MIN_USER_MESSAGES = 2
const DAILY_LIMIT = 20
const RUN_TIMEOUT_MS = 5 * 60_000
const FAIL_PAUSE_MS = 10 * 60_000

const dataDir = () => path.join(Global.Path.data, "codary")
const flagFile = () => path.join(dataDir(), "memory-auto-off")
const stateFile = () => path.join(dataDir(), "curated.json")

type State = { day: string; runs: number; sessions: Record<string, { users: number; ts: number }> }
const dayKey = () => new Date().toISOString().slice(0, 10)

async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(await fs.readFile(stateFile(), "utf8"))
    if (s && typeof s === "object") return { day: s.day ?? dayKey(), runs: s.runs ?? 0, sessions: s.sessions ?? {} }
  } catch {}
  return { day: dayKey(), runs: 0, sessions: {} }
}
async function saveState(s: State) {
  const cutoff = Date.now() - 30 * 864e5
  for (const [id, v] of Object.entries(s.sessions)) if (v.ts < cutoff) delete s.sessions[id]
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(stateFile(), JSON.stringify(s))
}

export async function autoEnabled() {
  if (process.env.CODARY_MEMORY_AUTO === "0") return false
  try {
    await fs.access(flagFile())
    return false
  } catch {
    return true
  }
}
export async function setAuto(on: boolean) {
  if (on) await fs.rm(flagFile(), { force: true })
  else {
    await fs.mkdir(dataDir(), { recursive: true })
    await fs.writeFile(flagFile(), "off\n")
  }
}
export async function autoStatus() {
  const s = await loadState()
  const runs = s.day === dayKey() ? s.runs : 0
  return `Фоновое подведение итогов чатов: ${(await autoEnabled()) ? "включено" : "выключено"}. Сегодня разборов: ${runs} из ${DAILY_LIMIT}. ${(await autoEnabled()) ? "Выключить: /memory-auto off." : "Включить: /memory-auto on."}`
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t)

async function indexOf(root: string) {
  try {
    const t = await fs.readFile(path.join(root, "index.md"), "utf8")
    return t.length > 3000 ? t.slice(0, 3000) + "…" : t
  } catch {
    return "(пока пусто)"
  }
}

const PERMISSIONS = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "memory", pattern: "*", action: "allow" },
]

function promptFor(title: string, projectIndex: string, userIndex: string, transcript: string) {
  return `Ты тихий куратор памяти. Ниже разговор пользователя с ИИ-агентом («${title}»). Твоя единственная задача: сохранить в память (инструмент memory) то, что пригодится в БУДУЩИХ чатах.
Сохраняй: принятые решения и их причины, ловушки и их обход, как запускать и проверять, договорённости и адреса, предпочтения и факты о пользователе (они идут в scope user, остальное — в scope project).
Не сохраняй: ход работы и пересказ разговора, временное, то, что видно из кода и README, пароли, ключи, токены и персональные данные.
Порядок: сначала memory search по теме, чтобы дополнить существующую заметку, а не дублировать; одна мысль на заметку; название, summary одной строкой, type, теги, [[ссылки]] на связанные заметки. Не больше 5 заметок. Если нового и важного нет — ничего не вызывай и ответь «нечего сохранять». В конце одной строкой перечисли, что сохранил.

Оглавление памяти проекта:
${projectIndex}

Оглавление личной памяти:
${userIndex}

Разговор:
${transcript}`
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const curatorIDs = new Set<string>()
const queue: { id: string; directory: string }[] = []
let draining = false
let failUntil = 0

export function startCurator() {
  shared.listeners.add((event: BusEvent) => {
    const id = event.properties?.sessionID
    if (event.type !== "session.status" || !id || curatorIDs.has(id)) return
    const dir = event.directory ?? shared.sessionDirs.get(id)
    if (!dir) return
    clearTimeout(timers.get(id))
    timers.delete(id)
    if (event.properties?.status?.type !== "idle") return
    const t = setTimeout(() => {
      timers.delete(id)
      void consider(id, dir)
    }, DEBOUNCE_MS())
    t.unref?.()
    timers.set(id, t)
  })
}

async function consider(id: string, directory: string) {
  try {
    if (!(await autoEnabled()) || Date.now() < failUntil || queue.some((q) => q.id === id)) return
    const client = await clientFor(directory)
    const info: any = ((await client.session.get({ sessionID: id, directory } as any)) as any)?.data
    if (!info || info.parentID || /^(⏰|🧠)/.test(info.title ?? "") || info.time?.archived) return
    const msgs: any[] = (((await client.session.messages({ sessionID: id, directory } as any)) as any)?.data ?? []) as any[]
    const users = msgs.filter((m) => m.info?.role === "user" && textOf(m.parts)).length
    const state = await loadState()
    const prev = state.sessions[id]?.users ?? 0
    if (users < MIN_USER_MESSAGES || users - prev < (prev ? 2 : MIN_USER_MESSAGES)) return
    if (buildTranscript(msgs).length < MIN_CHARS()) return
    if (state.day === dayKey() && state.runs >= DAILY_LIMIT) return
    queue.push({ id, directory })
    void drain()
  } catch (e) {
    log("curator consider failed", e)
  }
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      await curate(job.id, job.directory).catch((e) => log("curator failed", e))
    }
  } finally {
    draining = false
  }
}

async function curate(id: string, directory: string) {
  if (!(await autoEnabled())) return
  const model = await cheapModel()
  if (!model) return
  const client = await clientFor(directory)
  const info: any = ((await client.session.get({ sessionID: id, directory } as any)) as any)?.data
  const msgs: any[] = (((await client.session.messages({ sessionID: id, directory } as any)) as any)?.data ?? []) as any[]
  const users = msgs.filter((m) => m.info?.role === "user" && textOf(m.parts)).length
  const text = promptFor(
    clip(String(info?.title ?? "чат"), 80),
    await indexOf(rootOf("project", directory)),
    await indexOf(rootOf("user", directory)),
    buildTranscript(msgs),
  )
  const created: any = await client.session.create({ directory, parentID: id, title: `🧠 Память: ${clip(String(info?.title ?? "чат"), 60)}`, permission: PERMISSIONS } as any)
  const cid: string | undefined = created?.data?.id
  if (!cid) throw new Error("не удалось создать сеанс куратора: " + JSON.stringify(created?.error ?? "").slice(0, 200))
  curatorIDs.add(cid)
  try {
    const res = await runSession({ directory, sessionID: cid, text, agent: "build", model, timeoutMs: RUN_TIMEOUT_MS })
    const state = await loadState()
    if (state.day !== dayKey()) Object.assign(state, { day: dayKey(), runs: 0 })
    if (res.status === "ok") {
      state.runs++
      state.sessions[id] = { users, ts: Date.now() }
    } else {
      failUntil = Date.now() + FAIL_PAUSE_MS
      log("curator run status", res.status, res.text)
    }
    await saveState(state)
  } finally {
    await client.session.update({ sessionID: cid, directory, time: { archived: Date.now() } } as any).catch(() => {})
    setTimeout(() => curatorIDs.delete(cid), 120_000).unref?.()
  }
}
