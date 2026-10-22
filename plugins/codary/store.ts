// Хранилище Codary: расписание задач и настройки Telegram (файлы рядом с данными OpenCode).
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"

export type Schedule = {
  id: string
  name: string
  prompt: string
  directory: string
  /** Либо повтор раз в N минут, либо ежедневно в HH:MM (по времени компьютера) */
  everyMinutes?: number
  dailyAt?: string
  /** Дни недели для dailyAt: 1 = понедельник … 7 = воскресенье; пусто = каждый день */
  weekdays?: number[]
  /** readonly — агент «план» без правок; auto — обычный агент, разрешения подтверждаются автоматически */
  mode: "readonly" | "auto"
  enabled: boolean
  /** Присылать итог в Telegram, если он настроен */
  notify: boolean
  createdAt: number
  nextRun: number
  last?: { at: number; sessionID?: string; status: "ok" | "error" | "timeout"; summary: string }
}

export type TelegramConfig = { token: string; allowed: number[] }

const dataDir = () => path.join(Global.Path.data, "codary")
const schedulesFile = () => path.join(dataDir(), "schedules.json")
export const configFile = () => path.join(Global.Path.config, "codary.json")

export async function loadSchedules(): Promise<Schedule[]> {
  try {
    const list = JSON.parse(await fs.readFile(schedulesFile(), "utf8"))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

let writing: Promise<unknown> = Promise.resolve()

/** Изменяет список задач под замком: два одновременных запуска не затирают друг друга. */
export function updateSchedules<T>(fn: (list: Schedule[]) => T | Promise<T>): Promise<T> {
  const run = writing.then(async () => {
    const list = await loadSchedules()
    const result = await fn(list)
    await fs.mkdir(dataDir(), { recursive: true })
    const tmp = schedulesFile() + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(list, null, 2))
    await fs.rename(tmp, schedulesFile())
    return result
  })
  writing = run.catch(() => undefined)
  return run
}

/** Токен бота и список разрешённых Telegram ID: файл codary.json в папке настроек либо переменные окружения. */
export async function loadTelegram(): Promise<TelegramConfig | undefined> {
  let token = process.env.CODARY_TELEGRAM_TOKEN?.trim()
  let allowed: number[] = (process.env.CODARY_TELEGRAM_ALLOWED ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x !== 0)
  try {
    const raw = JSON.parse(await fs.readFile(configFile(), "utf8"))?.telegram
    if (raw && typeof raw === "object") {
      if (!token && typeof raw.token === "string") token = raw.token.trim()
      if (!allowed.length && Array.isArray(raw.allowed)) allowed = raw.allowed.map(Number).filter((x: number) => Number.isFinite(x) && x !== 0)
    }
  } catch {}
  return token ? { token, allowed } : undefined
}
