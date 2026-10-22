// Расчёт ближайшего запуска. Время — по часам компьютера пользователя.
import type { Schedule } from "./store"

export const MIN_INTERVAL_MINUTES = 5

export function validateSpec(s: Pick<Schedule, "everyMinutes" | "dailyAt" | "weekdays">): string | undefined {
  const hasEvery = s.everyMinutes !== undefined
  const hasDaily = s.dailyAt !== undefined
  if (hasEvery === hasDaily) return "Укажите ровно одно: every_minutes (повтор через N минут) или daily_at (время HH:MM)."
  if (hasEvery && (!Number.isFinite(s.everyMinutes) || s.everyMinutes! < MIN_INTERVAL_MINUTES))
    return `Минимальный интервал — ${MIN_INTERVAL_MINUTES} минут.`
  if (hasDaily && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s.dailyAt!)) return "Время daily_at должно быть в формате HH:MM, например 09:30."
  if (s.weekdays && (s.weekdays.length === 0 || s.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)))
    return "weekdays — числа от 1 (понедельник) до 7 (воскресенье)."
  if (s.weekdays && !hasDaily) return "weekdays можно указывать только вместе с daily_at."
}

/** Следующее время запуска строго после `from` (мс). */
export function nextRunAfter(s: Pick<Schedule, "everyMinutes" | "dailyAt" | "weekdays">, from: number): number {
  if (s.everyMinutes !== undefined) return from + s.everyMinutes * 60_000
  const [h, m] = s.dailyAt!.split(":").map(Number)
  const days = s.weekdays?.length ? new Set(s.weekdays) : undefined
  const base = new Date(from)
  for (let i = 0; i < 9; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0)
    const iso = d.getDay() === 0 ? 7 : d.getDay()
    if (d.getTime() > from && (!days || days.has(iso))) return d.getTime()
  }
  return from + 24 * 3_600_000
}

const WEEKDAYS = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"]

export function describe(s: Pick<Schedule, "everyMinutes" | "dailyAt" | "weekdays">): string {
  if (s.everyMinutes !== undefined) return `каждые ${s.everyMinutes} мин`
  const days = s.weekdays?.length ? ` (${[...s.weekdays].sort().map((d) => WEEKDAYS[d]).join(", ")})` : " (каждый день)"
  return `в ${s.dailyAt}${days}`
}

export function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
