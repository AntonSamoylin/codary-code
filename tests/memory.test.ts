// Проверка памяти в формате Obsidian: bun test tests/memory.test.ts
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendDaily, backlinks, buildTranscript, checkMemory, findSecret, listNotes, parseNote, readNote, reindex, saveNote, searchNotes, slugify } from "../plugins/codary/memory-store"

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), "codary-mem-"))

test("заметка создаётся с шапкой Obsidian, дополняется, замена оставляет копию", async () => {
  const root = await tmp()
  const a = await saveNote(root, { title: "Как запускать тесты", text: "Команда: bun test.\nСвязано: [[деплой]].", type: "howto", tags: ["Dev", "#tests"], summary: "bun test в корне" })
  expect(a.ok).toBe(true)
  const raw = await fs.readFile(path.join(root, "notes", "как-запускать-тесты.md"), "utf8")
  expect(raw).toStartWith("---\ntitle: \"Как запускать тесты\"\ntype: howto\ntags: [dev, tests]\nsummary: \"bun test в корне\"")
  expect(a.message).toContain("[[деплой]]")                                         // ссылка в никуда замечена сразу
  const b = await saveNote(root, { title: "Как запускать тесты", text: "Ещё: bun test --watch." })
  expect(b.message).toContain("дополнена")
  const note = parseNote("x", await fs.readFile(path.join(root, "notes", "как-запускать-тесты.md"), "utf8"))
  expect(note.body).toContain("bun test.") && expect(note.body).toContain("--watch")
  expect(note.tags).toEqual(["dev", "tests"]) && expect(note.created).toBe(note.updated)
  expect((await saveNote(root, { title: "Как запускать тесты", text: "Ещё: bun test --watch." })).message).toContain("уже есть")   // повтор не плодит дубли
  const c = await saveNote(root, { title: "Как запускать тесты", text: "Новый текст целиком", mode: "replace" })
  expect(c.message).toContain("заменена") && expect(c.message).toContain(".trash/")
  expect((await fs.readdir(path.join(root, ".trash"))).length).toBe(1)
})

test("секреты не сохраняются, заметки не выходят из папки", async () => {
  const root = await tmp()
  for (const text of ["ключ sk-abcdefghijklmnop12345", "password = hunter2hunter2", "-----BEGIN RSA PRIVATE KEY-----"]) {
    const r = await saveNote(root, { title: "доступы", text })
    expect(r.ok).toBe(false)
  }
  expect(findSecret("обычный текст про пароль без значения")).toBeUndefined()
  const r = await saveNote(root, { title: "../../etc/passwd", text: "x" })
  expect(r.ok).toBe(true)
  expect((await fs.readdir(path.join(root, "notes")))[0]).not.toContain("/")
  expect(slugify("A/B:C?")).toBe("a-b-c")
})

test("оглавление: тексты пользователя сохраняются, блок перестраивается, по типам", async () => {
  const root = await tmp()
  await fs.writeFile(path.join(root, "index.md"), "# Мой индекс\n\nПишу сюда свои пометки.\n")
  await saveNote(root, { title: "Выбор базы", text: "Берём SQLite.", type: "decision", summary: "SQLite, не Postgres" })
  await saveNote(root, { title: "Ловушка с кэшем", text: "Сбрасывать кэш.", type: "gotcha", tags: ["cache"] })
  const idx = await fs.readFile(path.join(root, "index.md"), "utf8")
  expect(idx).toContain("Пишу сюда свои пометки.")
  expect(idx).toContain("## Решения\n- [[выбор-базы]] — SQLite, не Postgres")
  expect(idx).toContain("## Ловушки") && expect(idx).toContain("#cache")
  await reindex(root)
  expect((await fs.readFile(path.join(root, "index.md"), "utf8")).split("codary:index:start").length).toBe(2)   // блок один, не плодится
})

test("оглавление не раздувается: сверх лимита остаётся подсказка про поиск", async () => {
  const root = await tmp()
  for (let i = 0; i < 80; i++) await saveNote(root, { title: `Заметка номер ${i}`, text: `Факт ${i}.`, summary: `кратко ${i}` })
  const idx = await fs.readFile(path.join(root, "index.md"), "utf8")
  expect(idx.split("\n").length).toBeLessThan(75)
  expect(idx).toContain("ищите инструментом memory (search)")
})

test("поиск находит по названию, тегу и тексту с учётом окончаний; фильтр по тегу", async () => {
  const root = await tmp()
  await saveNote(root, { title: "Деплой шлюза", text: "Выкладываем gateway.py через scp.", tags: ["deploy"], type: "howto" })
  await saveNote(root, { title: "Бэкапы базы", text: "Копия ночью на Netcup.", tags: ["backup"] })
  expect(await searchNotes(root, "деплоя")).toContain("[[деплой-шлюза]]")
  expect(await searchNotes(root, "netcup")).toContain("[[бэкапы-базы]]")
  expect(await searchNotes(root, "", ["backup"])).toContain("[[бэкапы-базы]]")
  expect(await searchNotes(root, "ничего такого")).toContain("Ничего не найдено")
})

test("чтение показывает обратные ссылки и находит заметку по похожему имени", async () => {
  const root = await tmp()
  await saveNote(root, { title: "Базовая настройка", text: "База." })
  await saveNote(root, { title: "Установка", text: "См. [[Базовая настройка]]." })
  const r = await readNote(root, "базовая настройка")
  expect(r).toContain("Ссылаются на эту заметку: [[установка]]")
  expect(await readNote(root, "Базовая настроика")).toContain("# Базовая настройка")       // опечатка в имени
  expect(backlinks(await listNotes(root), "базовая-настройка")).toEqual(["установка"])
})

test("проверка: битые ссылки с подсказкой, дубликаты, опечатки в тегах, устаревшие, секреты руками", async () => {
  const root = await tmp()
  await saveNote(root, { title: "Деплой шлюза", text: "Смотри [[Бэкапы базы]] и [[Бэкап базы]].", tags: ["deploy", "ops"] })
  await saveNote(root, { title: "Бэкапы базы", text: "Ночная копия.", tags: ["ops"] })
  await saveNote(root, { title: "Деплой шлюза на прод", text: "То же.", tags: ["depoly", "ops"] })
  await saveNote(root, { title: "Старое решение", text: "Давно.", tags: ["ops"] })
  const f = path.join(root, "notes", "старое-решение.md")
  await fs.writeFile(f, (await fs.readFile(f, "utf8")).replace(/updated: .*/, "updated: 2024-01-01"))
  await fs.writeFile(path.join(root, "notes", "руками.md"), "---\ntitle: Руками\n---\npassword: supersecret123\n")
  const rep = await checkMemory(root)
  expect(rep).toContain("Битая ссылка в [[деплой-шлюза]]: [[Бэкап базы]] — возможно, имелась в виду [[бэкапы-базы]]")
  expect(rep).toContain("Похожие заметки: [[деплой-шлюза]] и [[деплой-шлюза-на-прод]]")
  expect(rep).toMatch(/Тег #(deploy|depoly) похож на #(deploy|depoly)/)
  expect(rep).toContain("Давно не обновлялись") && expect(rep).toContain("[[старое-решение]]")
  expect(rep).toContain("Похоже на секрет") && expect(rep).toContain("[[руками]]")
  expect(await checkMemory(await tmp())).toContain("Память пуста")
})

test("журнал дня дописывается, секреты не пишутся", async () => {
  const root = await tmp()
  await appendDaily(root, "Выложили шлюз")
  await appendDaily(root, "Настроили копию")
  const f = (await fs.readdir(path.join(root, "daily")))[0]
  const txt = await fs.readFile(path.join(root, "daily", f), "utf8")
  expect(txt.match(/^- \d\d:\d\d /gm)?.length).toBe(2)
  expect(await appendDaily(root, "токен: ghp_" + "a".repeat(36))).toContain("Не записано")
})

test("разговор для куратора: секреты скрыты, длинное режется, системные части и инструменты не мешают", () => {
  const msg = (role: string, text: string, extra: any[] = []) => ({ info: { role }, parts: [{ type: "text", text }, ...extra] })
  const out = buildTranscript([
    msg("user", "Мой ключ sk-abcdefghijklmnop12345 и password = hunter2hunter2, решили хранить в SQLite"),
    msg("assistant", "Ок, использую SQLite.", [{ type: "tool", tool: "bash" }, { type: "tool", tool: "bash" }, { type: "tool", tool: "edit" }]),
    { info: { role: "assistant" }, parts: [{ type: "text", text: "служебное", synthetic: true }] },
  ])
  expect(out).not.toContain("sk-abcdefghijklmnop12345")
  expect(out).not.toContain("hunter2hunter2")
  expect(out).toContain("[скрыто]") && expect(out).toContain("SQLite")
  expect(out).toContain("(инструменты: bash, edit)") && expect(out).not.toContain("служебное")
  const long = buildTranscript(Array.from({ length: 40 }, (_, i) => msg("user", `Реплика ${i} ` + "я".repeat(1400))), 5000)
  expect(long.length).toBeLessThan(5100) && expect(long).toContain("середина разговора пропущена") && expect(long).toContain("Реплика 39")
})
