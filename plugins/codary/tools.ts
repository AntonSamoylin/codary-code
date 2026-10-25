// Инструменты, которые получает агент: управление задачами по расписанию. Создание и запуск подтверждает пользователь.
import { randomUUID } from "node:crypto"
import { tool } from "@opencode-ai/plugin"
import { loadSchedules, loadTelegram, updateSchedules, type Schedule } from "./store"
import { describe, fmt, nextRunAfter, validateSpec } from "./time"
import { enqueue } from "./scheduler"
import { chisleEnabled, setChisle } from "./chisle"
import { spawn } from "node:child_process"
import { appendDaily, checkMemory, readNote, reindex, rootOf, saveNote, searchNotes, TYPES } from "./memory-store"

const z = tool.schema

function line(s: Schedule) {
  const last = s.last ? `; последний запуск ${fmt(s.last.at)} — ${s.last.status === "ok" ? "успешно" : s.last.status === "timeout" ? "остановлен по времени" : "ошибка"}` : ""
  return `${s.id}: «${s.name}» ${describe(s)}, режим ${s.mode === "auto" ? "автоматический" : "только чтение"}, ${s.enabled ? "включена" : "на паузе"}, следующий запуск ${fmt(s.nextRun)}${last}\n  папка: ${s.directory}`
}

export const tools = {
  memory: tool({
    description:
      "Long-term memory as Obsidian-compatible markdown notes (frontmatter, [[wikilinks]], #tags). scope=project: <project>/.codary/ (decisions, how-tos, gotchas, agreements); scope=user: ~/.codary/ (the user's preferences and facts, shared by all projects). " +
      "Actions: save (one idea per note; existing notes are appended to unless mode=replace, which keeps a copy), read, search (query and/or tags), daily (append a line to today's journal), check (broken links, duplicates, stale notes, tag typos, secrets), open (open the folder as an Obsidian vault). " +
      "Never store passwords, keys, tokens or personal data. Search or read before relying on memory; keep summaries to one line.",
    args: {
      action: z.enum(["save", "read", "search", "daily", "check", "open"]).describe("What to do"),
      scope: z.enum(["project", "user"]).optional().describe("project (default) or user"),
      note: z.string().optional().describe("save/read: note title or name"),
      text: z.string().max(20000).optional().describe("save/daily: note text (markdown, may contain [[links]]); for save only the new content"),
      summary: z.string().max(200).optional().describe("save: one-line summary shown in the index"),
      type: z.enum(TYPES).optional().describe("save: decision, howto, gotcha, reference, preference, handoff or note"),
      tags: z.array(z.string()).optional().describe("save/search: tags without #"),
      mode: z.enum(["append", "replace"]).optional().describe("save: append (default for existing notes) or replace (old version is kept in .trash)"),
      query: z.string().optional().describe("search: words to look for"),
    },
    async execute(args, ctx) {
      const scope = args.scope ?? "project"
      const root = rootOf(scope, ctx.directory)
      const label = scope === "user" ? "Личная память" : "Память проекта"
      switch (args.action) {
        case "save": {
          if (!args.note || !args.text) return "Для save нужны note (название) и text."
          return (await saveNote(root, { title: args.note, text: args.text, summary: args.summary, type: args.type, tags: args.tags, mode: args.mode })).message
        }
        case "read":
          return args.note ? await readNote(root, args.note) : "Для read нужен note."
        case "search":
          return await searchNotes(root, args.query ?? "", args.tags ?? [])
        case "daily":
          return args.text ? await appendDaily(root, args.text) : "Для daily нужен text."
        case "check":
          return await checkMemory(root)
        case "open": {
          await reindex(root, label)
          const uri = `obsidian://open?path=${encodeURIComponent(root)}`
          if (process.env.CODARY_APP_PLATFORM === "cloud") return `Папка памяти: ${root}. В облаке Obsidian не запустить: скачайте папку или откройте её в Obsidian на своём компьютере.`
          await ctx.ask({ permission: "memory_open", patterns: [root], always: [], metadata: { folder: root } })
          const [cmd, argv] = process.platform === "darwin" ? ["open", [uri]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", uri]] : ["xdg-open", [uri]]
          try {
            spawn(cmd, argv, { detached: true, stdio: "ignore" }).on("error", () => {}).unref()
          } catch {}
          return `Открываю папку ${root} в Obsidian (если он установлен; при первом открытии он спросит, доверять ли хранилищу). Ссылка: ${uri}`
        }
      }
    },
  }),

  chisle_mode: tool({
    description:
      "Switch Codary's concise answer style (chisle) on or off for all chats, or report its state. Call it only when the user runs /chisle or explicitly asks to turn the terse style on or off.",
    args: { mode: z.enum(["on", "off", "status"]).describe("on, off or status") },
    async execute(args) {
      if (args.mode === "on") await setChisle(true)
      if (args.mode === "off") await setChisle(false)
      const on = await chisleEnabled()
      return `Режим chisle (краткие ответы): ${on ? "включён" : "выключен"}. ${on ? "Выключить: /chisle off." : "Включить: /chisle on."} Действует на новые запросы.`
    },
  }),

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
