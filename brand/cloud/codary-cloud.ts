// Облачная среда Codary Code (патч Codary). Рядом с сервером OpenCode на том же адресе стоит менеджер среды,
// он отвечает на /_cloud/info и /_cloud/mkdir. Вне облака этих адресов нет: тогда всё работает как в обычном OpenCode.

export type CloudInfo = { workspace: string; project: string | null }

let cached: Promise<CloudInfo | undefined> | undefined

// Есть ли рядом облачный менеджер; ответ запоминается на всё время работы страницы.
export function cloudInfo() {
  cached ??= fetch("/_cloud/info", { credentials: "same-origin" })
    .then((response) => (response.ok && (response.headers.get("content-type") ?? "").includes("json") ? response.json() : undefined))
    .then((data) =>
      data && data.cloud === true && typeof data.workspace === "string"
        ? ({ workspace: data.workspace, project: typeof data.project === "string" ? data.project : null } as CloudInfo)
        : undefined,
    )
    .catch(() => undefined)
  return cached
}

// Те же правила, что у менеджера: имя одной папки без слэшей, не длиннее 64 знаков.
export function cloudFolderOk(name: string) {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,63}$/u.test(name) && !name.includes("..") && !/[ .]$/.test(name)
}

export function cloudMkdir(name: string): Promise<{ path?: string; error?: string }> {
  return fetch("/_cloud/mkdir", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}))
      return response.ok && typeof data.path === "string" ? { path: data.path as string } : { error: String(data.error ?? "mkdir") }
    })
    .catch(() => ({ error: "network" }))
}
