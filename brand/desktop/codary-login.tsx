// Экран входа и плашка аккаунта Codary Code (патч Codary).
// Пока в приложении нет аккаунта, вместо интерфейса показывается экран входа; после входа поверх интерфейса — плашка с балансом,
// «Пополнить» и меню («Мои устройства», «Выйти»). Состояние ведёт главный процесс (codary-auth.ts); здесь только показ и кнопки.
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Mark } from "@opencode-ai/ui/logo"

import type { CodaryAuthState } from "../preload/types"

const card: JSX.CSSProperties = {
  width: "min(440px, calc(100vw - 48px))",
  padding: "32px 28px",
  "border-radius": "16px",
  border: "1px solid var(--border-weak-base, rgba(127,127,127,.25))",
  background: "var(--surface-raised-base, var(--background-base))",
  "text-align": "center",
  display: "flex",
  "flex-direction": "column",
  gap: "14px",
  "align-items": "center",
}
const primary: JSX.CSSProperties = {
  padding: "11px 22px",
  "border-radius": "10px",
  border: "0",
  cursor: "pointer",
  "font-size": "15px",
  "font-weight": "600",
  background: "var(--text-strong, #111)",
  color: "var(--background-base, #fff)",
}
const link: JSX.CSSProperties = { background: "none", border: "0", cursor: "pointer", "font-size": "13px", color: "var(--text-weak, #888)", "text-decoration": "underline" }
const font = "var(--font-family-sans, system-ui, sans-serif)"

const rub = (value: number) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + " ₽"
const AMOUNTS = [200, 500, 1000, 2000]
const LOW_BALANCE = 20

function LoginScreen(props: { state: CodaryAuthState }) {
  const api = window.api.codaryAuth
  const waiting = () => props.state.state === "waiting"
  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "var(--background-base, #fff)",
        color: "var(--text-base, #222)",
        "font-family": font,
        "-webkit-app-region": "drag",
      }}
    >
      <div style={{ ...card, "-webkit-app-region": "no-drag" }}>
        <Mark class="size-14" />
        <div style={{ "font-size": "22px", "font-weight": "700", color: "var(--text-strong, #111)" }}>Codary Code</div>
        <Show
          when={waiting()}
          fallback={
            <>
              <div style={{ "font-size": "15px", "line-height": "1.45" }}>Войдите в свой аккаунт Codary. Модели и оплата подключаются через него: ключи нейросетей вводить не нужно.</div>
              <Show when={props.state.message}>
                <div style={{ "font-size": "13px", color: "var(--text-critical-base, #d33)" }}>{props.state.message}</div>
              </Show>
              <button style={primary} onClick={() => void api.login()}>
                Войти через codary.ru
              </button>
            </>
          }
        >
          <div style={{ "font-size": "15px", "line-height": "1.45" }}>Подтвердите вход в открывшемся окне браузера. На странице должен быть такой же код:</div>
          <div style={{ "font-size": "36px", "font-weight": "700", "letter-spacing": "0.18em", color: "var(--text-strong, #111)" }}>{props.state.code}</div>
          <div style={{ "font-size": "13px", color: "var(--text-weak, #888)" }}>Если кода нет или он другой, нажмите «Отмена» на сайте. После подтверждения вход завершится сам.</div>
          <div style={{ display: "flex", gap: "18px" }}>
            <button style={link} onClick={() => void api.login()}>
              Открыть страницу ещё раз
            </button>
            <button style={link} onClick={() => void api.cancel()}>
              Отмена
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}

function PayDialog(props: { onClose: () => void }) {
  const [amount, setAmount] = createSignal(500)
  const [custom, setCustom] = createSignal("")
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const value = () => (custom().trim() ? Number(custom().replace(",", ".")) : amount())
  const go = async () => {
    setError("")
    const sum = value()
    if (!Number.isFinite(sum) || sum < 200 || sum > 50_000) return setError("Сумма пополнения: от 200 до 50 000 ₽.")
    setBusy(true)
    const result = await window.api.codaryAuth.pay(sum)
    setBusy(false)
    if (result.ok) props.onClose()
    else setError(result.error ?? "Не удалось открыть оплату.")
  }
  return (
    <div
      style={{ position: "fixed", inset: "0", "z-index": "10001", background: "rgba(0,0,0,.45)", display: "flex", "align-items": "center", "justify-content": "center", "font-family": font }}
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div style={{ ...card, "text-align": "left", "align-items": "stretch", color: "var(--text-base, #222)" }}>
        <div style={{ "font-size": "18px", "font-weight": "700", color: "var(--text-strong, #111)" }}>Пополнить баланс</div>
        <div style={{ "font-size": "13px", color: "var(--text-weak, #888)" }}>Оплата картой на странице банка. Деньги зачисляются в течение минуты, расход идёт по факту использования моделей.</div>
        <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "8px" }}>
          <For each={AMOUNTS}>
            {(sum) => (
              <button
                style={{
                  padding: "10px 0",
                  "border-radius": "10px",
                  cursor: "pointer",
                  "font-size": "14px",
                  "font-weight": "600",
                  border: "1px solid var(--border-weak-base, rgba(127,127,127,.35))",
                  background: !custom().trim() && amount() === sum ? "var(--text-strong, #111)" : "transparent",
                  color: !custom().trim() && amount() === sum ? "var(--background-base, #fff)" : "var(--text-strong, #111)",
                }}
                onClick={() => {
                  setCustom("")
                  setAmount(sum)
                }}
              >
                {sum} ₽
              </button>
            )}
          </For>
        </div>
        <input
          placeholder="Другая сумма, от 200 до 50 000 ₽"
          value={custom()}
          onInput={(event) => setCustom(event.currentTarget.value)}
          style={{ padding: "10px 12px", "border-radius": "10px", border: "1px solid var(--border-weak-base, rgba(127,127,127,.35))", background: "transparent", color: "inherit", "font-size": "14px" }}
        />
        <Show when={error()}>
          <div style={{ "font-size": "13px", color: "var(--text-critical-base, #d33)" }}>{error()}</div>
        </Show>
        <div style={{ display: "flex", gap: "10px", "justify-content": "flex-end" }}>
          <button style={link} onClick={props.onClose}>
            Отмена
          </button>
          <button style={{ ...primary, opacity: busy() ? 0.6 : 1 }} disabled={busy()} onClick={() => void go()}>
            Перейти к оплате
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountPill(props: { state: CodaryAuthState }) {
  const api = window.api.codaryAuth
  const [pay, setPay] = createSignal(false)
  const [menu, setMenu] = createSignal(false)
  const account = () => props.state.account
  const kind = (): "ok" | "low" | "empty" | "blocked" => {
    const current = account()
    if (!current) return "ok"
    if (current.status === "blocked") return "blocked"
    if (current.status === "pending") return "empty"
    if (current.balanceRub <= 0) return "empty"
    return current.balanceRub < LOW_BALANCE ? "low" : "ok"
  }
  const colors = { ok: "var(--text-base, #222)", low: "#d97706", empty: "#d97706", blocked: "var(--text-critical-base, #d33)" }
  const text = () => {
    const current = account()
    switch (kind()) {
      case "blocked":
        return "Доступ отключён. Напишите на info@codary.ru"
      case "empty":
        return current?.status === "pending" ? "Пополните баланс, чтобы начать" : "Баланс исчерпан — пополните, чтобы продолжить"
      case "low":
        return `Мало средств: ${rub(current?.balanceRub ?? 0)}${current?.left ? ` (≈ ${current.left} запросов)` : ""}`
      default:
        return current ? rub(current.balanceRub) : "Codary"
    }
  }
  // Подсказка по наведению: куда уходят деньги и на сколько хватит (главная жалоба пользователей Claude Code и Codex — непонятный расход)
  const details = () => {
    const current = account()
    if (!current) return ""
    const parts = [`Остаток: ${rub(current.balanceRub)}`]
    if (current.todayRub) parts.push(`Сегодня потрачено: ${rub(current.todayRub)}`)
    if (current.avgRub) parts.push(`Средний запрос: ${rub(current.avgRub)}`)
    if (current.left) parts.push(`Хватит примерно на ${current.left} запросов`)
    return parts.join("\n")
  }
  onMount(() => {
    const close = () => setMenu(false)
    window.addEventListener("click", close)
    onCleanup(() => window.removeEventListener("click", close))
  })
  return (
    <>
      <div
        style={{
          position: "fixed",
          right: "12px",
          bottom: "12px",
          "z-index": "10000",
          display: "flex",
          "align-items": "center",
          gap: "8px",
          padding: "6px 8px 6px 12px",
          "border-radius": "999px",
          "font-family": font,
          "font-size": "12.5px",
          "font-weight": "600",
          background: "var(--surface-raised-base, var(--background-base))",
          border: `1px solid ${kind() === "ok" ? "var(--border-weak-base, rgba(127,127,127,.3))" : colors[kind()]}`,
          color: colors[kind()],
          "box-shadow": "0 2px 10px rgba(0,0,0,.12)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <span title={details()}>{text()}</span>
        <Show when={kind() === "ok" && (account()?.todayRub ?? 0) > 0}>
          <span style={{ "font-weight": "400", color: "var(--text-weak, #888)" }} title={details()}>
            · сегодня −{rub(account()?.todayRub ?? 0)}
          </span>
        </Show>
        <Show when={kind() !== "blocked"}>
          <button
            style={{ padding: "4px 10px", "border-radius": "999px", border: "0", cursor: "pointer", "font-size": "12px", "font-weight": "700", background: "var(--text-strong, #111)", color: "var(--background-base, #fff)" }}
            onClick={() => setPay(true)}
          >
            Пополнить
          </button>
        </Show>
        <button style={{ ...link, "text-decoration": "none", "font-size": "16px", padding: "0 4px" }} title="Аккаунт" onClick={() => setMenu(!menu())}>
          ⋯
        </button>
        <Show when={menu()}>
          <div
            style={{
              position: "absolute",
              right: "0",
              bottom: "calc(100% + 8px)",
              "min-width": "190px",
              padding: "6px",
              "border-radius": "12px",
              background: "var(--surface-raised-base, var(--background-base))",
              border: "1px solid var(--border-weak-base, rgba(127,127,127,.3))",
              "box-shadow": "0 6px 24px rgba(0,0,0,.18)",
              display: "flex",
              "flex-direction": "column",
            }}
          >
            <button style={{ ...link, "text-decoration": "none", "text-align": "left", padding: "8px 10px", "font-size": "13px", color: "var(--text-base, #222)" }} onClick={() => void api.devices()}>
              Мои устройства
            </button>
            <button style={{ ...link, "text-decoration": "none", "text-align": "left", padding: "8px 10px", "font-size": "13px", color: "var(--text-base, #222)" }} onClick={() => void api.logout()}>
              Выйти из аккаунта
            </button>
          </div>
        </Show>
      </div>
      <Show when={pay()}>
        <PayDialog onClose={() => setPay(false)} />
      </Show>
    </>
  )
}

export function CodaryLoginGate(props: { children: JSX.Element }) {
  const [state, setState] = createSignal<CodaryAuthState>()
  onMount(() => {
    void window.api.codaryAuth.status().then(setState)
    onCleanup(window.api.codaryAuth.onChange(setState))
  })
  return (
    <Show when={state()}>
      {(current) => (
        <Show when={!current().enabled || current().state === "in"} fallback={<LoginScreen state={current()} />}>
          {props.children}
          <Show when={current().enabled}>
            <AccountPill state={current()} />
          </Show>
        </Show>
      )}
    </Show>
  )
}
