// Инструменты, которые получает агент: управление задачами по расписанию. Создание и запуск подтверждает пользователь.
import { randomUUID } from "node:crypto"
import { tool } from "@opencode-ai/plugin"
import { loadSchedules, loadTelegram, updateSchedules, type Schedule } from "./store"
import { describe, fmt, nextRunAfter, validateSpec } from "./time"
import { enqueue } from "./scheduler"

const z = tool.schema

function line(s: Schedule) {
  const last = s.last ? `; последний запуск ${fmt(s.last.at)} — ${s.last.status === "ok" ? "успешно" : s.last.status === "timeout" ? "остановлен по времени" : "ошибка"}` : ""
  return `${s.id}: «${s.name}» ${describe(s)}, режим ${s.mode === "auto" ? "автоматический" : "только чтение"}, ${s.enabled ? "включена" : "на паузе"}, следующий запуск ${fmt(s.nextRun)}${last}\n  папка: ${s.directory}`
}

export const tools = {
  schedule_create: tool({
    description:
      "Create a recurring task for Codary Code to run automatically while the app is open (for example: check tests every morning, summarize new commits every hour). " +
      "Give exactly one of every_minutes (min 5) or daily_at (HH:MM, local time, optionally with weekdays 1=Mon..7=Sun). " +
      "The prompt runs in a fresh session each time, so it must be self-contained. Default mode is readonly (analysis only, no file changes); " +
      "use mode auto only if the task must edit files or run commands. The user is asked to confirm before the task is created.",
    args: {
      name: z.string().min(1).max(80).describe("Short task name"),
      prompt: z.string().min(1).max(8000).describe("Full instruction for each run"),
      every_minutes: z.number().optional().describe("Repeat every N minutes (minimum 5)"),
      daily_at: z.string().optional().describe("Daily time HH:MM in the user's local time"),
      weekdays: z.array(z.number()).optional().describe("Days for daily_at: 1=Monday..7=Sunday; omit for every day"),
      mode: z.enum(["readonly", "auto"]).optional().describe("readonly (default) or auto"),
      notify: z.boolean().optional().describe("Send the result to Telegram if it is configured (default true)"),
      directory: z.string().optional().describe("Project folder; defaults to the current one"),
    },
    async execute(args, ctx) {
      const spec = { everyMinutes: args.every_minutes, dailyAt: args.daily_at, weekdays: args.weekdays }
      const bad = validateSpec(spec)
      if (bad) return `Задача не создана: ${bad}`
      const now = Date.now()
      const task: Schedule = {
        id: "s_" + randomUUID().slice(0, 8),
        name: args.name,
        prompt: args.prompt,
        directory: args.directory ?? ctx.directory,
        ...spec,
        mode: args.mode ?? "readonly",
        enabled: true,
        notify: args.notify ?? true,
        createdAt: now,
        nextRun: nextRunAfter(spec, now),
      }
      await ctx.ask({
        permission: "schedule_create",
        patterns: [task.name],
        always: [],
        metadata: { name: task.name, when: describe(task), mode: task.mode, directory: task.directory, prompt: task.prompt.slice(0, 400) },
      })
      await updateSchedules((list) => void list.push(task))
      const tg = await loadTelegram()
      return `Задача создана.\n${line(task)}\nЗадачи выполняются, пока приложение запущено.${task.notify && !tg ? " Итог придёт в Telegram, если вы его подключите." : ""}`
    },
  }),

  schedule_list: tool({
    description: "List all recurring tasks with their next and last run.",
    args: {},
    async execute() {
      const list = await loadSchedules()
      return list.length ? list.map(line).join("\n") : "Задач по расписанию нет."
    },
  }),

  schedule_delete: tool({
    description: "Delete a recurring task by its id (see schedule_list).",
    args: { id: z.string().describe("Task id") },
    async execute(args) {
      const removed = await updateSchedules((list) => {
        const i = list.findIndex((s) => s.id === args.id)
        return i < 0 ? undefined : list.splice(i, 1)[0]
      })
      return removed ? `Задача «${removed.name}» удалена.` : `Задача ${args.id} не найдена.`
    },
  }),

  schedule_toggle: tool({
    description: "Pause or resume a recurring task.",
    args: { id: z.string(), enabled: z.boolean().describe("true to resume, false to pause") },
    async execute(args) {
      const s = await updateSchedules((list) => {
        const cur = list.find((x) => x.id === args.id)
        if (!cur) return undefined
        cur.enabled = args.enabled
        if (args.enabled) cur.nextRun = nextRunAfter(cur, Date.now())
        return cur
      })
      return s ? `Задача «${s.name}» ${s.enabled ? "включена" : "поставлена на паузу"}.` : `Задача ${args.id} не найдена.`
    },
  }),

  schedule_run_now: tool({
    description: "Run a recurring task immediately in the background (in a separate session). The user is asked to confirm.",
    args: { id: z.string() },
    async execute(args, ctx) {
      const s = (await loadSchedules()).find((x) => x.id === args.id)
      if (!s) return `Задача ${args.id} не найдена.`
      await ctx.ask({ permission: "schedule_run", patterns: [s.name], always: [], metadata: { name: s.name, mode: s.mode, directory: s.directory } })
      enqueue(s.id)
      return `Задача «${s.name}» поставлена в очередь, результат появится в отдельном сеансе «⏰ ${s.name}».`
    },
  }),
}
