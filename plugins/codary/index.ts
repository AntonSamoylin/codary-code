// Встроенный плагин Codary: задачи по расписанию и управление из Telegram. Подключается как внутренний плагин сервера.
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { emit, shared } from "./shared"
import { startScheduler } from "./scheduler"
import { startTelegram } from "./telegram"
import { tools } from "./tools"
import { codaryCommands, codaryConfig } from "./account"
import { CHISLE_RULES, chisleEnabled } from "./chisle"

export async function CodaryPlugin(input: PluginInput): Promise<Hooks> {
  if (process.env.CODARY_DISABLE_PLUGIN) return {}
  if (!shared.started) {
    shared.started = true
    shared.defaultDirectory = input.directory
    startScheduler()
    startTelegram()
  }
  return {
    config: async (config: any) => {
      codaryCommands(config)
      await codaryConfig(config)
    },
    tool: tools,
    "experimental.chat.system.transform": async (_input, output) => {
      if (await chisleEnabled()) output.system.push(CHISLE_RULES)
    },
    event: async ({ event }) => emit({ type: event.type, properties: (event as any).properties }),
  }
}
