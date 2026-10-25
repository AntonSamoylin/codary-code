// Группы чатов на главном экране: свои группы, закрепление, перенос чата в группу, новые чаты попадают в выбранную группу.
// Сделано по просьбам пользователей Claude Code, ChatGPT и Cursor (плоский список из сотен чатов; папки не переставляются сами по активности;
// достаточно одного уровня; можно разложить и уже существующие чаты). Состояние хранится в браузерном хранилище приложения (не синхронизируется между устройствами).
// Копируется в packages/app/src/components/ скриптом scripts/apply-patches.mjs.
import { createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"

type Group = { id: string; name: string }
type State = { groups: Group[]; assign: Record<string, string>; pinned: string[]; active: string; pending?: { group: string; known: string[]; ts: number } }
type Record_ = { session: { id: string; time: { created: number; updated?: number } } }
type SessionGroup = { id: string; title: string; sessions: Record_[] }

const KEY = "codary.chatGroups.v1"
const PINNED_ID = "codary-pinned"
const PENDING_TTL = 30 * 60 * 1000

function load(): State {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "")
    if (v && Array.isArray(v.groups)) return { groups: v.groups, assign: v.assign ?? {}, pinned: v.pinned ?? [], active: v.active ?? "all", pending: v.pending }
  } catch {}
  return { groups: [], assign: {}, pinned: [], active: "all" }
}

const [state, setState] = createSignal<State>(load())

function update(fn: (s: State) => State) {
  const next = fn(state())
  setState(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
}

const newId = () => "g" + Math.random().toString(36).slice(2, 8)
const groupName = (id: string | undefined) => state().groups.find((g) => g.id === id)?.name

const setActive = (active: string) => update((s) => ({ ...s, active }))
const moveSession = (sessionID: string, groupID: string | null) =>
  update((s) => {
    const assign = { ...s.assign }
    if (groupID) assign[sessionID] = groupID
    else delete assign[sessionID]
    return { ...s, assign }
  })
const togglePin = (sessionID: string) =>
  update((s) => ({ ...s, pinned: s.pinned.includes(sessionID) ? s.pinned.filter((id) => id !== sessionID) : [sessionID, ...s.pinned] }))
const addGroup = (name: string) => {
  const id = newId()
  update((s) => ({ ...s, groups: [...s.groups, { id, name: name.trim().slice(0, 40) }] }))
  return id
}
const renameGroup = (id: string, name: string) => update((s) => ({ ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, name: name.trim().slice(0, 40) || g.name } : g)) }))
const removeGroup = (id: string) =>
  update((s) => ({
    ...s,
    groups: s.groups.filter((g) => g.id !== id),
    assign: Object.fromEntries(Object.entries(s.assign).filter(([, g]) => g !== id)),
    active: s.active === id ? "all" : s.active,
  }))
const shiftGroup = (id: string, delta: number) =>
  update((s) => {
    const i = s.groups.findIndex((g) => g.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= s.groups.length) return s
    const groups = [...s.groups]
    ;[groups[i], groups[j]] = [groups[j], groups[i]]
    return { ...s, groups }
  })

/** Чаты выбранной группы; закреплённые поднимаются в отдельный блок наверху и не прыгают по активности. */
export function codaryFilter<T extends SessionGroup>(groups: T[]): T[] {
  const s = state()
  const keep = (r: Record_) => (s.active === "all" ? true : s.active === "none" ? !s.assign[r.session.id] : s.assign[r.session.id] === s.active)
  const visible = groups.map((g) => ({ ...g, sessions: g.sessions.filter(keep) })).filter((g) => g.sessions.length > 0)
  const byId = new Map(visible.flatMap((g) => g.sessions).map((r) => [r.session.id, r]))
  const pinned = s.pinned.map((id) => byId.get(id)).filter((r): r is Record_ => !!r)
  if (!pinned.length) return visible as T[]
  const rest = visible.map((g) => ({ ...g, sessions: g.sessions.filter((r) => !s.pinned.includes(r.session.id)) })).filter((g) => g.sessions.length > 0)
  return [{ id: PINNED_ID, title: "Закреплённые", sessions: pinned } as T, ...(rest as T[])]
}

/** Нажали «Новый чат» при выбранной группе: запоминаем, какие чаты уже были, и положим в группу первый новый. */
export function codaryNoteCreate(groups: SessionGroup[]) {
  const s = state()
  if (!s.groups.some((g) => g.id === s.active)) return update((x) => ({ ...x, pending: undefined }))
  update((x) => ({ ...x, pending: { group: s.active, known: groups.flatMap((g) => g.sessions.map((r) => r.session.id)), ts: Date.now() } }))
}

/** Вызывается при каждом обновлении списка: отдаёт самому свежему новому чату группу, выбранную в момент нажатия. */
export function codaryTrack(groups: SessionGroup[]) {
  const p = state().pending
  if (!p) return
  if (Date.now() - p.ts > PENDING_TTL) return update((s) => ({ ...s, pending: undefined }))
  const fresh = groups.flatMap((g) => g.sessions).filter((r) => !p.known.includes(r.session.id) && !state().assign[r.session.id])
  if (!fresh.length) return
  const newest = fresh.reduce((a, b) => (b.session.time.created > a.session.time.created ? b : a))
  update((s) => ({ ...s, assign: { ...s.assign, [newest.session.id]: p.group }, pending: undefined }))
}

const chip =
  "h-7 shrink-0 rounded-full border px-3 text-[13px] leading-none transition-[background-color,color] duration-150 ease-in-out focus-visible:outline-none"
const chipOff = `${chip} border-v2-border-border-muted text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base`
const chipOn = `${chip} border-v2-border-border-strong bg-v2-overlay-simple-overlay-hover text-v2-text-text-base`
const menuBox =
  "fixed z-[10000] flex min-w-[190px] max-w-[260px] flex-col rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-floating)]"
const menuItem =
  "h-8 w-full cursor-default truncate rounded-[6px] border-0 bg-transparent px-2.5 text-left text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"

function Menu(props: { anchor: HTMLElement; onClose: () => void; children: any; size: number }) {
  const rect = props.anchor.getBoundingClientRect()
  const height = props.size * 32 + 12
  const top = rect.bottom + height > window.innerHeight ? Math.max(8, rect.top - height) : rect.bottom + 4
  const left = Math.max(8, Math.min(rect.right - 190, window.innerWidth - 270))
  const close = () => props.onClose()
  const key = (e: KeyboardEvent) => e.key === "Escape" && close()
  // слушатели вешаем со следующего такта, иначе щелчок, открывший меню, сразу же его закроет
  const timer = setTimeout(() => {
    window.addEventListener("click", close)
    window.addEventListener("keydown", key)
  }, 0)
  onCleanup(() => {
    clearTimeout(timer)
    window.removeEventListener("click", close)
    window.removeEventListener("keydown", key)
  })
  return (
    <Portal>
      <div class={menuBox} style={{ top: `${top}px`, left: `${left}px` }} onClick={(e) => e.stopPropagation()}>
        {props.children}
      </div>
    </Portal>
  )
}

function NameInput(props: { initial: string; placeholder: string; onDone: (name: string | null) => void }) {
  let done = false
  const finish = (value: string | null) => {
    if (done) return
    done = true
    props.onDone(value)
  }
  return (
    <input
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      class="h-7 w-36 rounded-full border border-v2-border-border-strong bg-transparent px-3 text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
      value={props.initial}
      placeholder={props.placeholder}
      maxLength={40}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value.trim() || null)
        if (e.key === "Escape") finish(null)
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
    />
  )
}

/** Полоса групп над списком чатов: «Все · Без группы · свои группы · + Группа». */
export function CodaryGroupBar() {
  const [editing, setEditing] = createSignal<string | null>(null) // id группы, "new" или null
  const [menu, setMenu] = createSignal<HTMLElement | null>(null)
  const s = state
  return (
    <div class="flex flex-wrap items-center gap-2 pr-3 pt-3" data-component="codary-group-bar">
      <Show when={s().groups.length > 0}>
        <button type="button" class={s().active === "all" ? chipOn : chipOff} onClick={() => setActive("all")}>
          Все чаты
        </button>
        <button type="button" class={s().active === "none" ? chipOn : chipOff} onClick={() => setActive("none")}>
          Без группы
        </button>
      </Show>
      <For each={s().groups}>
        {(group, index) => (
          <Show
            when={editing() !== group.id}
            fallback={<NameInput initial={group.name} placeholder="Название" onDone={(name) => (name && renameGroup(group.id, name), setEditing(null))} />}
          >
            <div class="flex items-center">
              <button
                type="button"
                class={s().active === group.id ? chipOn : chipOff}
                onClick={(e) => (s().active === group.id ? setMenu(e.currentTarget) : setActive(group.id))}
                title={s().active === group.id ? "Нажмите ещё раз — переименовать, сдвинуть, удалить" : undefined}
              >
                {group.name}
                <Show when={s().active === group.id}>
                  <span class="ml-1.5 opacity-60">⋯</span>
                </Show>
              </button>
              <Show when={menu() && s().active === group.id}>
                <Menu anchor={menu()!} onClose={() => setMenu(null)} size={4}>
                  <button class={menuItem} onClick={() => (setMenu(null), setEditing(group.id))}>
                    Переименовать
                  </button>
                  <Show when={index() > 0}>
                    <button class={menuItem} onClick={() => (setMenu(null), shiftGroup(group.id, -1))}>
                      Сдвинуть влево
                    </button>
                  </Show>
                  <Show when={index() < s().groups.length - 1}>
                    <button class={menuItem} onClick={() => (setMenu(null), shiftGroup(group.id, 1))}>
                      Сдвинуть вправо
                    </button>
                  </Show>
                  <button
                    class={menuItem}
                    style={{ color: "#d33" }}
                    onClick={() => {
                      setMenu(null)
                      if (window.confirm(`Удалить группу «${group.name}»? Чаты останутся, но станут «Без группы».`)) removeGroup(group.id)
                    }}
                  >
                    Удалить группу
                  </button>
                </Menu>
              </Show>
            </div>
          </Show>
        )}
      </For>
      <Show
        when={editing() === "new"}
        fallback={
          <button type="button" class={chipOff} onClick={() => setEditing("new")}>
            + Группа
          </button>
        }
      >
        <NameInput
          initial=""
          placeholder="Название группы"
          onDone={(name) => {
            setEditing(null)
            if (name) setActive(addGroup(name))
          }}
        />
      </Show>
    </div>
  )
}

/** Значок закрепления и название группы в строке чата. */
export function CodaryRowBadge(props: { sessionID: string }) {
  const name = () => groupName(state().assign[props.sessionID])
  return (
    <>
      <Show when={state().pinned.includes(props.sessionID)}>
        <span class="shrink-0 text-[12px]" title="Закреплён">
          📌
        </span>
      </Show>
      <Show when={name() && state().active === "all"}>
        <span class="max-w-[110px] shrink-0 truncate rounded-full border border-v2-border-border-muted px-2 py-0.5 text-[11px] text-v2-text-text-faint">{name()}</span>
      </Show>
    </>
  )
}

/** Кнопка «⋯» у строки чата: закрепить, перенести в группу, создать группу. */
export function CodaryRowMenu(props: { sessionID: string }) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null)
  const [creating, setCreating] = createSignal(false)
  const current = () => state().assign[props.sessionID]
  const close = () => (setAnchor(null), setCreating(false))
  return (
    <div class="hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center group-hover/session:opacity-100 focus-within:opacity-100" classList={{ "opacity-100": !!anchor() }}>
      <button
        type="button"
        data-action="home-session-menu"
        class="flex size-7 items-center justify-center rounded-[6px] border-0 bg-transparent text-[16px] leading-none text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
        aria-label="Группа, закрепление"
        title="Группа, закрепление"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setAnchor(anchor() ? null : e.currentTarget)
        }}
      >
        ⋯
      </button>
      <Show when={anchor()}>
        <Menu anchor={anchor()!} onClose={close} size={state().groups.length + 4}>
          <button class={menuItem} onClick={() => (togglePin(props.sessionID), close())}>
            {state().pinned.includes(props.sessionID) ? "Открепить" : "Закрепить наверху"}
          </button>
          <div class="my-1 h-px bg-v2-border-border-muted" />
          <For each={state().groups}>
            {(group) => (
              <button class={menuItem} onClick={() => (moveSession(props.sessionID, group.id), close())}>
                {current() === group.id ? "✓ " : ""}
                {group.name}
              </button>
            )}
          </For>
          <Show when={current()}>
            <button class={menuItem} onClick={() => (moveSession(props.sessionID, null), close())}>
              Убрать из группы
            </button>
          </Show>
          <Show
            when={creating()}
            fallback={
              <button class={menuItem} onClick={() => setCreating(true)}>
                + Новая группа…
              </button>
            }
          >
            <div class="p-1">
              <NameInput
                initial=""
                placeholder="Название группы"
                onDone={(name) => {
                  if (name) moveSession(props.sessionID, addGroup(name))
                  close()
                }}
              />
            </div>
          </Show>
        </Menu>
      </Show>
    </div>
  )
}

/** Пустая выдача: в выбранной группе ещё нет чатов. */
export function CodaryEmptyGroup() {
  return (
    <div class="pl-3 pr-3 pt-6 text-[14px] text-v2-text-text-muted">
      В этой группе пока нет чатов. Нажмите «⋯» у любого чата и выберите группу — или создайте чат при выбранной группе, он попадёт сюда сам.
    </div>
  )
}
