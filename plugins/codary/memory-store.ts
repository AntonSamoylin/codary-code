// Память Codary в формате Obsidian: markdown-файлы с шапкой (frontmatter), [[ссылками]] и #тегами. Папку можно открыть в Obsidian как хранилище и править руками.
// Файлы — единственный источник правды, index.md (оглавление) — перестраиваемый кэш. Здесь только чистая логика без привязки к серверу, чтобы её можно было проверить отдельно.
//   <корень>/notes/<имя>.md   заметки (одна мысль — одна заметка)
//   <корень>/daily/ГГГГ-ММ-ДД.md   журнал дня
//   <корень>/index.md         оглавление: ваш текст сверху + автоматический блок между метками
//   <корень>/.trash/          копии заметок перед заменой или удалением (агент не должен стирать вашу работу)
// Корень: <проект>/.codary (проектная память) или ~/.codary (личная память пользователя).
// Идеи из отзывов пользователей Obsidian и агентных памятей: загрузка всего хранилища в контекст разоряет (грузим только оглавление и ищем по запросу), заметки гниют
// (проверка: битые ссылки с подсказкой, дубликаты, опечатки в тегах, устаревшие), агент затирает заметки (по умолчанию дополняем, перед заменой — копия),
// память без типов превращается в свалку (типы: решение, как делать, ловушка, справка, предпочтение, передача дел).
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"

export type Scope = "project" | "user"
export const TYPES = ["decision", "howto", "gotcha", "reference", "preference", "handoff", "note"] as const
export const TYPE_TITLES: Record<string, string> = {
  handoff: "Передача дел",
  decision: "Решения",
  howto: "Как делать",
  gotcha: "Ловушки",
  reference: "Справка",
  preference: "Предпочтения",
  note: "Заметки",
}
export const INDEX_START = "<!-- codary:index:start -->"
export const INDEX_END = "<!-- codary:index:end -->"
const INDEX_MAX_LINES = 60
const STALE_DAYS = 180

export type Note = { slug: string; title: string; type: string; tags: string[]; summary: string; created: string; updated: string; body: string }

export const rootOf = (scope: Scope, directory: string) => (scope === "user" ? path.join(os.homedir(), ".codary") : path.join(directory, ".codary"))
const notesDir = (root: string) => path.join(root, "notes")
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

export function slugify(title: string) {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return s || "заметка"
}

export const normTag = (t: string) => t.trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-")

// ---- шапка (минимальный YAML: строки, [списки], блочные списки) -----------------------------------------------------------
function parseYaml(src: string) {
  const out: Record<string, string | string[]> = {}
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) continue
    const [, key, value] = m
    const unq = (s: string) => s.trim().replace(/^["']|["']$/g, "")
    if (value === "") {
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unq(lines[++i].replace(/^\s*-\s+/, "")))
      out[key] = items
    } else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value.slice(1, -1).split(",").map(unq).filter(Boolean)
    } else out[key] = unq(value)
  }
  return out
}

export function parseNote(slug: string, raw: string): Note {
  let meta: Record<string, string | string[]> = {}
  let body = raw
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    meta = parseYaml(m[1])
    body = raw.slice(m[0].length)
  }
  const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : "")
  const rawTags = meta.tags
  const tags = (Array.isArray(rawTags) ? rawTags : typeof rawTags === "string" ? rawTags.split(/[,\s]+/) : []).map(normTag).filter(Boolean)
  const heading = body.match(/^#\s+(.+)$/m)?.[1]
  return {
    slug,
    title: str("title") || heading || slug,
    type: (TYPES as readonly string[]).includes(str("type")) ? str("type") : "note",
    tags: [...new Set(tags)],
    summary: str("summary"),
    created: str("created") || "",
    updated: str("updated") || str("created") || "",
    body: body.replace(/^\s+/, ""),
  }
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`
export function formatNote(n: Note) {
  const head = [`title: ${q(n.title)}`, `type: ${n.type}`, `tags: [${n.tags.join(", ")}]`, `summary: ${q(n.summary)}`, `created: ${n.created}`, `updated: ${n.updated}`]
  return `---\n${head.join("\n")}\n---\n\n${n.body.trimEnd()}\n`
}

// ---- ссылки ---------------------------------------------------------------------------------------------------------------
export function linkTargets(body: string) {
  const out = new Set<string>()
  for (const m of body.matchAll(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.add(m[1].trim())
  return [...out]
}

/** Имя в [[ссылке]] -> заметка: по имени файла или заголовку без учёта регистра. */
export function resolveLink(notes: Note[], target: string) {
  const t = target.trim().toLowerCase()
  const s = slugify(target)
  return notes.find((n) => n.slug === s || n.slug.toLowerCase() === t || n.title.toLowerCase() === t)
}

function distance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1)      // перестановка соседних букв — частая опечатка
    }
  return dp[a.length][b.length]
}
const nearest = (notes: Note[], target: string) => {
  const s = slugify(target)
  const scored = notes.map((n) => ({ n, d: Math.min(distance(s, n.slug), n.slug.includes(s) || s.includes(n.slug) ? 1 : 99) })).sort((a, b) => a.d - b.d)
  return scored[0] && scored[0].d <= Math.max(2, Math.floor(s.length / 4)) ? scored[0].n : undefined
}

export function backlinks(notes: Note[], slug: string) {
  return notes.filter((n) => n.slug !== slug && linkTargets(n.body).some((t) => resolveLink(notes, t)?.slug === slug)).map((n) => n.slug)
}

// ---- защита от секретов -----------------------------------------------------------------------------------------------------
const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/, "ключ вида sk-…"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "приватный ключ"],
  [/\bAKIA[0-9A-Z]{16}\b/, "ключ AWS"],
  [/\b(?:api[_-]?key|secret|token|password|passwd|пароль|ключ доступа)\s*[:=]\s*["']?[^\s"']{8,}/i, "пароль или токен после «:» или «=»"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "токен GitHub"],
]
export const findSecret = (text: string) => SECRET_PATTERNS.find(([re]) => re.test(text))?.[1]

// ---- чтение и запись ---------------------------------------------------------------------------------------------------------
export async function listNotes(root: string): Promise<Note[]> {
  let files: string[] = []
  try {
    files = (await fs.readdir(notesDir(root))).filter((f) => f.endsWith(".md"))
  } catch {
    return []
  }
  const notes = await Promise.all(files.map(async (f) => parseNote(f.slice(0, -3), await fs.readFile(path.join(notesDir(root), f), "utf8"))))
  return notes.sort((a, b) => (b.updated || "").localeCompare(a.updated || "") || a.slug.localeCompare(b.slug))
}

function indexBlock(notes: Note[]) {
  const lines: string[] = [INDEX_START, "_Этот блок обновляется автоматически (инструмент memory). Заметки лежат в notes/, журнал — в daily/._", ""]
  let used = 3
  let hidden = 0
  for (const type of Object.keys(TYPE_TITLES)) {
    const group = notes.filter((n) => n.type === type)
    if (!group.length) continue
    if (used + 2 > INDEX_MAX_LINES) {
      hidden += group.length
      continue
    }
    lines.push(`## ${TYPE_TITLES[type]}`)
    used += 1
    for (const n of group) {
      if (used >= INDEX_MAX_LINES) {
        hidden++
        continue
      }
      lines.push(`- [[${n.slug}]]${n.summary ? ` — ${n.summary}` : ""}${n.tags.length ? ` ${n.tags.map((t) => "#" + t).join(" ")}` : ""}`)
      used++
    }
    lines.push("")
    used++
  }
  if (hidden) lines.push(`…и ещё ${hidden} (не поместились в оглавление): ищите инструментом memory (search).`, "")
  if (!notes.length) lines.push("Пока пусто: заметки появятся, когда агент сохранит что-то важное (инструмент memory) или вы напишете /remember.", "")
  lines.push(INDEX_END)
  return lines.join("\n")
}

/** Перестраивает автоматический блок в index.md; текст пользователя вне меток сохраняется. */
export async function reindex(root: string, label = "Память") {
  const notes = await listNotes(root)
  const file = path.join(root, "index.md")
  await fs.mkdir(root, { recursive: true })
  let current = ""
  try {
    current = await fs.readFile(file, "utf8")
  } catch {}
  const block = indexBlock(notes)
  const s = current.indexOf(INDEX_START)
  const e = current.indexOf(INDEX_END)
  let next: string
  if (s >= 0 && e > s) next = current.slice(0, s) + block + current.slice(e + INDEX_END.length)
  else if (current.trim()) next = `${current.trimEnd()}\n\n${block}\n`
  else next = `# ${label}\n\n${block}\n`
  if (next !== current) await fs.writeFile(file, next)
  return notes
}

async function trash(root: string, slug: string, raw: string) {
  const dir = path.join(root, ".trash")
  await fs.mkdir(dir, { recursive: true })
  const name = `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
  await fs.writeFile(path.join(dir, name), raw)
  return `.trash/${name}`
}

export type SaveInput = { title: string; text: string; summary?: string; type?: string; tags?: string[]; mode?: "append" | "replace" }

export async function saveNote(root: string, input: SaveInput) {
  const secret = findSecret(`${input.title}\n${input.summary ?? ""}\n${input.text}`)
  if (secret) return { ok: false, message: `Не сохранено: в тексте похоже на секрет (${secret}). Пароли, ключи и токены в память не пишем — уберите их или опишите словами, где они хранятся.` }
  const slug = slugify(input.title)
  const file = path.join(notesDir(root), `${slug}.md`)
  if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) return { ok: false, message: "Недопустимое имя заметки." }
  await fs.mkdir(notesDir(root), { recursive: true })
  let old: Note | undefined
  let oldRaw = ""
  try {
    oldRaw = await fs.readFile(file, "utf8")
    old = parseNote(slug, oldRaw)
  } catch {}
  const t = input.text.trim()
  let action = "создана"
  let backup = ""
  let body = t
  if (old) {
    if (input.mode === "replace") {
      backup = await trash(root, slug, oldRaw)
      action = "заменена"
    } else if (old.body.includes(t)) {
      body = old.body
      action = "без изменений (такой текст уже есть)"
    } else {
      body = `${old.body.trimEnd()}\n\n${t}`
      action = "дополнена"
    }
  }
  const type = input.type && (TYPES as readonly string[]).includes(input.type) ? input.type : (old?.type ?? "note")
  const tags = [...new Set([...(old?.tags ?? []), ...(input.tags ?? []).map(normTag).filter(Boolean)])]
  const firstLine = t.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.replace(/\[\[|\]\]/g, "").trim() ?? ""
  const note: Note = {
    slug,
    title: old?.title && old.title !== old.slug ? old.title : input.title.trim(),
    type,
    tags,
    summary: (input.summary?.trim() || old?.summary || firstLine).slice(0, 120),
    created: old?.created || today(),
    updated: today(),
    body,
  }
  await fs.writeFile(file, formatNote(note))
  const notes = await reindex(root)
  const broken = linkTargets(body).filter((x) => !resolveLink(notes, x))
  const hint = broken.length ? ` Ссылки в никуда: ${broken.map((b) => `[[${b}]]`).join(", ")} — создайте такие заметки или поправьте имена.` : ""
  return { ok: true, slug, message: `Заметка [[${slug}]] ${action}${backup ? ` (прежняя версия: ${backup})` : ""}.${hint}` }
}

export async function readNote(root: string, name: string) {
  const notes = await listNotes(root)
  const note = resolveLink(notes, name) ?? nearest(notes, name)
  if (!note) return `Заметки «${name}» нет. Попробуйте search.`
  const back = backlinks(notes, note.slug)
  const body = note.body.length > 6000 ? note.body.slice(0, 6000) + "\n…(обрезано)" : note.body
  return [`# ${note.title}  [[${note.slug}]]`, `тип: ${note.type}; теги: ${note.tags.join(", ") || "—"}; обновлена: ${note.updated}`, note.summary && `кратко: ${note.summary}`, "", body, "", back.length ? `Ссылаются на эту заметку: ${back.map((b) => `[[${b}]]`).join(", ")}` : "На эту заметку никто не ссылается."]
    .filter((x) => x !== false && x !== undefined)
    .join("\n")
}

// ---- поиск ----------------------------------------------------------------------------------------------------------------
const stem = (w: string) => (w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 2)))      // грубо отбрасываем окончания, чтобы «деплой» находил «деплоя»
export async function searchNotes(root: string, query: string, tags: string[] = [], limit = 8) {
  const notes = await listNotes(root)
  const want = tags.map(normTag).filter(Boolean)
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].map(stem)
  const scored = notes
    .filter((n) => want.every((t) => n.tags.includes(t)))
    .map((n) => {
      const title = n.title.toLowerCase()
      const body = n.body.toLowerCase()
      let score = want.length ? 1 : 0
      for (const w of words) {
        if (title.includes(w) || n.slug.includes(w)) score += 5
        if (n.tags.some((t) => t.includes(w))) score += 4
        if (n.summary.toLowerCase().includes(w)) score += 3
        const hits = body.split(w).length - 1
        if (hits) score += Math.min(hits, 5)
      }
      return { n, score }
    })
    .filter((x) => x.score > 0 || (!words.length && !want.length))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  if (!scored.length) return `Ничего не найдено по запросу «${query}»${want.length ? ` с тегами ${want.join(", ")}` : ""}.`
  return scored
    .map(({ n }) => {
      const at = words.map((w) => n.body.toLowerCase().indexOf(w)).find((i) => i >= 0)
      const snippet = at !== undefined ? n.body.slice(Math.max(0, at - 40), at + 120).replace(/\s+/g, " ").trim() : ""
      return `- [[${n.slug}]] (${n.type}) — ${n.summary || n.title}${n.tags.length ? ` #${n.tags.join(" #")}` : ""}${snippet ? `\n    …${snippet}…` : ""}`
    })
    .join("\n")
}

// ---- журнал дня ---------------------------------------------------------------------------------------------------------------
export async function appendDaily(root: string, text: string) {
  const secret = findSecret(text)
  if (secret) return `Не записано: в тексте похоже на секрет (${secret}).`
  const dir = path.join(root, "daily")
  await fs.mkdir(dir, { recursive: true })
  const now = new Date()
  const file = path.join(dir, `${today(now)}.md`)
  let cur = ""
  try {
    cur = await fs.readFile(file, "utf8")
  } catch {
    cur = `# ${today(now)}\n\n`
  }
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
  await fs.writeFile(file, `${cur.trimEnd()}\n- ${time} ${text.trim().replace(/\r?\n/g, " ")}\n`)
  return `Записано в журнал дня: daily/${today(now)}.md`
}

// ---- проверка ---------------------------------------------------------------------------------------------------------------
export async function checkMemory(root: string, now = new Date()) {
  const notes = await reindex(root)
  if (!notes.length) return "Память пуста: проверять нечего."
  const out: string[] = []
  // битые ссылки с подсказкой, на что они похожи
  for (const n of notes)
    for (const t of linkTargets(n.body)) {
      if (resolveLink(notes, t)) continue
      const near = nearest(notes, t)
      out.push(`Битая ссылка в [[${n.slug}]]: [[${t}]]${near ? ` — возможно, имелась в виду [[${near.slug}]]` : " — такой заметки нет (создать или убрать)"}`)
    }
  // дубликаты по имени и по словам заголовка
  const seen: Note[] = []
  for (const n of notes) {
    const words = new Set(n.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))
    const dup = seen.find((m) => {
      const mw = new Set(m.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))
      const inter = [...words].filter((w) => mw.has(w)).length
      const small = Math.min(words.size, mw.size)
      return small > 0 && (inter >= 2 ? inter / small >= 0.8 : inter === small && words.size === mw.size)      // одно название вложено в другое («Деплой шлюза» и «Деплой шлюза на прод»)
    })
    if (dup) out.push(`Похожие заметки: [[${dup.slug}]] и [[${n.slug}]] — объединить?`)
    seen.push(n)
  }
  // опечатки в тегах: редкий тег на расстоянии 1 от частого
  const freq = new Map<string, number>()
  for (const n of notes) for (const t of n.tags) freq.set(t, (freq.get(t) ?? 0) + 1)
  for (const [t, c] of freq)
    for (const [u, d] of freq)
      if (t !== u && c === 1 && d >= c && (d > c || t < u) && distance(t, u) === 1) out.push(`Тег #${t} похож на #${u} — опечатка?`)
  // устаревшие, без краткого описания, без связей, секреты
  const stale = notes.filter((n) => n.updated && (now.getTime() - new Date(n.updated).getTime()) / 864e5 > STALE_DAYS)
  if (stale.length) out.push(`Давно не обновлялись (больше ${STALE_DAYS} дней): ${stale.slice(0, 8).map((n) => `[[${n.slug}]]`).join(", ")}${stale.length > 8 ? ` и ещё ${stale.length - 8}` : ""} — проверьте, не устарели ли факты.`)
  const noSummary = notes.filter((n) => !n.summary)
  if (noSummary.length) out.push(`Без краткого описания (в оглавлении они безымянные): ${noSummary.slice(0, 8).map((n) => `[[${n.slug}]]`).join(", ")}`)
  const lonely = notes.filter((n) => notes.length > 3 && !linkTargets(n.body).length && !backlinks(notes, n.slug).length)
  if (lonely.length) out.push(`Без связей с другими заметками: ${lonely.slice(0, 8).map((n) => `[[${n.slug}]]`).join(", ")}${lonely.length > 8 ? ` и ещё ${lonely.length - 8}` : ""} — добавьте [[ссылки]] на связанные.`)
  for (const n of notes) {
    const s = findSecret(`${n.summary}\n${n.body}`)
    if (s) out.push(`Похоже на секрет (${s}) в [[${n.slug}]] — уберите и смените, если это настоящий пароль.`)
  }
  const head = `Проверено заметок: ${notes.length}. Оглавление пересобрано.`
  return out.length ? `${head}\nНайдено (${out.length}):\n${out.slice(0, 40).map((x) => "- " + x).join("\n")}${out.length > 40 ? `\n…и ещё ${out.length - 40}` : ""}` : `${head}\nПроблем не найдено.`
}
