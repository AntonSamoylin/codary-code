// Память Codary в формате Obsidian (подробности формата и логики — memory-store.ts, инструмент memory — tools.ts).
// В каждый чат автоматически попадают только оглавления: проектное (.codary/index.md) и личное пользователя (~/.codary/index.md); остальное агент берёт поиском.
export const MEMORY_INDEXES = [".codary/index.md", "~/.codary/index.md"]

export function codaryMemory(config: any) {
  config.instructions = Array.isArray(config.instructions) ? config.instructions : []
  for (const f of MEMORY_INDEXES) if (!config.instructions.includes(f)) config.instructions.push(f)
}

export const MEMORY_RULES = `# Память (инструмент memory)
Долгая память в виде заметок формата Obsidian: markdown, [[ссылки]], #теги. Проектная (scope project, папка .codary/) и личная пользователя (scope user, ~/.codary/: предпочтения, стиль, факты о пользователе, общие для всех проектов). Оглавления index.md уже подгружены выше; остальное ищи через memory search и открывай через memory read, не угадывай.
Узнал важное и постоянное (решение и причина, как запускать и проверять, ловушка, адрес, договорённость, предпочтение пользователя) — сохрани через memory save: одна мысль на заметку, понятное название, summary одной строкой, type (decision, howto, gotcha, reference, preference, handoff, note), теги и [[ссылки]] на связанные заметки. Существующую заметку дополняй, не заменяй. Ход дня — в memory daily.
Не сохраняй пароли, ключи, токены и персональные данные, а также то, что видно из кода и README. После чата отдельный фоновый куратор сам подводит итоги (отключается командой /memory-auto off), поэтому сразу сохраняй только то, что нужно в этом чате или о чём просил пользователь. Команды пользователя: /remember, /handoff (передача дел в следующий чат), /memory-check (проверка), /vault (открыть в Obsidian).`
