// Экран входа в Codary Code (патч Codary): пока в приложении нет аккаунта, вместо интерфейса показывается он.
// Состояние ведёт главный процесс (codary-auth.ts); здесь только показ и три кнопки.
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
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
        "font-family": "var(--font-family-sans, system-ui, sans-serif)",
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
        </Show>
      )}
    </Show>
  )
}
