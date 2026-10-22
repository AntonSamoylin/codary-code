// Встроенный плагин Codary: задачи по расписанию и управление из Telegram. Подключается как внутренний плагин сервера.
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { emit, shared } from "./shared"
import { startScheduler } from "./scheduler"
import { startTelegram } from "./telegram"
import { tools } from "./tools"

export async function CodaryPlugin(input: PluginInput): Promise<Hooks> {
  if (process.env.CODARY_DISABLE_PLUGIN) return {}
  if (!shared.started) {
    shared.started = true
    shared.defaultDirectory = input.directory
    startScheduler()
    startTelegram()
  }
  return {
    tool: tools,
    event: async ({ event }) => emit({ type: event.type, properties: (event as any).properties }),
  }
}
