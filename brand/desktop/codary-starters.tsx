// Стартовые подсказки на пустом экране нового сеанса: частые задачи одним щелчком (вставляют команду в строку запроса).
// Копируется в packages/app/src/components/ скриптом scripts/apply-patches.mjs.
import { For, Show } from "solid-js"
import { usePrompt } from "@/context/prompt"

const STARTERS = [
  { label: "Объяснить проект", text: "/explain " },
  { label: "Найти и исправить ошибки", text: "/fix " },
  { label: "Написать тесты", text: "/tests " },
  { label: "Проверить изменения", text: "/review " },
  { label: "Создать AGENTS.md", text: "/agents " },
]

export function CodaryStarters(props: { onDone?: () => void }) {
  const prompt = usePrompt()
  return (
    <Show when={prompt.ready() && !prompt.dirty()}>
      <div class="flex flex-wrap items-center justify-center gap-2" data-component="codary-starters">
        <For each={STARTERS}>
          {(item) => (
            <button
              type="button"
              class="h-7 rounded-full border border-v2-border-border-muted px-3 text-[13px] leading-none text-v2-text-text-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
              onClick={() => {
                prompt.set([{ type: "text", content: item.text, start: 0, end: item.text.length }], item.text.length)
                props.onDone?.()
              }}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
